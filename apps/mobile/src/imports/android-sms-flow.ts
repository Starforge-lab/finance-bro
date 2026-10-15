import type { SmsReaderModule } from '../../modules/sms-reader';
import type { DataLayer } from '../db/service';
import type { SmsOriginalReader, SmsReviewPreparation } from './sms';
import {
  AndroidSmsCatchupError,
  catchUpAndroidSms,
  type AndroidSmsCatchupResult,
  type AndroidSmsCatchupErrorCode,
  type AndroidSmsReader,
} from './android-sms-catchup';

type CatchupReader = Pick<SmsReaderModule, 'getPermissionsAsync' | 'getImportSettingsAsync' | 'queryInboxAsync'>;
type CatchupStorage = Pick<DataLayer, 'getSmsImportCursor' | 'importSmsBatch'>;
type SettingsReader = Pick<SmsReaderModule, 'setImportSettingsAsync'>;
type ReconcileReader = SettingsReader & Pick<SmsReaderModule, 'getPermissionsAsync' | 'getImportSettingsAsync'>;
export type AndroidSmsBackgroundScheduler = { register(): Promise<void>; unregister(): Promise<void> };

let settingsWriteQueue = Promise.resolve();

export class AndroidSmsBackgroundUnavailableError extends Error {
  constructor(readonly reason: 'registration' | 'registration_rollback' | 'unregistration') {
    super('Android SMS background scheduling is unavailable.');
    this.name = 'AndroidSmsBackgroundUnavailableError';
  }
}

/** Keep consent writes and their task lifecycle effects ordered across panel unmounts. */
function queueAndroidSmsSettingsOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  const pending = settingsWriteQueue.then(operation, operation);
  settingsWriteQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function registerAndroidSmsTaskOrDisable(
  reader: SettingsReader,
  scheduler: AndroidSmsBackgroundScheduler,
): Promise<void> {
  try {
    await scheduler.register();
  } catch {
    let disabled = false;
    try {
      disabled = (await reader.setImportSettingsAsync({ enabled: false })).enabled === false;
    } catch {}
    try {
      await scheduler.unregister();
    } catch {}
    throw new AndroidSmsBackgroundUnavailableError(disabled ? 'registration' : 'registration_rollback');
  }
}

/** Reconcile a persisted opt-in and task state after launch or an interrupted setting update. */
export function reconcileAndroidSmsImportSettings(
  reader: ReconcileReader,
  scheduler: AndroidSmsBackgroundScheduler,
): Promise<void> {
  return queueAndroidSmsSettingsOperation(async () => {
    let settings;
    try {
      settings = await reader.getImportSettingsAsync();
    } catch {
      try { await scheduler.unregister(); } catch {}
      throw new AndroidSmsCatchupError('permission_unavailable');
    }
    if (settings.enabled !== true) {
      try {
        await scheduler.unregister();
      } catch {
        throw new AndroidSmsBackgroundUnavailableError('unregistration');
      }
      return;
    }
    if (!Number.isSafeInteger(settings.startDateMs) || settings.startDateMs === null ||
        settings.startDateMs <= 0 || settings.startDateMs > Date.now()) {
      try { await reader.setImportSettingsAsync({ enabled: false }); } catch {}
      try { await scheduler.unregister(); } catch {}
      throw new AndroidSmsCatchupError('invalid_consent');
    }

    let permissions;
    try {
      permissions = await reader.getPermissionsAsync();
    } catch {
      try { await scheduler.unregister(); } catch {}
      throw new AndroidSmsCatchupError('permission_unavailable');
    }
    if (!permissions || permissions.granted !== true || permissions.readSms !== true || permissions.receiveSms !== true) {
      try {
        await scheduler.unregister();
      } catch {
        throw new AndroidSmsBackgroundUnavailableError('unregistration');
      }
      throw new AndroidSmsCatchupError('permission_denied');
    }
    await registerAndroidSmsTaskOrDisable(reader, scheduler);
  });
}

/** Keep user setting changes ordered across panel unmounts and in-flight native writes. */
export function setAndroidSmsImportSettings(
  reader: SettingsReader,
  update: Parameters<SmsReaderModule['setImportSettingsAsync']>[0],
  scheduler: AndroidSmsBackgroundScheduler,
): ReturnType<SmsReaderModule['setImportSettingsAsync']> {
  return queueAndroidSmsSettingsOperation(async () => {
    const saved = await reader.setImportSettingsAsync(update);
    if (update.enabled) {
      if (saved.enabled !== true) throw new AndroidSmsCatchupError('invalid_consent');
      await registerAndroidSmsTaskOrDisable(reader, scheduler);
    } else {
      if (saved.enabled !== false) throw new AndroidSmsCatchupError('invalid_consent');
      try {
        await scheduler.unregister();
      } catch {
        throw new AndroidSmsBackgroundUnavailableError('unregistration');
      }
    }
    return saved;
  });
}

export type AndroidSmsReviewSelection = {
  referenceId: string;
  platformId: string;
  receivedAt: number;
  expectedPreparation: Extract<SmsReviewPreparation, { kind: 'ready' }>;
};

export type AndroidSmsPreviewPhase = 'permission' | 'source' | null;

/** Let a user-started Android permission prompt finish, but stop preview work when hidden. */
export function shouldAbortAndroidSmsPreviewOnHide(phase: AndroidSmsPreviewPhase): boolean {
  return phase !== 'permission';
}

export function createAndroidSmsOperationGeneration() {
  let generation = 0;
  return {
    next: () => ++generation,
    isCurrent: (value: number) => value === generation,
  };
}

export function createAndroidSmsOriginalReader(
  reader: Pick<SmsReaderModule, 'readInboxMessageAsync'>,
): SmsOriginalReader {
  return async (platformId) => {
    const original = await reader.readInboxMessageAsync(platformId);
    return original ? {
      platformId: original.id,
      receivedAt: original.dateMs,
      sender: original.sender,
      body: original.body,
    } : null;
  };
}

let activeCatchup: { controller: AbortController; promise: Promise<AndroidSmsCatchupResult> } | undefined;
export type AndroidSmsCatchupFailure = AndroidSmsCatchupErrorCode | 'background_unavailable' | 'unexpected';

let lastFailure: AndroidSmsCatchupFailure | null = null;
const failureListeners = new Set<() => void>();

function updateFailure(value: AndroidSmsCatchupFailure | null): void {
  if (lastFailure === value) return;
  lastFailure = value;
  failureListeners.forEach((listener) => listener());
}

export function getAndroidSmsCatchupFailure(): AndroidSmsCatchupFailure | null {
  return lastFailure;
}

export function clearAndroidSmsCatchupFailure(): void {
  updateFailure(null);
}

export function subscribeAndroidSmsCatchupFailure(listener: () => void): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

export function recordAndroidSmsCatchupFailure(error: unknown): void {
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') return;
  updateFailure(error instanceof AndroidSmsBackgroundUnavailableError
    ? 'background_unavailable'
    : error instanceof AndroidSmsCatchupError ? error.code : 'unexpected');
}

export function abortAndroidSmsCatchup(): void {
  activeCatchup?.controller.abort();
}

export function runEnabledAndroidSmsCatchup(
  reader: CatchupReader,
  storage: CatchupStorage,
  startDateMs: number,
  endDateMs: number,
): Promise<AndroidSmsCatchupResult> {
  if (activeCatchup) return activeCatchup.promise;

  const controller = new AbortController();
  const guardedReader: AndroidSmsReader = {
    async getPermissionsAsync() {
      const [permissions, settings] = await Promise.all([
        reader.getPermissionsAsync(),
        reader.getImportSettingsAsync(),
      ]);
      if (settings.enabled !== true || settings.startDateMs !== startDateMs) {
        return { readSms: false, receiveSms: false, granted: false };
      }
      return permissions;
    },
    queryInboxAsync: (options) => reader.queryInboxAsync(options),
  };
  updateFailure(null);
  const promise = catchUpAndroidSms({
    reader: guardedReader,
    storage,
    startDateMs,
    endDateMs,
    signal: controller.signal,
    clock: Date.now,
  }).catch((error: unknown) => {
    recordAndroidSmsCatchupFailure(error);
    throw error;
  });
  void promise.then(() => updateFailure(null), () => {});
  activeCatchup = { controller, promise };
  void promise.finally(() => {
    if (activeCatchup?.promise === promise) activeCatchup = undefined;
  }).catch(() => {});
  return promise;
}
