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
};

export type SmsInboxQueryResult = {
  messages: SmsInboxMessage[];
  next: SmsInboxCursor | null;
};

export type SmsWakeMetadata = {
  count: number;
  lastReceivedAtMs: number | null;
  lastMultipartCount: number;
};

export type SmsReaderModule = {
  getPermissionsAsync(): Promise<SmsPermissionState>;
  requestPermissionsAsync(): Promise<SmsPermissionState>;
  queryInboxAsync(options: SmsInboxQuery): Promise<SmsInboxQueryResult>;
  readInboxMessageAsync(platformId: string): Promise<SmsInboxMessage | null>;
  getWakeMetadataAsync(): Promise<SmsWakeMetadata>;
};

export function getSmsReader(): SmsReaderModule | null {
  return Platform.OS === 'android' ? requireOptionalNativeModule<SmsReaderModule>('SmsReader') : null;
}
