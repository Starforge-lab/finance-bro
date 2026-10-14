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

let settingsWriteQueue = Promise.resolve();

/** Keep user setting changes ordered across panel unmounts and in-flight native writes. */
export function setAndroidSmsImportSettings(
  reader: SettingsReader,
  update: Parameters<SmsReaderModule['setImportSettingsAsync']>[0],
): ReturnType<SmsReaderModule['setImportSettingsAsync']> {
  const write = () => reader.setImportSettingsAsync(update);
  const pending = settingsWriteQueue.then(write, write);
  settingsWriteQueue = pending.then(() => undefined, () => undefined);
  return pending;
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
let lastFailure: AndroidSmsCatchupErrorCode | 'unexpected' | null = null;
const failureListeners = new Set<() => void>();

function updateFailure(value: AndroidSmsCatchupErrorCode | 'unexpected' | null): void {
  if (lastFailure === value) return;
  lastFailure = value;
  failureListeners.forEach((listener) => listener());
}

export function getAndroidSmsCatchupFailure(): AndroidSmsCatchupErrorCode | 'unexpected' | null {
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
  updateFailure(error instanceof AndroidSmsCatchupError ? error.code : 'unexpected');
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
