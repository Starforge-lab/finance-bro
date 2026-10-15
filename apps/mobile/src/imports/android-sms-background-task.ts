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
import { runAndroidSmsBackgroundTask } from './android-sms-background-runner';

export const ANDROID_SMS_BACKGROUND_TASK = 'finance-bro-android-sms-catchup';

if (Platform.OS === 'android') {
  TaskManager.defineTask(ANDROID_SMS_BACKGROUND_TASK, async ({ error }) => {
    try {
      const outcome = await runAndroidSmsBackgroundTask(Platform.OS, getSmsReader, getLedger, error);
      return outcome === 'success'
        ? BackgroundTask.BackgroundTaskResult.Success
        : BackgroundTask.BackgroundTaskResult.Failed;
    } catch {
      recordAndroidSmsCatchupFailure(new AndroidSmsBackgroundUnavailableError('registration_rollback'));
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export const androidSmsBackgroundScheduler = {
  async register() {
    if (Platform.OS !== 'android') throw new AndroidSmsBackgroundUnavailableError('registration_rollback');
    if (await TaskManager.isTaskRegisteredAsync(ANDROID_SMS_BACKGROUND_TASK)) return;
    if (await BackgroundTask.getStatusAsync() !== BackgroundTask.BackgroundTaskStatus.Available) {
      throw new AndroidSmsBackgroundUnavailableError('registration_rollback');
    }
    await BackgroundTask.registerTaskAsync(ANDROID_SMS_BACKGROUND_TASK, { minimumInterval: 15 });
  },
  async unregister() {
    if (Platform.OS !== 'android') return;
    if (await TaskManager.isTaskRegisteredAsync(ANDROID_SMS_BACKGROUND_TASK)) {
      await BackgroundTask.unregisterTaskAsync(ANDROID_SMS_BACKGROUND_TASK);
    }
  },
};

export function reconcileAndroidSmsBackgroundTask(reader: SmsReaderModule) {
  if (Platform.OS !== 'android') return Promise.resolve();
  return reconcileAndroidSmsImportSettings(reader, androidSmsBackgroundScheduler);
}
