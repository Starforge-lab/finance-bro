import type { DataLayer } from '../db/service';
import { DuplicateReviewRequiredError } from './key-state';
import { FingerprintKeyUnavailableError } from './fingerprint';
import { StaleSmsCursorError, type SmsCursor, type SmsImportBatchResult, type SmsInboxRow } from './sms';

const batchSize = 100;
const maxWindowMs = 90 * 24 * 60 * 60 * 1_000;
const maxPlatformId = 9_223_372_036_854_775_807n;

export type AndroidSmsReaderCursor = { dateMs: number; id: string };
export type AndroidSmsReaderMessage = AndroidSmsReaderCursor & { sender: string; body: string };
export type AndroidSmsReader = {
  getPermissionsAsync(): Promise<{ readSms: boolean; receiveSms: boolean; granted: boolean }>;
  queryInboxAsync(options: {
    startDateMs: number;
    endDateMs: number;
    after?: AndroidSmsReaderCursor;
    limit: number;
  }): Promise<{ messages: AndroidSmsReaderMessage[]; next: AndroidSmsReaderCursor | null }>;
};

export type AndroidSmsCatchupOptions = {
  reader: AndroidSmsReader;
  storage: Pick<DataLayer, 'getSmsImportCursor' | 'importSmsBatch'>;
  startDateMs: number;
  endDateMs: number;
  signal?: AbortSignal;
  clock: () => number;
};

export type AndroidSmsPreviewOptions = {
  reader: AndroidSmsReader;
  startDateMs: number;
  endDateMs: number;
  after?: AndroidSmsReaderCursor;
  signal?: AbortSignal;
};

export type AndroidSmsCatchupResult = Pick<SmsImportBatchResult, 'inserted' | 'duplicate' | 'review' | 'ignored'> & {
  completedAt: number;
};

export type AndroidSmsCatchupErrorCode =
  | 'permission_denied'
  | 'permission_unavailable'
  | 'source_unavailable'
  | 'invalid_source_page'
  | 'stale_cursor'
  | 'storage_unavailable'
  | 'key_unavailable'
  | 'duplicate_review_required'
  | 'invalid_clock';

const catchupErrorMessages: Record<AndroidSmsCatchupErrorCode, string> = {
  permission_denied: 'Android SMS permissions are unavailable.',
  permission_unavailable: 'Android SMS permission state could not be checked.',
  source_unavailable: 'Android SMS inbox could not be read.',
  invalid_source_page: 'Android SMS inbox returned an invalid page.',
  stale_cursor: 'Android SMS catch-up stopped because the ledger cursor changed.',
  storage_unavailable: 'Android SMS catch-up could not update the ledger.',
  key_unavailable: 'The saved import key is unavailable; restore access before importing.',
  duplicate_review_required: 'Existing imports need duplicate review before SMS catch-up can continue.',
  invalid_clock: 'Android SMS catch-up clock returned an invalid timestamp.',
};

export class AndroidSmsCatchupError extends Error {
  constructor(readonly code: AndroidSmsCatchupErrorCode) {
    super(catchupErrorMessages[code]);
    this.name = 'AndroidSmsCatchupError';
  }
}

type ReaderCursor = AndroidSmsReaderCursor;
type Page = { messages: SmsInboxRow[]; next: ReaderCursor | null };

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function readOptions(value: unknown): AndroidSmsCatchupOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Android SMS catch-up options must be a plain object');
  }
  const keys = Reflect.ownKeys(value);
  const allowed = ['reader', 'storage', 'startDateMs', 'endDateMs', 'signal', 'clock'];
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
      !['reader', 'storage', 'startDateMs', 'endDateMs', 'clock'].every((key) => keys.includes(key))) {
    throw new TypeError('Android SMS catch-up options have an invalid shape');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Android SMS catch-up options must contain plain values');
  }
  const options = value as AndroidSmsCatchupOptions;
  if (!Number.isSafeInteger(options.startDateMs) || options.startDateMs <= 0 ||
      !Number.isSafeInteger(options.endDateMs) || options.endDateMs <= 0 || options.endDateMs < options.startDateMs) {
    throw new RangeError('Android SMS catch-up dates must be positive safe integers in ascending order');
  }
  if (typeof options.clock !== 'function' || !options.reader || typeof options.reader !== 'object' ||
      !options.storage || typeof options.storage !== 'object') {
    throw new TypeError('Android SMS catch-up dependencies are invalid');
  }
  if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== 'boolean')) {
    throw new TypeError('Android SMS catch-up signal is invalid');
  }
  return Object.freeze({
    reader: options.reader,
    storage: options.storage,
    startDateMs: options.startDateMs,
    endDateMs: options.endDateMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    clock: options.clock,
  });
}

function assertPlatformId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > maxPlatformId) {
    throw new AndroidSmsCatchupError('invalid_source_page');
  }
}

function compareReaderCursor(left: ReaderCursor, right: ReaderCursor): number {
  if (left.dateMs !== right.dateMs) return left.dateMs < right.dateMs ? -1 : 1;
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function storageCursor(value: unknown): SmsCursor | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AndroidSmsCatchupError('storage_unavailable');
  try {
    const cursor = value as Record<string, unknown>;
    if (!Number.isSafeInteger(cursor.receivedAt) || (cursor.receivedAt as number) <= 0) {
      throw new AndroidSmsCatchupError('storage_unavailable');
    }
    assertPlatformId(cursor.platformId);
    return { receivedAt: cursor.receivedAt as number, platformId: cursor.platformId };
  } catch {
    throw new AndroidSmsCatchupError('storage_unavailable');
  }
}

function sameStorageCursor(left: SmsCursor | null, right: SmsCursor | null): boolean {
  return left?.receivedAt === right?.receivedAt && left?.platformId === right?.platformId;
}

function readerCursor(cursor: SmsCursor): ReaderCursor {
  return { dateMs: cursor.receivedAt, id: cursor.platformId };
}

function sourcePage(value: unknown, startDateMs: number, endDateMs: number, lowerBound: ReaderCursor | null): Page {
  try { return validateSourcePage(value, startDateMs, endDateMs, lowerBound); }
  catch (error) {
    if (error instanceof AndroidSmsCatchupError) throw error;
    throw new AndroidSmsCatchupError('invalid_source_page');
  }
}

function validateSourcePage(value: unknown, startDateMs: number, endDateMs: number, lowerBound: ReaderCursor | null): Page {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AndroidSmsCatchupError('invalid_source_page');
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.messages)) throw new AndroidSmsCatchupError('invalid_source_page');
  const next = result.next === null ? null : readReaderCursor(result.next);
  if (result.messages.length > batchSize || (next && result.messages.length === 0)) {
    throw new AndroidSmsCatchupError('invalid_source_page');
  }

  let previous = lowerBound;
  const pageIds = new Set<string>();
  const messages = result.messages.map((value): SmsInboxRow => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AndroidSmsCatchupError('invalid_source_page');
    const row = value as Record<string, unknown>;
    const cursor = readReaderCursor(row);
    if (cursor.dateMs < startDateMs || cursor.dateMs > endDateMs ||
        typeof row.sender !== 'string' || typeof row.body !== 'string' ||
        (previous && compareReaderCursor(cursor, previous) <= 0) || pageIds.has(cursor.id)) {
      throw new AndroidSmsCatchupError('invalid_source_page');
    }
    previous = cursor;
    pageIds.add(cursor.id);
    return { receivedAt: cursor.dateMs, platformId: cursor.id, sender: row.sender, body: row.body };
  });
  if (next && (!previous || compareReaderCursor(next, previous) !== 0)) {
    throw new AndroidSmsCatchupError('invalid_source_page');
  }
  return { messages, next };
}

function readReaderCursor(value: unknown): ReaderCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AndroidSmsCatchupError('invalid_source_page');
  const cursor = value as Record<string, unknown>;
  if (!Number.isSafeInteger(cursor.dateMs) || (cursor.dateMs as number) <= 0) {
    throw new AndroidSmsCatchupError('invalid_source_page');
  }
  assertPlatformId(cursor.id);
  return { dateMs: cursor.dateMs as number, id: cursor.id };
}

/** Count the consented history without returning or storing message content. */
export async function previewAndroidSms(value: AndroidSmsPreviewOptions): Promise<{ count: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Android SMS preview options must be a plain object');
  }
  const keys = Reflect.ownKeys(value);
  const allowed = ['reader', 'startDateMs', 'endDateMs', 'after', 'signal'];
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
      !['reader', 'startDateMs', 'endDateMs'].every((key) => keys.includes(key))) {
    throw new TypeError('Android SMS preview options have an invalid shape');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Android SMS preview options must contain plain values');
  }
  const { reader, startDateMs, endDateMs, signal } = value;
  const after = value.after === undefined ? undefined : readReaderCursor(value.after);
  if (!reader || typeof reader.getPermissionsAsync !== 'function' || typeof reader.queryInboxAsync !== 'function') {
    throw new TypeError('Android SMS preview reader is invalid');
  }
  if (!Number.isSafeInteger(startDateMs) || startDateMs <= 0 ||
      !Number.isSafeInteger(endDateMs) || endDateMs < startDateMs || (after && after.dateMs < startDateMs) ||
      (after && after.dateMs > endDateMs)) {
    throw new RangeError('Android SMS preview dates must be positive safe integers in ascending order');
  }
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean')) {
    throw new TypeError('Android SMS preview signal is invalid');
  }

  const checkAccess = async () => {
    throwIfAborted(signal);
    let permissions: { readSms: boolean; receiveSms: boolean; granted: boolean };
    try { permissions = await reader.getPermissionsAsync(); }
    catch {
      throwIfAborted(signal);
      throw new AndroidSmsCatchupError('permission_unavailable');
    }
    throwIfAborted(signal);
    if (!permissions || permissions.granted !== true || permissions.readSms !== true || permissions.receiveSms !== true) {
      throw new AndroidSmsCatchupError('permission_denied');
    }
  };

  await checkAccess();
  let windowStart = after?.dateMs ?? startDateMs;
  let count = 0;
  while (true) {
    throwIfAborted(signal);
    const windowEnd = endDateMs - windowStart >= maxWindowMs ? windowStart + maxWindowMs - 1 : endDateMs;
    let pageAfter = windowStart === (after?.dateMs ?? startDateMs) ? after : undefined;
    while (true) {
      await checkAccess();
      let rawPage: unknown;
      try {
        rawPage = await reader.queryInboxAsync({
          startDateMs: windowStart,
          endDateMs: windowEnd,
          ...(pageAfter ? { after: pageAfter } : {}),
          limit: batchSize,
        });
      } catch {
        throwIfAborted(signal);
        throw new AndroidSmsCatchupError('source_unavailable');
      }
      throwIfAborted(signal);
      const page = sourcePage(rawPage, windowStart, windowEnd, pageAfter ?? after ?? null);
      rawPage = undefined;
      await checkAccess();
      count += page.messages.length;
      if (!Number.isSafeInteger(count)) throw new AndroidSmsCatchupError('invalid_source_page');
      if (page.next === null) {
        if (windowEnd === endDateMs) return { count };
        break;
      }
      pageAfter = page.next;
    }
    windowStart = windowEnd + 1;
  }
}

export async function catchUpAndroidSms(value: AndroidSmsCatchupOptions): Promise<AndroidSmsCatchupResult> {
  const options = readOptions(value);
  const { reader, storage, startDateMs, endDateMs, signal, clock } = options;
  const getPermissionsAsync = reader.getPermissionsAsync;
  const queryInboxAsync = reader.queryInboxAsync;
  const getSmsImportCursor = storage.getSmsImportCursor;
  const importSmsBatch = storage.importSmsBatch;
  if (typeof getPermissionsAsync !== 'function' || typeof queryInboxAsync !== 'function' ||
      typeof getSmsImportCursor !== 'function' || typeof importSmsBatch !== 'function') {
    throw new TypeError('Android SMS catch-up dependencies are invalid');
  }

  const checkAccess = async () => {
    throwIfAborted(signal);
    let permissions: { readSms: boolean; receiveSms: boolean; granted: boolean };
    try { permissions = await getPermissionsAsync.call(reader); }
    catch {
      throwIfAborted(signal);
      throw new AndroidSmsCatchupError('permission_unavailable');
    }
    throwIfAborted(signal);
    try {
      if (!permissions || permissions.granted !== true || permissions.readSms !== true || permissions.receiveSms !== true) {
        throw new AndroidSmsCatchupError('permission_denied');
      }
    } catch (error) {
      if (error instanceof AndroidSmsCatchupError) throw error;
      throw new AndroidSmsCatchupError('permission_unavailable');
    }
  };

  const readCommittedCursor = async () => {
    throwIfAborted(signal);
    let value: SmsCursor | null;
    try { value = await getSmsImportCursor.call(storage); }
    catch {
      throwIfAborted(signal);
      throw new AndroidSmsCatchupError('storage_unavailable');
    }
    throwIfAborted(signal);
    return storageCursor(value);
  };

  await checkAccess();
  let committedCursor = await readCommittedCursor();
  let windowStart = startDateMs;
  const counts = { inserted: 0, duplicate: 0, review: 0, ignored: 0 };

  while (true) {
    throwIfAborted(signal);
    const windowEnd = endDateMs - windowStart >= maxWindowMs ? windowStart + maxWindowMs - 1 : endDateMs;
    let after: ReaderCursor | undefined;

    while (true) {
      throwIfAborted(signal);
      const observedCursor = await readCommittedCursor();
      if (!sameStorageCursor(observedCursor, committedCursor)) throw new AndroidSmsCatchupError('stale_cursor');
      await checkAccess();
      throwIfAborted(signal);

      let rawPage: unknown;
      try {
        rawPage = await queryInboxAsync.call(reader, {
          startDateMs: windowStart,
          endDateMs: windowEnd,
          ...(after ? { after } : {}),
          limit: batchSize,
        });
      } catch {
        throwIfAborted(signal);
        throw new AndroidSmsCatchupError('source_unavailable');
      }
      throwIfAborted(signal);
      const lowerBound = after ?? null;
      const page = sourcePage(rawPage, windowStart, windowEnd, lowerBound);
      rawPage = undefined;
      await checkAccess();

      const finalPage = page.next === null && windowEnd === endDateMs;
      if (page.messages.length > 0 || finalPage) {
        let completedAt: number | undefined;
        const getCompletionTime = () => {
          throwIfAborted(signal);
          let value: number;
          try { value = clock(); }
          catch { throw new AndroidSmsCatchupError('invalid_clock'); }
          if (!Number.isSafeInteger(value) || value <= 0) throw new AndroidSmsCatchupError('invalid_clock');
          completedAt = value;
          return value;
        };
        let result: SmsImportBatchResult;
        try {
          result = await importSmsBatch.call(storage, page.messages, committedCursor, {
            ...(finalPage ? { catchupCompletedAt: getCompletionTime } : {}),
            assertSourceAccess: checkAccess,
            replayAfter: lowerBound === null ? null : { receivedAt: lowerBound.dateMs, platformId: lowerBound.id },
          });
        } catch (error) {
          if (error instanceof AndroidSmsCatchupError) throw error;
          if (error instanceof FingerprintKeyUnavailableError) throw new AndroidSmsCatchupError('key_unavailable');
          if (error instanceof DuplicateReviewRequiredError) throw new AndroidSmsCatchupError('duplicate_review_required');
          if (error instanceof StaleSmsCursorError) throw new AndroidSmsCatchupError('stale_cursor');
          if (signal?.aborted) throw abortError();
          throwIfAborted(signal);
          throw new AndroidSmsCatchupError('storage_unavailable');
        }
        let expectedNextCursor = committedCursor;
        if (page.messages.length > 0) {
          const last = page.messages[page.messages.length - 1]!;
          const lastCursor = { receivedAt: last.receivedAt, platformId: last.platformId };
          if (!expectedNextCursor || compareReaderCursor(readerCursor(expectedNextCursor), {
            dateMs: lastCursor.receivedAt,
            id: lastCursor.platformId,
          }) < 0) expectedNextCursor = lastCursor;
        }
        const returnedCursor = storageCursor(result.cursor);
        if (!sameStorageCursor(returnedCursor, expectedNextCursor)) throw new AndroidSmsCatchupError('stale_cursor');
        committedCursor = returnedCursor;
        counts.inserted += result.inserted;
        counts.duplicate += result.duplicate;
        counts.review += result.review;
        counts.ignored += result.ignored;
        if (finalPage) {
          if (completedAt === undefined) throw new AndroidSmsCatchupError('storage_unavailable');
          return { ...counts, completedAt };
        }
      }

      if (page.next === null) {
        if (windowEnd === endDateMs) throw new AndroidSmsCatchupError('storage_unavailable');
        break;
      }
      after = page.next;
    }

    windowStart = windowEnd + 1;
  }
}
