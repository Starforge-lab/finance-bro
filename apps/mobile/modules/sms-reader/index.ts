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

export type SmsCaptureFailureCode =
  | 'permission_denied'
  | 'permission_unavailable'
  | 'invalid_consent'
  | 'source_unavailable'
  | 'invalid_source_page'
  | 'stale_cursor'
  | 'storage_unavailable'
  | 'key_unavailable'
  | 'duplicate_review_required'
  | 'invalid_clock'
  | 'time_budget_exceeded'
  | 'background_unavailable'
  | 'unexpected';

export type SmsCaptureOutcome = 'success' | 'failed' | 'unavailable' | 'cancelled';

export type SmsWakeMetadata = {
  count: number;
  lastReceivedAtMs: number | null;
  lastMultipartCount: number;
  lastAttemptAtMs?: number | null;
  lastOutcome?: 'success' | 'failed' | 'deferred' | null;
  failedAttemptCount?: number;
  captureFailedCount?: number;
  captureUnavailableCount?: number;
  currentFailureCode?: SmsCaptureFailureCode | null;
  currentFailureAtMs?: number | null;
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
  beginCaptureAttemptAsync(): Promise<number | null>;
  finishCaptureAttemptAsync(
    revision: number,
    outcome: SmsCaptureOutcome,
    code: SmsCaptureFailureCode | null
  ): Promise<void>;
  getElapsedRealtimeAsync(): Promise<number>;
};

export function getSmsReader(): SmsReaderModule | null {
  return Platform.OS === 'android' ? requireOptionalNativeModule<SmsReaderModule>('SmsReader') : null;
}
