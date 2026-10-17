import type { SmsImportSettings, SmsPermissionState, SmsReaderModule } from '../../modules/sms-reader';
import type { DataLayer } from '../db/service';
import { AndroidSmsCatchupError, type AndroidSmsCatchupErrorCode } from './android-sms-catchup';
import {
  abortAndroidSmsCatchup,
  persistAndroidSmsCaptureFailure,
  recordAndroidSmsCatchupFailure,
  runEnabledAndroidSmsCatchup,
} from './android-sms-flow';

export type AndroidSmsBackgroundTaskOutcome = 'success' | 'failed';

const backgroundBudgetMs = 7 * 60 * 1_000;
const wakeDeadlineKey = 'deadlineElapsedRealtimeMs';

/** Accept only the body's single body-free monotonic wake deadline field. */
export function readAndroidSmsWakeDeadline(data: unknown): number | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const keys = Reflect.ownKeys(data);
  if (keys.length !== 1 || keys[0] !== wakeDeadlineKey) return null;
  const descriptor = Object.getOwnPropertyDescriptor(data, wakeDeadlineKey);
  const value = descriptor && 'value' in descriptor ? descriptor.value : null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Check consent and permissions before opening storage, within the native worker's callback budget. */
export async function runAndroidSmsBackgroundTask(
  platform: string,
  getReader: () => SmsReaderModule | null,
  getLedger: () => Promise<DataLayer>,
  taskError: unknown | null = null,
  timing?: { deadlineElapsedRealtimeMs: unknown },
): Promise<AndroidSmsBackgroundTaskOutcome> {
  let timedOut = false;
  let catchupJoined = false;
  let preflightHealthStarted = false;
  let reader: SmsReaderModule | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let resolveTimeout!: (outcome: AndroidSmsBackgroundTaskOutcome) => void;
  const timeout = new Promise<AndroidSmsBackgroundTaskOutcome>((resolve) => { resolveTimeout = resolve; });
  const persistPreflightFailure = async (error: unknown, onTimeout = false): Promise<void> => {
    if (!reader || (catchupJoined && !onTimeout) || preflightHealthStarted) return;
    preflightHealthStarted = true;
    try {
      await persistAndroidSmsCaptureFailure(reader, error);
    } catch {
      // The background timeout must remain bounded even when native health storage is unavailable.
    }
  };
  const fail = async (code: AndroidSmsCatchupErrorCode): Promise<AndroidSmsBackgroundTaskOutcome> => {
    const error = new AndroidSmsCatchupError(timedOut ? 'time_budget_exceeded' : code);
    recordAndroidSmsCatchupFailure(error);
    await persistPreflightFailure(error);
    return 'failed';
  };
  const assertWithinBudget = () => {
    if (timedOut) throw new AndroidSmsCatchupError('time_budget_exceeded');
  };

  const expire = () => {
    timedOut = true;
    const error = new AndroidSmsCatchupError('time_budget_exceeded');
    if (catchupJoined) abortAndroidSmsCatchup();
    recordAndroidSmsCatchupFailure(error);
    void persistPreflightFailure(error, true).catch(() => {});
    resolveTimeout('failed');
  };
  const setBudgetTimer = (budgetMs: number) => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(expire, budgetMs);
  };
  setBudgetTimer(backgroundBudgetMs);

  const task = (async (): Promise<AndroidSmsBackgroundTaskOutcome> => {
    if (platform !== 'android') return 'success';
    if (taskError !== null) {
      recordAndroidSmsCatchupFailure(taskError);
      try {
        reader = getReader();
      } catch {
        return 'failed';
      }
      if (reader) await persistPreflightFailure(taskError);
      return 'failed';
    }
    if (timing && (!Number.isSafeInteger(timing.deadlineElapsedRealtimeMs) ||
        (timing.deadlineElapsedRealtimeMs as number) <= 0)) {
      return fail('time_budget_exceeded');
    }

    try {
      reader = getReader();
    } catch {
      return fail('source_unavailable');
    }
    if (!reader) return fail('source_unavailable');

    if (timing) {
      const requestStartedAt = performance.now();
      let elapsedRealtimeMs: number;
      try {
        elapsedRealtimeMs = await reader.getElapsedRealtimeAsync();
        assertWithinBudget();
      } catch {
        return fail('time_budget_exceeded');
      }
      const bridgeRoundTripMs = performance.now() - requestStartedAt;
      const deadlineElapsedRealtimeMs = timing.deadlineElapsedRealtimeMs as number;
      const nativeRemainingBudgetMs = deadlineElapsedRealtimeMs - elapsedRealtimeMs;
      const remainingBudgetMs = nativeRemainingBudgetMs - bridgeRoundTripMs;
      if (!Number.isSafeInteger(elapsedRealtimeMs) || elapsedRealtimeMs < 0 ||
          !Number.isFinite(bridgeRoundTripMs) || bridgeRoundTripMs < 0 ||
          nativeRemainingBudgetMs <= 0 || nativeRemainingBudgetMs > backgroundBudgetMs || remainingBudgetMs < 1) {
        return fail('time_budget_exceeded');
      }
      setBudgetTimer(Math.min(remainingBudgetMs, backgroundBudgetMs));
    }

    let settings: SmsImportSettings;
    try {
      settings = await reader.getImportSettingsAsync();
      assertWithinBudget();
    } catch {
      return fail('permission_unavailable');
    }
    if (settings.enabled !== true) return 'success';
    const startDateMs = settings.startDateMs;
    if (startDateMs === null || !Number.isSafeInteger(startDateMs) ||
        startDateMs <= 0 || startDateMs > Date.now()) {
      return fail('invalid_consent');
    }

    let permissions: SmsPermissionState;
    try {
      permissions = await reader.getPermissionsAsync();
      assertWithinBudget();
    } catch {
      return fail('permission_unavailable');
    }
    if (!permissions || permissions.granted !== true || permissions.readSms !== true || permissions.receiveSms !== true) {
      return fail('permission_denied');
    }

    let ledger: DataLayer;
    try {
      ledger = await getLedger();
      assertWithinBudget();
    } catch {
      return fail('storage_unavailable');
    }

    catchupJoined = true;
    try {
      await runEnabledAndroidSmsCatchup(reader, ledger, startDateMs, Date.now());
      assertWithinBudget();
      return 'success';
    } catch (error) {
      if (timedOut) return 'failed';
      recordAndroidSmsCatchupFailure(error);
      return 'failed';
    }
  })();

  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
