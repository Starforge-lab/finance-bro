import type { SmsImportSettings, SmsPermissionState, SmsReaderModule } from '../../modules/sms-reader';
import type { DataLayer } from '../db/service';
import { AndroidSmsCatchupError, type AndroidSmsCatchupErrorCode } from './android-sms-catchup';
import {
  abortAndroidSmsCatchup,
  recordAndroidSmsCatchupFailure,
  runEnabledAndroidSmsCatchup,
} from './android-sms-flow';

export type AndroidSmsBackgroundTaskOutcome = 'success' | 'failed';

const backgroundBudgetMs = 7 * 60 * 1_000;

/** Check consent and permissions before opening storage, within the native worker's callback budget. */
export async function runAndroidSmsBackgroundTask(
  platform: string,
  getReader: () => SmsReaderModule | null,
  getLedger: () => Promise<DataLayer>,
  taskError: unknown | null = null,
): Promise<AndroidSmsBackgroundTaskOutcome> {
  let timedOut = false;
  let catchupJoined = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let resolveTimeout!: (outcome: AndroidSmsBackgroundTaskOutcome) => void;
  const timeout = new Promise<AndroidSmsBackgroundTaskOutcome>((resolve) => { resolveTimeout = resolve; });
  const fail = (code: AndroidSmsCatchupErrorCode): AndroidSmsBackgroundTaskOutcome => {
    recordAndroidSmsCatchupFailure(new AndroidSmsCatchupError(timedOut ? 'time_budget_exceeded' : code));
    return 'failed';
  };
  const assertWithinBudget = () => {
    if (timedOut) throw new AndroidSmsCatchupError('time_budget_exceeded');
  };

  timeoutHandle = setTimeout(() => {
    timedOut = true;
    if (catchupJoined) abortAndroidSmsCatchup();
    recordAndroidSmsCatchupFailure(new AndroidSmsCatchupError('time_budget_exceeded'));
    resolveTimeout('failed');
  }, backgroundBudgetMs);

  const task = (async (): Promise<AndroidSmsBackgroundTaskOutcome> => {
    if (platform !== 'android') return 'success';
    if (taskError !== null) {
      recordAndroidSmsCatchupFailure(taskError);
      return 'failed';
    }

    let reader: SmsReaderModule | null;
    try {
      reader = getReader();
    } catch {
      return fail('source_unavailable');
    }
    if (!reader) return fail('source_unavailable');

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

    try {
      const ledger = await getLedger();
      assertWithinBudget();
      catchupJoined = true;
      await runEnabledAndroidSmsCatchup(reader, ledger, startDateMs, Date.now());
      assertWithinBudget();
      return 'success';
    } catch (error) {
      if (timedOut) return fail('time_budget_exceeded');
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
