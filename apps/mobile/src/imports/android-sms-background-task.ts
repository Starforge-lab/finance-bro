import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { getLedger } from '../db';
import { getSmsReader, type SmsReaderModule } from '../../modules/sms-reader';
import {
  AndroidSmsBackgroundUnavailableError,
  reconcileAndroidSmsImportSettings,
  recordAndroidSmsCatchupFailure,
} from './android-sms-flow';
import { readAndroidSmsWakeDeadline, runAndroidSmsBackgroundTask } from './android-sms-background-runner';

export const ANDROID_SMS_BACKGROUND_TASK = 'finance-bro-android-sms-catchup';
export const ANDROID_SMS_WAKE_TASK = 'finance-bro-android-sms-wake';

async function executeAndroidSmsCatchupTask({ error }: { error: unknown | null }) {
  return executeAndroidSmsTask(error);
}

async function executeAndroidSmsWakeTask({ data, error }: { data: unknown; error: unknown | null }) {
  return executeAndroidSmsTask(error, {
    deadlineElapsedRealtimeMs: readAndroidSmsWakeDeadline(data),
  });
}

async function executeAndroidSmsTask(
  error: unknown | null,
  timing?: { deadlineElapsedRealtimeMs: unknown },
) {
  try {
    const outcome = await runAndroidSmsBackgroundTask(Platform.OS, getSmsReader, getLedger, error, timing);
    return outcome === 'success'
      ? BackgroundTask.BackgroundTaskResult.Success
      : BackgroundTask.BackgroundTaskResult.Failed;
  } catch {
    recordAndroidSmsCatchupFailure(new AndroidSmsBackgroundUnavailableError('registration_rollback'));
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

if (Platform.OS === 'android') {
  TaskManager.defineTask(ANDROID_SMS_BACKGROUND_TASK, executeAndroidSmsCatchupTask);
  TaskManager.defineTask(ANDROID_SMS_WAKE_TASK, executeAndroidSmsWakeTask);
}

export const androidSmsBackgroundScheduler = {
  async register() {
    if (Platform.OS !== 'android') throw new AndroidSmsBackgroundUnavailableError('registration_rollback');
    if (!(await TaskManager.isTaskRegisteredAsync(ANDROID_SMS_BACKGROUND_TASK))) {
      if (await BackgroundTask.getStatusAsync() !== BackgroundTask.BackgroundTaskStatus.Available) {
        throw new AndroidSmsBackgroundUnavailableError('registration_rollback');
      }
      await BackgroundTask.registerTaskAsync(ANDROID_SMS_BACKGROUND_TASK, { minimumInterval: 15 });
    }
    const reader = getSmsReader();
    if (!reader) throw new AndroidSmsBackgroundUnavailableError('registration_rollback');
    await reader.registerWakeTaskAsync();
  },
  async unregister() {
    if (Platform.OS !== 'android') return;
    let failed = false;
    const reader = getSmsReader();
    if (reader) {
      try { await reader.unregisterWakeTaskAsync(); } catch { failed = true; }
    } else {
      failed = true;
    }
    try {
      if (await TaskManager.isTaskRegisteredAsync(ANDROID_SMS_BACKGROUND_TASK)) {
        await BackgroundTask.unregisterTaskAsync(ANDROID_SMS_BACKGROUND_TASK);
      }
    } catch {
      failed = true;
    }
    if (failed) throw new AndroidSmsBackgroundUnavailableError('unregistration');
  },
};

export function reconcileAndroidSmsBackgroundTask(reader: SmsReaderModule) {
  if (Platform.OS !== 'android') return Promise.resolve();
  return reconcileAndroidSmsImportSettings(reader, androidSmsBackgroundScheduler);
}
