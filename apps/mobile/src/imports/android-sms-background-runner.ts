import type { SmsImportSettings, SmsPermissionState, SmsReaderModule } from '../../modules/sms-reader';
import type { DataLayer } from '../db/service';
import { AndroidSmsCatchupError } from './android-sms-catchup';
import { recordAndroidSmsCatchupFailure, runEnabledAndroidSmsCatchup } from './android-sms-flow';

export type AndroidSmsBackgroundTaskOutcome = 'success' | 'failed';

/** Check persisted consent and permissions before opening the ledger or querying the inbox. */
export async function runAndroidSmsBackgroundTask(
  platform: string,
  getReader: () => SmsReaderModule | null,
  getLedger: () => Promise<DataLayer>,
  taskError: unknown | null = null,
): Promise<AndroidSmsBackgroundTaskOutcome> {
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
  } catch {
    return fail('permission_unavailable');
  }
  if (!permissions || permissions.granted !== true || permissions.readSms !== true || permissions.receiveSms !== true) {
    return fail('permission_denied');
  }

  try {
    const ledger = await getLedger();
    await runEnabledAndroidSmsCatchup(reader, ledger, startDateMs, Date.now());
    return 'success';
  } catch (error) {
    recordAndroidSmsCatchupFailure(error);
    return 'failed';
  }
}

function fail(code: ConstructorParameters<typeof AndroidSmsCatchupError>[0]): AndroidSmsBackgroundTaskOutcome {
  recordAndroidSmsCatchupFailure(new AndroidSmsCatchupError(code));
  return 'failed';
}
