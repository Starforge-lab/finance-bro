import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type SmsPermissionState = {
  readSms: boolean;
  receiveSms: boolean;
  granted: boolean;
};

export type SmsInboxCursor = {
  dateMs: number;
  id: string;
};

export type SmsInboxMessage = SmsInboxCursor & {
  sender: string;
  body: string;
};

export type SmsInboxQuery = {
  startDateMs: number;
  endDateMs: number;
  after?: SmsInboxCursor;
  limit: number;
  newestFirst?: boolean;
};

export type SmsInboxQueryResult = {
  messages: SmsInboxMessage[];
  next: SmsInboxCursor | null;
};

export type SmsWakeMetadata = {
  count: number;
  lastReceivedAtMs: number | null;
  lastMultipartCount: number;
  lastAttemptAtMs?: number | null;
  lastOutcome?: 'success' | 'failed' | 'deferred' | null;
  failedAttemptCount?: number;
};

export type SmsImportSettings = {
  enabled: boolean;
  startDateMs: number | null;
};

export type SmsImportSettingsUpdate = {
  enabled: boolean;
  startDateMs?: number;
  previewEndDateMs?: number;
};

export type SmsReaderModule = {
  getPermissionsAsync(): Promise<SmsPermissionState>;
  requestPermissionsAsync(): Promise<SmsPermissionState>;
  getImportSettingsAsync(): Promise<SmsImportSettings>;
  setImportSettingsAsync(settings: SmsImportSettingsUpdate): Promise<SmsImportSettings>;
  registerWakeTaskAsync(): Promise<void>;
  unregisterWakeTaskAsync(): Promise<void>;
  queryInboxAsync(options: SmsInboxQuery): Promise<SmsInboxQueryResult>;
  readInboxMessageAsync(platformId: string): Promise<SmsInboxMessage | null>;
  getWakeMetadataAsync(): Promise<SmsWakeMetadata>;
  getElapsedRealtimeAsync(): Promise<number>;
};

export function getSmsReader(): SmsReaderModule | null {
  return Platform.OS === 'android' ? requireOptionalNativeModule<SmsReaderModule>('SmsReader') : null;
}
