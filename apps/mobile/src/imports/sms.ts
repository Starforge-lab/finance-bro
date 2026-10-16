import { and, asc, count, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { parseSms, type ParsedTxn, type RawSms } from '@finance-bro/sms-parser';
import {
  createLedger,
  type LedgerMigrations,
  type LedgerSQLiteClient,
  type LedgerSQLiteTransactionRunner,
  type ReviewedSmsTransaction,
  InvalidTransactionReferenceError,
  assertValidReviewedSmsTransaction,
} from '../db/ledger';
import { accounts, importKeyState, preferences, smsImportRefs, smsImportState, transactions } from '../db/schema';
import { DuplicateReviewRequiredError, getFingerprintKeyPolicy, requiresDuplicateReview } from './key-state';
import { preparePastedSms, type PastePreparation, type ReviewCorrections } from './paste';
import { FingerprintKeyUnavailableError, type FingerprintKeyProvider, type Fingerprinter } from './fingerprint';

const maxBatchSize = 100;
const maxBodyLength = 16_384;
const maxSenderLength = 256;
const maxPlatformId = 9_223_372_036_854_775_807n;
const verifiedRuleVersions: Readonly<Record<string, number>> = {};
const smsCatchupCompletionPreference = 'sms.last_successful_catchup_at';

export type SmsCursor = { receivedAt: number; platformId: string };
export type SmsReviewCursor = SmsCursor & { referenceId: string };
export class StaleSmsCursorError extends Error {
  constructor() {
    super('SMS import cursor is stale; reload the current cursor before retrying');
    this.name = 'StaleSmsCursorError';
  }
}
export type SmsInboxRow = RawSms & { platformId: string };
export type SmsImportBatchResult = {
  cursor: SmsCursor | null;
  inserted: number;
  duplicate: number;
  review: number;
  ignored: number;
};
export type SmsImportBatchOptions = {
  catchupCompletedAt?: number | (() => number);
  assertSourceAccess?: () => void | Promise<void>;
  replayAfter?: SmsCursor | null;
};
export type SmsImportHealth = {
  lastSuccessfulCatchupAt: number | null;
  pendingReviewCount: number;
  nonPostedReviewCount: number;
};
export type SmsReviewRow = SmsReviewCursor & {
  reason: string | null;
  ruleId: string | null;
  ruleVersion: number | null;
};
export type SmsReviewPage = { rows: SmsReviewRow[]; nextCursor?: SmsReviewCursor };

export type SmsOriginalReader = (platformId: string) => Promise<SmsInboxRow | null>;
export type SmsReviewUnavailableReason =
  | 'not_pending'
  | 'missing_original'
  | 'source_changed'
  | 'unreadable_source'
  | 'no_longer_financial'
  | 'key_unavailable'
  | 'storage_unavailable'
  | 'source_unavailable';
export type SmsReviewConfirmationUnavailableReason = SmsReviewUnavailableReason | 'stale_preparation' | 'ambiguous_overlap' | 'invalid_correction' | 'transaction_unavailable';
export type SmsReviewPreparation =
  | { kind: 'ready'; referenceId: string; platformId: string; receivedAt: number; preparation: Extract<PastePreparation, { kind: 'needs-review' }> }
  | { kind: 'unavailable'; referenceId: string; platformId: string | null; reason: SmsReviewUnavailableReason };
export type SmsReviewConfirmationResult =
  | { kind: 'saved'; referenceId: string; platformId: string; transactionId: string }
  | { kind: 'duplicate'; referenceId: string; platformId: string; transactionId: string }
  | { kind: 'unavailable'; referenceId: string; platformId: string | null; reason: SmsReviewConfirmationUnavailableReason };
export type SmsReviewConfirmationOptions = { separatePayment?: boolean };

export type SmsReviewPageOptions = { limit?: number | undefined; after?: SmsReviewCursor | null | undefined };

type ReviewReason =
  | 'unknown_format'
  | 'non_posted'
  | 'unreadable_source'
  | 'unsafe_amount'
  | 'unknown_account'
  | 'weak_identity'
  | 'unverified_rule'
  | 'weak_overlap'
  | 'inconsistent_evidence'
  | 'ambiguous_evidence';

function assertCursor(value: unknown, name: string): asserts value is SmsCursor | null {
  if (value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be a cursor or null`);
  const cursor = value as Record<string, unknown>;
  if (!Number.isSafeInteger(cursor.receivedAt) || (cursor.receivedAt as number) <= 0) {
    throw new TypeError(`${name}.receivedAt must be a positive safe integer`);
  }
  assertPlatformId(cursor.platformId, `${name}.platformId`);
  if (Object.keys(cursor).some((key) => key !== 'receivedAt' && key !== 'platformId')) {
    throw new TypeError(`${name} contains unsupported fields`);
  }
}

function assertPlatformId(value: unknown, name = 'platformId'): asserts value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > maxPlatformId) {
    throw new TypeError(`${name} must be a canonical positive Android row ID`);
  }
}

function assertReferenceId(value: unknown, name = 'referenceId'): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !/^[a-zA-Z0-9:_-]+$/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertReviewCursor(value: unknown, name: string): asserts value is SmsReviewCursor | null {
  if (value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be a cursor or null`);
  const cursor = value as Record<string, unknown>;
  if (!Number.isSafeInteger(cursor.receivedAt) || (cursor.receivedAt as number) <= 0) {
    throw new TypeError(`${name}.receivedAt must be a positive safe integer`);
  }
  assertPlatformId(cursor.platformId, `${name}.platformId`);
  assertReferenceId(cursor.referenceId, `${name}.referenceId`);
  if (Object.keys(cursor).some((key) => !['receivedAt', 'platformId', 'referenceId'].includes(key))) {
    throw new TypeError(`${name} contains unsupported fields`);
  }
}

function validateReviewPageOptions(value: unknown): asserts value is SmsReviewPageOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SMS review page options must be an object');
  }
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some((key) => key !== 'limit' && key !== 'after')) {
    throw new TypeError('SMS review page options contain unsupported fields');
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || (options.limit as number) < 1 || (options.limit as number) > maxBatchSize)) {
    throw new RangeError(`SMS review page limit must be an integer from 1 to ${maxBatchSize}`);
  }
  assertReviewCursor(options.after ?? null, 'after');
}

function snapshotSmsImportBatchOptions(value: unknown): SmsImportBatchOptions {
  const options = readOwnDataRecord(value, 'SMS import batch options', ['catchupCompletedAt', 'assertSourceAccess', 'replayAfter'], false);
  const completion = options.catchupCompletedAt;
  if (completion !== undefined && typeof completion !== 'function' &&
      (!Number.isSafeInteger(completion) || (completion as number) <= 0)) {
    throw new TypeError('catchupCompletedAt must be a positive safe integer or a function');
  }
  if (options.assertSourceAccess !== undefined && typeof options.assertSourceAccess !== 'function') {
    throw new TypeError('assertSourceAccess must be a function');
  }
  const hasReplayAfter = Reflect.ownKeys(options).includes('replayAfter');
  if (hasReplayAfter) assertCursor(options.replayAfter, 'replayAfter');
  return {
    ...(completion === undefined ? {} : { catchupCompletedAt: completion as number | (() => number) }),
    ...(options.assertSourceAccess === undefined ? {} : { assertSourceAccess: options.assertSourceAccess as () => void | Promise<void> }),
    ...(hasReplayAfter ? { replayAfter: options.replayAfter as SmsCursor | null } : {}),
  };
}

function parseStoredCatchupCompletion(value: string | undefined): number | null {
  if (value === undefined) return null;
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || String(timestamp) !== value) {
    throw new Error('Stored SMS catch-up completion time is invalid');
  }
  return timestamp;
}

function validateSmsReviewCounts(value: {
  pendingReviewCount: number;
  nonPostedReviewCount: number;
} | undefined): asserts value is { pendingReviewCount: number; nonPostedReviewCount: number } {
  if (!value || !Number.isSafeInteger(value.pendingReviewCount) || value.pendingReviewCount < 0 ||
      !Number.isSafeInteger(value.nonPostedReviewCount) || value.nonPostedReviewCount < 0 ||
      value.nonPostedReviewCount > value.pendingReviewCount) {
    throw new Error('SMS review counts are invalid');
  }
}

async function saveCatchupCompletion(ledger: ReturnType<typeof createLedger>, completedAt: number): Promise<void> {
  const value = String(completedAt);
  await ledger.db.insert(preferences).values({ key: smsCatchupCompletionPreference, value })
    .onConflictDoUpdate({ target: preferences.key, set: { value } }).run();
}

function compareCursor(left: SmsCursor, right: SmsCursor): number {
  if (left.receivedAt !== right.receivedAt) return left.receivedAt < right.receivedAt ? -1 : 1;
  const leftId = BigInt(left.platformId);
  const rightId = BigInt(right.platformId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function validateBatch(batch: unknown, expectedCursor: unknown): asserts batch is SmsInboxRow[] {
  assertCursor(expectedCursor, 'expectedCursor');
  if (!Array.isArray(batch) || batch.length > maxBatchSize) throw new RangeError(`SMS batch must contain at most ${maxBatchSize} rows`);

  let previous = expectedCursor;
  const ids = new Set<string>();
  for (const [index, value] of batch.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`SMS row ${index} must be an object`);
    const row = value as Record<string, unknown>;
    assertPlatformId(row.platformId, `SMS row ${index} platformId`);
    if (typeof row.sender !== 'string') {
      throw new TypeError(`SMS row ${index} sender is invalid`);
    }
    if (typeof row.body !== 'string') {
      throw new TypeError(`SMS row ${index} body is invalid`);
    }
    if (!Number.isSafeInteger(row.receivedAt) || (row.receivedAt as number) <= 0) {
      throw new TypeError(`SMS row ${index} receivedAt must be a positive safe integer`);
    }
    if (Object.keys(row).some((key) => !['platformId', 'sender', 'body', 'receivedAt'].includes(key))) {
      throw new TypeError(`SMS row ${index} contains unsupported fields`);
    }
    if (ids.has(row.platformId)) throw new TypeError('SMS batch contains a repeated platform row ID');
    ids.add(row.platformId);
    const cursor = { receivedAt: row.receivedAt as number, platformId: row.platformId };
    if (previous && compareCursor(cursor, previous) <= 0) {
      throw new RangeError('SMS rows must be strictly ordered after the expected cursor');
    }
    previous = cursor;
  }
}

async function keyedFingerprint(fingerprinter: Fingerprinter, value: unknown[]): Promise<string> {
  let result: string;
  try { result = await fingerprinter.fingerprint(JSON.stringify(value)); }
  catch (error) { throw safeFingerprintFailure(error); }
  if (!/^[a-f0-9]{64}$/.test(result)) throw new TypeError('Invalid keyed SMS fingerprint');
  return result;
}

function safeFingerprintFailure(error: unknown): Error {
  if (isAbortError(error)) {
    const aborted = new Error('The operation was aborted.');
    aborted.name = 'AbortError';
    return aborted;
  }
  if (error instanceof FingerprintKeyUnavailableError) return error;
  return new Error('Unable to create keyed SMS fingerprint');
}

async function smsSourceReferenceId(fingerprinter: Fingerprinter, row: SmsInboxRow, bodyHash: string): Promise<string> {
  return keyedFingerprint(fingerprinter, ['sms-source-reference', row.platformId, row.receivedAt, bodyHash]);
}

async function findSmsSourceReference(
  ledger: ReturnType<typeof createLedger>,
  row: SmsInboxRow,
  bodyHash: string,
): Promise<typeof smsImportRefs.$inferSelect | undefined> {
  return ledger.db.select().from(smsImportRefs).where(and(
    eq(smsImportRefs.platformId, row.platformId),
    eq(smsImportRefs.receivedAt, row.receivedAt),
    eq(smsImportRefs.bodyHash, bodyHash),
  )).get();
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

async function fingerprintHistoryMatches(ledger: ReturnType<typeof createLedger>, keyId: string): Promise<boolean> {
  const [importState, smsState] = await Promise.all([
    ledger.db.select({ keyId: importKeyState.keyId }).from(importKeyState).where(eq(importKeyState.id, 1)).get(),
    ledger.db.select({ keyId: smsImportState.keyId }).from(smsImportState).where(eq(smsImportState.id, 1)).get(),
  ]);
  return importState?.keyId === keyId && (!smsState || smsState.keyId === keyId);
}

function smsReviewReferenceFailure(
  current: typeof smsImportRefs.$inferSelect | undefined,
  expected: typeof smsImportRefs.$inferSelect,
): SmsReviewConfirmationUnavailableReason | undefined {
  if (!current || current.status !== 'review' || current.transactionId !== null) return 'not_pending';
  if (current.platformId !== expected.platformId || current.receivedAt !== expected.receivedAt ||
      current.bodyHash !== expected.bodyHash || current.senderHash !== expected.senderHash) return 'source_changed';
  if (current.keyId !== expected.keyId) return 'key_unavailable';
  if (current.referenceId !== expected.referenceId || current.dedupeKey !== expected.dedupeKey ||
      current.reason !== expected.reason || current.ruleId !== expected.ruleId ||
      current.ruleVersion !== expected.ruleVersion || current.createdAt !== expected.createdAt) return 'stale_preparation';
  return undefined;
}

async function smsReviewKeyFailure(
  ledger: ReturnType<typeof createLedger>,
  fingerprints: FingerprintKeyProvider | undefined,
  expectedKeyId: string,
): Promise<'key_unavailable' | 'storage_unavailable' | undefined> {
  let policy: Awaited<ReturnType<typeof getFingerprintKeyPolicy>>;
  try { policy = await getFingerprintKeyPolicy(ledger); }
  catch { return 'storage_unavailable'; }
  if (policy.allowCreate || !fingerprints) return 'key_unavailable';

  let fingerprinter: Fingerprinter;
  try { fingerprinter = await fingerprints({ allowCreate: false }); }
  catch (error) {
    if (isAbortError(error)) throw error;
    return 'key_unavailable';
  }
  let keyId: string;
  try { keyId = fingerprinter.keyId; }
  catch { return 'key_unavailable'; }
  if (!/^[a-f0-9]{64}$/.test(keyId) || keyId !== expectedKeyId) return 'key_unavailable';

  try {
    return await fingerprintHistoryMatches(ledger, keyId) ? undefined : 'key_unavailable';
  } catch {
    return 'storage_unavailable';
  }
}

async function smsReviewSourceFailure(
  readOriginal: SmsOriginalReader,
  expected: SmsInboxRow,
): Promise<SmsReviewConfirmationUnavailableReason | undefined> {
  let original: SmsInboxRow | null;
  try { original = await readOriginal(expected.platformId); }
  catch (error) {
    if (isAbortError(error)) throw error;
    return 'source_unavailable';
  }
  if (original === null) return 'missing_original';

  try { validateBatch([original], null); }
  catch { return 'source_changed'; }
  return original.platformId === expected.platformId && original.receivedAt === expected.receivedAt &&
    original.sender === expected.sender && original.body === expected.body ? undefined : 'source_changed';
}

function currentCursor(state: { cursorReceivedAt: number | null; cursorPlatformId: string | null } | undefined): SmsCursor | null {
  if (!state || state.cursorReceivedAt === null) return null;
  if (state.cursorPlatformId === null) throw new Error('Stored SMS cursor is incomplete');
  const cursor = { receivedAt: state.cursorReceivedAt, platformId: state.cursorPlatformId };
  assertCursor(cursor, 'storedCursor');
  return cursor;
}

function normalizeInstitution(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized === 'hdfc bank' ? 'hdfc' : normalized || null;
}

async function resolveAccount(
  ledger: ReturnType<typeof createLedger>,
  ruleId: string | null,
  candidate: ParsedTxn | null,
): Promise<string | null> {
  const institution = normalizeInstitution(candidate?.institution ?? null);
  if (!institution || !candidate?.accountLast4) return null;
  const possibleMatches = await ledger.db.select({ id: accounts.id, institution: accounts.institution, type: accounts.type })
    .from(accounts).where(and(
      eq(accounts.last4, candidate.accountLast4),
      eq(accounts.archived, false),
    )).all();
  const matches = possibleMatches.filter((account) => normalizeInstitution(account.institution) === institution &&
    (ruleId !== 'hdfc.upi.credit' || account.type === 'bank'));
  return matches.length === 1 ? matches[0]!.id : null;
}

function getReviewReason(
  parsed: ReturnType<typeof parseSms>,
  candidate: ParsedTxn | null,
  accountId: string | null,
  dedupeKey: string,
): ReviewReason | null {
  if (!candidate) return 'unknown_format';
  if (candidate.status !== 'posted') return 'non_posted';
  if (!Number.isSafeInteger(candidate.amountPaise) || candidate.amountPaise <= 0) return 'unsafe_amount';
  if (!accountId) return 'unknown_account';
  if (!dedupeKey.startsWith('upi:')) return 'weak_identity';
  if (parsed.kind !== 'transaction' || parsed.confidence !== 'high' || verifiedRuleVersions[parsed.ruleId] !== parsed.ruleVersion) {
    return 'unverified_rule';
  }
  return null;
}

async function writeReference(
  ledger: ReturnType<typeof createLedger>,
  referenceId: string,
  row: SmsInboxRow,
  fingerprinter: Fingerprinter,
  senderHash: string,
  preparation: {
    identity: { dedupeKey: string; bodyHash: string };
    ruleId: string | null;
    ruleVersion: number | null;
  },
  status: 'review' | 'saved' | 'duplicate',
  reason: ReviewReason | null,
  transactionId: string | null,
): Promise<void> {
  await ledger.db.insert(smsImportRefs).values({
    referenceId,
    platformId: row.platformId,
    receivedAt: row.receivedAt,
    senderHash,
    dedupeKey: preparation.identity.dedupeKey,
    bodyHash: preparation.identity.bodyHash,
    keyId: fingerprinter.keyId,
    status,
    reason,
    ruleId: preparation.ruleId,
    ruleVersion: preparation.ruleVersion,
    transactionId,
    createdAt: Date.now(),
  }).run();
}

function matchingEvidence(existing: typeof transactions.$inferSelect, candidate: ParsedTxn, accountId: string | null): boolean {
  return existing.amountPaise === candidate.amountPaise &&
    existing.direction === candidate.direction &&
    existing.status === candidate.status &&
    existing.kind === candidate.kind &&
    existing.accountId === accountId;
}

function sameTransactionEvidence(
  existing: typeof transactions.$inferSelect,
  candidate: ReviewedSmsTransaction,
): boolean {
  return existing.amountPaise === candidate.amountPaise &&
    existing.direction === candidate.direction &&
    existing.status === candidate.status &&
    existing.kind === candidate.kind &&
    existing.accountId === candidate.accountId;
}

type ReadySmsReviewCheck = {
  result: Extract<SmsReviewPreparation, { kind: 'ready' }>;
  reference: typeof smsImportRefs.$inferSelect;
  source: SmsInboxRow;
};
type SmsReviewCheck = ReadySmsReviewCheck | {
  result: Extract<SmsReviewPreparation, { kind: 'unavailable' }>;
};

async function prepareSmsReviewForLedger(
  ledger: ReturnType<typeof createLedger>,
  fingerprints: FingerprintKeyProvider | undefined,
  referenceId: string,
  readOriginal: SmsOriginalReader,
): Promise<SmsReviewCheck> {
  let platformId: string | null = null;
  const unavailable = (reason: SmsReviewUnavailableReason): SmsReviewCheck => ({
    result: { kind: 'unavailable', referenceId, platformId, reason },
  });

  let reference: typeof smsImportRefs.$inferSelect | undefined;
  try {
    reference = await ledger.db.select().from(smsImportRefs)
      .where(eq(smsImportRefs.referenceId, referenceId)).get();
  } catch {
    return unavailable('storage_unavailable');
  }
  if (reference) platformId = reference.platformId;
  if (!reference || reference.status !== 'review' || reference.transactionId !== null) {
    return unavailable('not_pending');
  }
  if (reference.reason === 'unreadable_source') return unavailable('unreadable_source');
  if (!fingerprints) return unavailable('key_unavailable');

  let policy: Awaited<ReturnType<typeof getFingerprintKeyPolicy>>;
  try {
    policy = await getFingerprintKeyPolicy(ledger);
  } catch {
    return unavailable('storage_unavailable');
  }
  if (policy.allowCreate) return unavailable('key_unavailable');

  // A persisted reference must never trigger key provisioning during re-read.
  let fingerprinter: Fingerprinter;
  try {
    fingerprinter = await fingerprints({ allowCreate: false });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return unavailable('key_unavailable');
  }
  let keyId: string;
  try {
    keyId = fingerprinter.keyId;
  } catch {
    return unavailable('key_unavailable');
  }
  if (!/^[a-f0-9]{64}$/.test(keyId) || !/^[a-f0-9]{64}$/.test(reference.keyId) || reference.keyId !== keyId) {
    return unavailable('key_unavailable');
  }
  let historyMatches: boolean;
  try {
    historyMatches = await fingerprintHistoryMatches(ledger, keyId);
  } catch {
    return unavailable('storage_unavailable');
  }
  if (!historyMatches) return unavailable('key_unavailable');

  let original: SmsInboxRow | null;
  try {
    original = await readOriginal(reference.platformId);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return unavailable('source_unavailable');
  }
  if (original === null) return unavailable('missing_original');

  let row: SmsInboxRow;
  try {
    validateBatch([original], null);
    row = {
      platformId: original.platformId,
      receivedAt: original.receivedAt,
      sender: original.sender,
      body: original.body,
    };
  } catch {
    return unavailable('source_changed');
  }
  if (row.platformId !== reference.platformId) return unavailable('source_changed');
  try {
    parseSms(row);
  } catch {
    return unavailable('source_changed');
  }

  let preparation: Awaited<ReturnType<typeof preparePastedSms>>;
  let bodyHash: string;
  let senderHash: string;
  try {
    preparation = await preparePastedSms(row, fingerprinter);
    bodyHash = preparation.kind === 'needs-review'
      ? preparation.identity.bodyHash
      : await keyedFingerprint(fingerprinter, ['body', row.body]);
    senderHash = await keyedFingerprint(fingerprinter, ['sender', row.sender.trim().toUpperCase()]);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return unavailable('key_unavailable');
  }

  let currentReference: typeof smsImportRefs.$inferSelect | undefined;
  try {
    currentReference = await ledger.db.select().from(smsImportRefs)
      .where(eq(smsImportRefs.referenceId, referenceId)).get();
  } catch {
    return unavailable('storage_unavailable');
  }
  if (!currentReference || currentReference.status !== 'review' || currentReference.transactionId !== null) {
    return unavailable('not_pending');
  }
  let currentHistoryMatches: boolean;
  try {
    currentHistoryMatches = await fingerprintHistoryMatches(ledger, keyId);
  } catch {
    return unavailable('storage_unavailable');
  }
  if (currentReference.keyId !== keyId || !currentHistoryMatches) return unavailable('key_unavailable');
  if (row.receivedAt !== reference.receivedAt ||
      bodyHash !== reference.bodyHash || senderHash !== reference.senderHash ||
      currentReference.platformId !== reference.platformId ||
      currentReference.receivedAt !== reference.receivedAt ||
      currentReference.bodyHash !== reference.bodyHash ||
      currentReference.senderHash !== reference.senderHash ||
      currentReference.keyId !== reference.keyId) {
    return unavailable('source_changed');
  }
  if (preparation.kind === 'ignored') return unavailable('no_longer_financial');

  // Re-read protected storage after the inbox and hash awaits; never confirm with only the earlier key copy.
  let currentFingerprinter: Fingerprinter;
  try {
    currentFingerprinter = await fingerprints({ allowCreate: false });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return unavailable('key_unavailable');
  }
  let currentKeyId: string;
  try {
    currentKeyId = currentFingerprinter.keyId;
  } catch {
    return unavailable('key_unavailable');
  }
  if (!/^[a-f0-9]{64}$/.test(currentKeyId) || currentKeyId !== keyId || currentKeyId !== reference.keyId) {
    return unavailable('key_unavailable');
  }
  let latestBodyHash: string;
  let latestSenderHash: string;
  try {
    [latestBodyHash, latestSenderHash] = await Promise.all([
      keyedFingerprint(currentFingerprinter, ['body', row.body]),
      keyedFingerprint(currentFingerprinter, ['sender', row.sender.trim().toUpperCase()]),
    ]);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return unavailable('key_unavailable');
  }
  if (latestBodyHash !== reference.bodyHash || latestSenderHash !== reference.senderHash) {
    return unavailable('key_unavailable');
  }
  let latestHistoryMatches: boolean;
  try {
    latestHistoryMatches = await fingerprintHistoryMatches(ledger, currentKeyId);
  } catch {
    return unavailable('storage_unavailable');
  }
  if (!latestHistoryMatches) return unavailable('key_unavailable');

  return {
    result: { kind: 'ready', referenceId, platformId: reference.platformId, receivedAt: reference.receivedAt, preparation },
    reference: currentReference,
    source: row,
  };
}

function readOwnDataRecord(value: unknown, name: string, keys: readonly string[], exact = true): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
      (exact ? actualKeys.length !== keys.length : actualKeys.length > keys.length)) {
    throw new TypeError(`${name} has an invalid shape`);
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError(`${name} must contain plain values`);
  }
  return value as Record<string, unknown>;
}

const candidateFields = [
  'amountPaise', 'direction', 'kind', 'status', 'channel', 'institution', 'accountLast4', 'counterparty', 'vpa',
  'upiRef', 'balancePaise', 'occurredAt',
] as const;

function smsReviewSnapshot(referenceId: string, value: unknown): string {
  const expected = readOwnDataRecord(value, 'SMS review preparation', ['kind', 'referenceId', 'platformId', 'receivedAt', 'preparation']);
  assertReferenceId(expected.referenceId);
  assertPlatformId(expected.platformId);
  if (!Number.isSafeInteger(expected.receivedAt) || (expected.receivedAt as number) <= 0 ||
      expected.kind !== 'ready' || expected.referenceId !== referenceId) {
    throw new TypeError('A matching ready SMS preparation is required');
  }
  const preparation = readOwnDataRecord(expected.preparation, 'SMS parser preparation', [
    'kind', 'candidate', 'ruleId', 'ruleVersion', 'identity', 'fingerprintKeyId', 'duplicateReviewRequired', 'collision',
  ]);
  if (preparation.kind !== 'needs-review' || typeof preparation.duplicateReviewRequired !== 'boolean' ||
      !(preparation.ruleId === null || typeof preparation.ruleId === 'string') ||
      !(preparation.ruleVersion === null || (Number.isSafeInteger(preparation.ruleVersion) && (preparation.ruleVersion as number) > 0)) ||
      ((preparation.ruleId === null) !== (preparation.ruleVersion === null)) ||
      typeof preparation.fingerprintKeyId !== 'string' || !/^[a-f0-9]{64}$/.test(preparation.fingerprintKeyId)) {
    throw new TypeError('SMS parser preparation is invalid');
  }

  const identity = readOwnDataRecord(preparation.identity, 'SMS identity', ['id', 'dedupeKey', 'bodyHash']);
  if (typeof identity.dedupeKey !== 'string' || !/^(upi|body):[a-f0-9]{64}$/.test(identity.dedupeKey) ||
      identity.id !== `paste:${identity.dedupeKey}` || typeof identity.bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(identity.bodyHash)) {
    throw new TypeError('SMS identity is invalid');
  }

  let candidateSnapshot: unknown[] | null = null;
  if (preparation.candidate !== null) {
    const candidate = readOwnDataRecord(preparation.candidate, 'SMS candidate', candidateFields);
    if (typeof candidate.amountPaise !== 'number' || !Number.isFinite(candidate.amountPaise) ||
        !['debit', 'credit'].includes(candidate.direction as string) ||
        !['expense', 'income', 'refund', 'reversal', 'cash_withdrawal'].includes(candidate.kind as string) ||
        !['posted', 'failed'].includes(candidate.status as string) ||
        !['upi', 'card', 'netbanking', 'imps', 'neft', 'rtgs', 'atm', 'wallet', 'unknown'].includes(candidate.channel as string) ||
        !Number.isSafeInteger(candidate.occurredAt) || (candidate.occurredAt as number) <= 0 ||
        !(candidate.balancePaise === null || (typeof candidate.balancePaise === 'number' && Number.isFinite(candidate.balancePaise)))) {
      throw new TypeError('SMS candidate is invalid');
    }
    for (const key of ['institution', 'accountLast4', 'counterparty', 'vpa', 'upiRef'] as const) {
      if (!(candidate[key] === null || typeof candidate[key] === 'string') ||
          (typeof candidate[key] === 'string' && candidate[key]!.length > maxBodyLength)) {
        throw new TypeError('SMS candidate is invalid');
      }
    }
    candidateSnapshot = candidateFields.map((key) => candidate[key]);
  }

  let collisionSnapshot: unknown[] | null = null;
  if (preparation.collision !== null) {
    const collision = readOwnDataRecord(preparation.collision, 'SMS collision', ['occurredAt', 'deleted']);
    if (!Number.isSafeInteger(collision.occurredAt) || typeof collision.deleted !== 'boolean') {
      throw new TypeError('SMS collision is invalid');
    }
    collisionSnapshot = [collision.occurredAt, collision.deleted];
  }

  const snapshot = JSON.stringify([
    expected.kind, expected.referenceId, expected.platformId, expected.receivedAt, preparation.kind, candidateSnapshot, preparation.ruleId, preparation.ruleVersion,
    identity.id, identity.dedupeKey, identity.bodyHash, preparation.fingerprintKeyId,
    preparation.duplicateReviewRequired, collisionSnapshot,
  ]);
  if (snapshot === undefined || snapshot.length > 32_768) throw new RangeError('SMS review preparation is too large');
  return snapshot;
}

function validateExpectedPreparation(referenceId: string, value: unknown): string {
  return smsReviewSnapshot(referenceId, value);
}

function snapshotCorrections(value: unknown): ReviewCorrections {
  if (value === undefined) return {};
  const allowed = [
    'amountPaise', 'direction', 'kind', 'status', 'accountId', 'counterparty', 'merchantId', 'categoryId',
    'occurredAt', 'note', 'upiRef', 'linkedTxnId', 'excludeFromStats',
  ] as const;
  const record = readOwnDataRecord(value, 'SMS review corrections', allowed, false);
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(record)) {
    const name = key as string;
    const item = record[name];
    if (item === undefined) continue;
    if (name === 'occurredAt') {
      if (!(item instanceof Date)) throw new TypeError('occurredAt must be a valid Date');
      const time = Date.prototype.getTime.call(item);
      if (!Number.isFinite(time)) throw new TypeError('occurredAt must be a valid Date');
      output[name] = new Date(time);
    } else if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
      output[name] = item;
    } else {
      throw new TypeError('SMS review correction values must be primitive');
    }
  }
  return output as ReviewCorrections;
}

function validateConfirmationOptions(value: unknown): SmsReviewConfirmationOptions {
  if (value === undefined) return {};
  const options = readOwnDataRecord(value, 'SMS review confirmation options', ['separatePayment'], false);
  if (options.separatePayment !== undefined && typeof options.separatePayment !== 'boolean') {
    throw new TypeError('SMS review confirmation options are invalid');
  }
  return { separatePayment: options.separatePayment as boolean | undefined };
}

function correctedSmsTransaction(
  referenceId: string,
  preparation: Extract<PastePreparation, { kind: 'needs-review' }>,
  corrections: ReviewCorrections,
  defaultAccountId: string | null,
): ReviewedSmsTransaction {
  const candidate = preparation.candidate;
  if (!candidate) {
    for (const key of ['amountPaise', 'direction', 'kind', 'status', 'occurredAt'] as const) {
      if (corrections[key] === undefined) throw new TypeError(`${key} is required for an unparsed SMS`);
    }
  }
  const value = <K extends keyof ReviewCorrections>(key: K, fallback: ReviewCorrections[K]): ReviewCorrections[K] =>
    corrections[key] === undefined ? fallback : corrections[key] as ReviewCorrections[K];
  const amountPaise = value('amountPaise', candidate?.amountPaise);
  const direction = value('direction', candidate?.direction);
  const kind = value('kind', candidate?.kind);
  const status = value('status', candidate?.status);
  const occurredAt = value('occurredAt', candidate ? new Date(candidate.occurredAt) : undefined);
  if (amountPaise === undefined || direction === undefined || kind === undefined || status === undefined || occurredAt === undefined) {
    throw new TypeError('A complete reviewed transaction is required');
  }
  return {
    id: `sms:${referenceId}`,
    amountPaise,
    direction,
    kind,
    status,
    accountId: value('accountId', defaultAccountId),
    counterparty: value('counterparty', candidate?.counterparty ?? null),
    merchantId: value('merchantId', null),
    categoryId: value('categoryId', null),
    occurredAt,
    note: value('note', null),
    source: 'sms',
    smsRefId: `android-sms:${referenceId}`,
    upiRef: value('upiRef', candidate?.upiRef ?? null),
    dedupeKey: preparation.identity.dedupeKey,
    bodyHash: preparation.identity.bodyHash,
    ruleId: preparation.ruleId,
    ruleVersion: preparation.ruleVersion,
    linkedTxnId: value('linkedTxnId', null),
    excludeFromStats: value('excludeFromStats', false),
  };
}

async function resolveReviewReference(
  ledger: ReturnType<typeof createLedger>,
  reference: typeof smsImportRefs.$inferSelect,
  preparation: Extract<PastePreparation, { kind: 'needs-review' }>,
  status: 'saved' | 'duplicate',
  transactionId: string,
): Promise<boolean> {
  const rows = await ledger.db.update(smsImportRefs).set({
    status,
    reason: null,
    transactionId,
    dedupeKey: preparation.identity.dedupeKey,
    ruleId: preparation.ruleId,
    ruleVersion: preparation.ruleVersion,
  }).where(and(
    eq(smsImportRefs.referenceId, reference.referenceId),
    eq(smsImportRefs.platformId, reference.platformId),
    eq(smsImportRefs.status, 'review'),
    isNull(smsImportRefs.transactionId),
    eq(smsImportRefs.receivedAt, reference.receivedAt),
    eq(smsImportRefs.senderHash, reference.senderHash),
    eq(smsImportRefs.bodyHash, reference.bodyHash),
    eq(smsImportRefs.keyId, reference.keyId),
  )).returning({ referenceId: smsImportRefs.referenceId }).all();
  return rows.length === 1;
}

/** Process only bounded, already-read Android rows. Raw SMS text remains in memory. */
export function createSmsIngestion(
  client: LedgerSQLiteClient,
  migrations: LedgerMigrations,
  fingerprints: FingerprintKeyProvider | undefined,
  runTransaction: LedgerSQLiteTransactionRunner | undefined,
) {
  const readLedger = createLedger(client, migrations);
  return {
    async getSmsImportCursor(): Promise<SmsCursor | null> {
      const state = await readLedger.db.select().from(smsImportState).where(eq(smsImportState.id, 1)).get();
      return currentCursor(state);
    },
    async getSmsImportHealth(): Promise<SmsImportHealth> {
      const counts = await readLedger.db.select({
        completionValue: sql<string | null>`(
          select ${preferences.value} from ${preferences}
          where ${preferences.key} = ${smsCatchupCompletionPreference}
        )`,
        pendingReviewCount: count(),
        nonPostedReviewCount: count(sql`case when ${smsImportRefs.reason} = 'non_posted' then 1 end`),
      }).from(smsImportRefs).where(eq(smsImportRefs.status, 'review')).get();
      validateSmsReviewCounts(counts);
      return {
        lastSuccessfulCatchupAt: parseStoredCatchupCompletion(counts.completionValue ?? undefined),
        pendingReviewCount: counts.pendingReviewCount,
        nonPostedReviewCount: counts.nonPostedReviewCount,
      };
    },
    async getSmsReviewPage(options: SmsReviewPageOptions = {}): Promise<SmsReviewPage> {
      validateReviewPageOptions(options);
      const limit = options.limit ?? maxBatchSize;
      const after = options.after ?? null;
      const reviewFilter = eq(smsImportRefs.status, 'review');
      const afterFilter = after === null ? undefined : or(
        gt(smsImportRefs.receivedAt, after.receivedAt),
        and(
          eq(smsImportRefs.receivedAt, after.receivedAt),
          or(
            gt(sql`length(${smsImportRefs.platformId})`, after.platformId.length),
            and(eq(sql`length(${smsImportRefs.platformId})`, after.platformId.length), gt(smsImportRefs.platformId, after.platformId)),
            and(eq(smsImportRefs.platformId, after.platformId), gt(smsImportRefs.referenceId, after.referenceId)),
          ),
        ),
      );
      const selected = await readLedger.db.select({
        referenceId: smsImportRefs.referenceId,
        platformId: smsImportRefs.platformId,
        receivedAt: smsImportRefs.receivedAt,
        reason: smsImportRefs.reason,
        ruleId: smsImportRefs.ruleId,
        ruleVersion: smsImportRefs.ruleVersion,
      }).from(smsImportRefs)
        .where(afterFilter ? and(reviewFilter, afterFilter) : reviewFilter)
        .orderBy(asc(smsImportRefs.receivedAt), asc(sql`length(${smsImportRefs.platformId})`), asc(smsImportRefs.platformId), asc(smsImportRefs.referenceId))
        .limit(limit + 1).all();
      const hasMore = selected.length > limit;
      const rows = selected.slice(0, limit);
      if (!hasMore) return { rows };
      const last = rows[rows.length - 1]!;
      return { rows, nextCursor: { receivedAt: last.receivedAt, platformId: last.platformId, referenceId: last.referenceId } };
    },
    async prepareSmsReview(referenceId: string, readOriginal: SmsOriginalReader): Promise<SmsReviewPreparation> {
      assertReferenceId(referenceId);
      if (typeof readOriginal !== 'function') throw new TypeError('An Android SMS source reader is required');
      return (await prepareSmsReviewForLedger(readLedger, fingerprints, referenceId, readOriginal)).result;
    },
    async confirmSmsReview(
      referenceId: string,
      expectedPreparation: SmsReviewPreparation,
      readOriginal: SmsOriginalReader,
      corrections: ReviewCorrections = {},
      options: SmsReviewConfirmationOptions = {},
    ): Promise<SmsReviewConfirmationResult> {
      assertReferenceId(referenceId);
      if (typeof readOriginal !== 'function') throw new TypeError('An Android SMS source reader is required');
      const expectedSnapshot = validateExpectedPreparation(referenceId, expectedPreparation);
      const checkedCorrections = snapshotCorrections(corrections);
      const checkedOptions = validateConfirmationOptions(options);
      const expectedReady = expectedPreparation as Extract<SmsReviewPreparation, { kind: 'ready' }>;
      const expectedWeak = expectedReady.preparation.identity.dedupeKey.startsWith('body:');
      if (checkedOptions.separatePayment && (!expectedWeak || expectedReady.preparation.candidate?.upiRef || checkedCorrections.upiRef)) {
        throw new TypeError('Only a weak SMS identity without a payment reference can be confirmed as separate');
      }
      assertValidReviewedSmsTransaction(correctedSmsTransaction(referenceId, expectedReady.preparation, checkedCorrections, null));
      const unavailable = (reason: SmsReviewConfirmationUnavailableReason): SmsReviewConfirmationResult => ({
        kind: 'unavailable', referenceId, platformId: expectedReady.platformId, reason,
      });
      if (!runTransaction) return unavailable('transaction_unavailable');

      let checked: SmsReviewCheck;
      try { checked = await prepareSmsReviewForLedger(readLedger, fingerprints, referenceId, readOriginal); }
      catch (error) {
        if (isAbortError(error)) throw error;
        return unavailable('storage_unavailable');
      }
      if (!('reference' in checked)) return checked.result;
      if (smsReviewSnapshot(referenceId, checked.result) !== expectedSnapshot) return unavailable('stale_preparation');

      let result: SmsReviewConfirmationResult | undefined;
      try {
        await runTransaction(async (transaction) => {
          const ledger = createLedger(transaction, migrations);
          const currentReference = await ledger.db.select().from(smsImportRefs)
            .where(eq(smsImportRefs.referenceId, referenceId)).get();
          const referenceFailure = smsReviewReferenceFailure(currentReference, checked.reference);
          if (referenceFailure) {
            result = unavailable(referenceFailure);
            return;
          }
          const initialKeyFailure = await smsReviewKeyFailure(ledger, fingerprints, checked.reference.keyId);
          if (initialKeyFailure) {
            result = unavailable(initialKeyFailure);
            return;
          }
          const sourceFailure = await smsReviewSourceFailure(readOriginal, checked.source);
          if (sourceFailure) {
            result = unavailable(sourceFailure);
            return;
          }
          const finalReference = await ledger.db.select().from(smsImportRefs)
            .where(eq(smsImportRefs.referenceId, referenceId)).get();
          const finalReferenceFailure = smsReviewReferenceFailure(finalReference, checked.reference);
          if (finalReferenceFailure) {
            result = unavailable(finalReferenceFailure);
            return;
          }
          const finalKeyFailure = await smsReviewKeyFailure(ledger, fingerprints, checked.reference.keyId);
          if (finalKeyFailure) {
            result = unavailable(finalKeyFailure);
            return;
          }
          const preparation = checked.result.preparation;
          const isWeak = preparation.identity.dedupeKey.startsWith('body:');

          const accountId = checkedCorrections.accountId === undefined
            ? await resolveAccount(ledger, preparation.ruleId, preparation.candidate)
            : checkedCorrections.accountId;
          const reviewed = correctedSmsTransaction(referenceId, preparation, checkedCorrections, accountId ?? null);
          const canonical = await ledger.db.select().from(transactions).where(eq(transactions.id, reviewed.id)).get();
          if (canonical) {
            const isSameSms = canonical.source === 'sms' && canonical.smsRefId === reviewed.smsRefId &&
              canonical.dedupeKey === reviewed.dedupeKey && canonical.bodyHash === reviewed.bodyHash;
            if (!isSameSms) {
              result = unavailable('ambiguous_overlap');
              return;
            }
            if (!await resolveReviewReference(ledger, checked.reference, preparation, 'saved', canonical.id)) {
              result = unavailable('not_pending');
              return;
            }
            result = { kind: 'saved', referenceId, platformId: checked.reference.platformId, transactionId: canonical.id };
            return;
          }

          const overlaps = await ledger.db.select().from(transactions)
            .where(eq(transactions.dedupeKey, reviewed.dedupeKey)).all();
          if (isWeak) {
            if (overlaps.length > 0 && !checkedOptions.separatePayment) {
              result = unavailable('ambiguous_overlap');
              return;
            }
            if (overlaps.length === 0 && checkedOptions.separatePayment) {
              result = unavailable('ambiguous_overlap');
              return;
            }
          }

          if (!isWeak && overlaps.length > 0) {
            const existing = overlaps[0]!;
            const coherent = overlaps.length === 1 &&
              (existing.bodyHash === reviewed.bodyHash || sameTransactionEvidence(existing, reviewed));
            if (!coherent) {
              result = unavailable('ambiguous_overlap');
              return;
            }
            if (!await resolveReviewReference(ledger, checked.reference, preparation, 'duplicate', existing.id)) {
              result = unavailable('not_pending');
              return;
            }
            result = { kind: 'duplicate', referenceId, platformId: checked.reference.platformId, transactionId: existing.id };
            return;
          }

          let inserted: boolean;
          try {
            inserted = await ledger.insertReviewedSmsTransaction(reviewed);
          } catch (error) {
            if (!(error instanceof InvalidTransactionReferenceError)) throw error;
            result = unavailable('invalid_correction');
            return;
          }
          if (!inserted) {
            result = unavailable('ambiguous_overlap');
            return;
          }
          if (!await resolveReviewReference(ledger, checked.reference, preparation, 'saved', reviewed.id)) {
            throw new Error('SMS review reference changed during confirmation');
          }
          result = { kind: 'saved', referenceId, platformId: checked.reference.platformId, transactionId: reviewed.id };
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        return unavailable('storage_unavailable');
      }
      return result ?? unavailable('storage_unavailable');
    },
    async importSmsBatch(
      batch: SmsInboxRow[],
      expectedCursor: SmsCursor | null,
      options: SmsImportBatchOptions = {},
    ): Promise<SmsImportBatchResult> {
      const checkedOptions = snapshotSmsImportBatchOptions(options);
      const catchupCompletedAt = checkedOptions.catchupCompletedAt;
      const assertSourceAccess = checkedOptions.assertSourceAccess;
      assertCursor(expectedCursor, 'expectedCursor');
      validateBatch(batch, checkedOptions.replayAfter === undefined ? expectedCursor : checkedOptions.replayAfter);
      const rows = batch.map(({ platformId, sender, body, receivedAt }) => ({ platformId, sender, body, receivedAt }));
      const checkedExpectedCursor = expectedCursor === null ? null : { ...expectedCursor };
      if (!runTransaction) throw new Error('Android SMS import transactions are unavailable on this platform');

      type PreparedSmsImportRow =
        | { kind: 'unreadable'; row: SmsInboxRow; bodyHash: string; sourceHash: string; senderHash: string; referenceId: string }
        | { kind: 'ignored'; row: SmsInboxRow; bodyHash: string; senderHash: string }
        | {
            kind: 'prepared';
            row: SmsInboxRow;
            parsed: ReturnType<typeof parseSms>;
            preparation: Extract<PastePreparation, { kind: 'needs-review' }>;
            senderHash: string;
            referenceId: string;
          };
      const preparedRows: PreparedSmsImportRow[] = [];
      let preparedKeyId: string | undefined;

      if (rows.length > 0) {
        let initialFingerprinter: Fingerprinter | undefined;
        await runTransaction(async (transaction) => {
          const ledger = createLedger(transaction, migrations);
          try {
            await assertSourceAccess?.();
            const state = await ledger.db.select().from(smsImportState).where(eq(smsImportState.id, 1)).get();
            const cursor = currentCursor(state);
            if ((cursor?.receivedAt ?? null) !== (checkedExpectedCursor?.receivedAt ?? null) ||
                (cursor?.platformId ?? null) !== (checkedExpectedCursor?.platformId ?? null)) {
              throw new StaleSmsCursorError();
            }

            if (fingerprints && (await getFingerprintKeyPolicy(ledger)).allowCreate) {
              try { initialFingerprinter = await fingerprints({ allowCreate: true }); }
              catch (error) { throw safeFingerprintFailure(error); }
              if (!/^[a-f0-9]{64}$/.test(initialFingerprinter.keyId)) {
                throw new TypeError('Invalid fingerprint key identifier');
              }
            }
          } finally {
            await assertSourceAccess?.();
          }
        });

        if (!fingerprints) throw new Error('A platform fingerprint provider is required for SMS imports');
        let preparationFingerprinter = initialFingerprinter;
        if (!preparationFingerprinter) {
          try { preparationFingerprinter = await fingerprints({ allowCreate: false }); }
          catch (error) { throw safeFingerprintFailure(error); }
        }
        if (!/^[a-f0-9]{64}$/.test(preparationFingerprinter.keyId)) {
          throw new TypeError('Invalid fingerprint key identifier');
        }
        preparedKeyId = preparationFingerprinter.keyId;

        for (const row of rows) {
          await assertSourceAccess?.();
          const normalizedSender = row.sender.trim().toUpperCase();
          if (row.sender.trim().length === 0 || row.sender.length > maxSenderLength ||
              row.body.trim().length === 0 || row.body.length > maxBodyLength) {
            let bodyHash: string;
            let sourceHash: string;
            let senderHash: string;
            let referenceId: string;
            try {
              bodyHash = await keyedFingerprint(preparationFingerprinter, ['body', row.body]);
              [sourceHash, senderHash] = await Promise.all([
                keyedFingerprint(preparationFingerprinter, ['sms', normalizedSender, row.body]),
                keyedFingerprint(preparationFingerprinter, ['sender', normalizedSender]),
              ]);
              referenceId = await smsSourceReferenceId(preparationFingerprinter, row, bodyHash);
            } catch (error) {
              throw safeFingerprintFailure(error);
            }
            await assertSourceAccess?.();
            preparedRows.push({ kind: 'unreadable', row, bodyHash, sourceHash, senderHash, referenceId });
            continue;
          }

          let parsed: ReturnType<typeof parseSms>;
          let preparation: PastePreparation;
          try {
            parsed = parseSms(row);
            preparation = await preparePastedSms(row, preparationFingerprinter);
          } catch (error) {
            throw safeFingerprintFailure(error);
          }
          if (preparation.kind === 'ignored') {
            let bodyHash: string;
            let senderHash: string;
            try {
              [bodyHash, senderHash] = await Promise.all([
                keyedFingerprint(preparationFingerprinter, ['body', row.body]),
                keyedFingerprint(preparationFingerprinter, ['sender', normalizedSender]),
              ]);
            } catch (error) {
              throw safeFingerprintFailure(error);
            }
            await assertSourceAccess?.();
            preparedRows.push({ kind: 'ignored', row, bodyHash, senderHash });
            continue;
          }

          let senderHash: string;
          let referenceId: string;
          try {
            [senderHash, referenceId] = await Promise.all([
              keyedFingerprint(preparationFingerprinter, ['sender', normalizedSender]),
              smsSourceReferenceId(preparationFingerprinter, row, preparation.identity.bodyHash),
            ]);
          } catch (error) {
            throw safeFingerprintFailure(error);
          }
          await assertSourceAccess?.();
          preparedRows.push({ kind: 'prepared', row, parsed, preparation, senderHash, referenceId });
        }
      }

      let result: SmsImportBatchResult | undefined;
      await runTransaction(async (transaction) => {
        const ledger = createLedger(transaction, migrations);
        const saveCompletion = async () => {
          if (catchupCompletedAt === undefined) return;
          const completedAt = typeof catchupCompletedAt === 'function' ? catchupCompletedAt() : catchupCompletedAt;
          if (!Number.isSafeInteger(completedAt) || completedAt <= 0) {
            throw new TypeError('catchupCompletedAt must be a positive safe integer');
          }
          await saveCatchupCompletion(ledger, completedAt);
        };
        try {
          await assertSourceAccess?.();
          const state = await ledger.db.select().from(smsImportState).where(eq(smsImportState.id, 1)).get();
          const cursor = currentCursor(state);
          if ((cursor?.receivedAt ?? null) !== (checkedExpectedCursor?.receivedAt ?? null) ||
              (cursor?.platformId ?? null) !== (checkedExpectedCursor?.platformId ?? null)) {
            throw new StaleSmsCursorError();
          }

          result = { cursor, inserted: 0, duplicate: 0, review: 0, ignored: 0 };
          if (rows.length === 0) {
            if (catchupCompletedAt !== undefined && !(await getFingerprintKeyPolicy(ledger)).allowCreate) {
              if (!fingerprints) throw new Error('A platform fingerprint provider is required for SMS imports');
              let fingerprinter: Fingerprinter;
              try { fingerprinter = await fingerprints({ allowCreate: false }); }
              catch (error) { throw safeFingerprintFailure(error); }
              if (!/^[a-f0-9]{64}$/.test(fingerprinter.keyId)) throw new TypeError('Invalid fingerprint key identifier');
              if (state && state.keyId !== fingerprinter.keyId) throw new DuplicateReviewRequiredError();
              if (await requiresDuplicateReview(ledger, fingerprinter.keyId)) throw new DuplicateReviewRequiredError();
            }
            await saveCompletion();
            return;
          }
          if (!fingerprints || preparedKeyId === undefined || preparedRows.length !== rows.length) {
            throw new Error('SMS import preparation is unavailable');
          }
          let fingerprinter: Fingerprinter;
          try { fingerprinter = await fingerprints({ allowCreate: false }); }
          catch (error) { throw safeFingerprintFailure(error); }
          if (!/^[a-f0-9]{64}$/.test(fingerprinter.keyId)) throw new TypeError('Invalid fingerprint key identifier');
          if (fingerprinter.keyId !== preparedKeyId) throw new DuplicateReviewRequiredError();
          if (state && state.keyId !== fingerprinter.keyId) throw new DuplicateReviewRequiredError();
          if (await requiresDuplicateReview(ledger, fingerprinter.keyId) ||
              !await fingerprintHistoryMatches(ledger, fingerprinter.keyId)) {
            throw new DuplicateReviewRequiredError();
          }

          for (const preparedRow of preparedRows) {
            const { row } = preparedRow;
            if (preparedRow.kind === 'unreadable') {
              const { bodyHash, sourceHash, senderHash, referenceId } = preparedRow;
              const prior = await findSmsSourceReference(ledger, row, bodyHash);
              if (prior) {
                if (prior.senderHash !== senderHash || prior.keyId !== fingerprinter.keyId) {
                  throw new Error('A previously imported SMS row changed; import stopped for review');
                }
                result.duplicate += 1;
              } else {
                await writeReference(ledger, referenceId, row, fingerprinter, senderHash, {
                  identity: { dedupeKey: `body:${sourceHash}`, bodyHash },
                  ruleId: null,
                  ruleVersion: null,
                }, 'review', 'unreadable_source', null);
                result.review += 1;
              }
              continue;
            }

            if (preparedRow.kind === 'ignored') {
              const priorAtPlatformDate = await ledger.db.select({ referenceId: smsImportRefs.referenceId })
                .from(smsImportRefs).where(and(
                  eq(smsImportRefs.platformId, row.platformId),
                  eq(smsImportRefs.receivedAt, row.receivedAt),
                )).limit(1).get();
              if (priorAtPlatformDate) {
                const prior = await findSmsSourceReference(ledger, row, preparedRow.bodyHash);
                if (prior) {
                  if (prior.senderHash !== preparedRow.senderHash || prior.keyId !== fingerprinter.keyId) {
                    throw new Error('A previously imported SMS row changed; import stopped for review');
                  }
                }
              }
              result.ignored += 1;
              continue;
            }

            const { parsed, preparation, senderHash, referenceId } = preparedRow;
            const prior = await findSmsSourceReference(ledger, row, preparation.identity.bodyHash);
            if (prior) {
              // Parser-derived identity can change; replay depends on the unchanged source.
              if (prior.senderHash !== senderHash || prior.keyId !== fingerprinter.keyId) {
                throw new Error('A previously imported SMS row changed; import stopped for review');
              }
              result.duplicate += 1;
              continue;
            }

            const candidate = preparation.candidate;
            const accountId = await resolveAccount(ledger, preparation.ruleId, candidate);
            const reason = getReviewReason(parsed, candidate, accountId, preparation.identity.dedupeKey);
            const strongIdentity = preparation.identity.dedupeKey.startsWith('upi:');
            if (strongIdentity) {
              const matches = await ledger.db.select().from(transactions)
                .where(eq(transactions.dedupeKey, preparation.identity.dedupeKey)).all();
              if (matches.length > 0) {
                const coherent = matches.length === 1 && candidate !== null && candidate.status === 'posted' &&
                  Number.isSafeInteger(candidate.amountPaise) && candidate.amountPaise > 0 &&
                  (matches[0]!.bodyHash === preparation.identity.bodyHash || matchingEvidence(matches[0]!, candidate, accountId));
                if (coherent) {
                  await writeReference(ledger, referenceId, row, fingerprinter, senderHash, preparation, 'duplicate', null, matches[0]!.id);
                  result.duplicate += 1;
                } else {
                  await writeReference(ledger, referenceId, row, fingerprinter, senderHash, preparation, 'review',
                    matches.length > 1 ? 'ambiguous_evidence' : 'inconsistent_evidence', null);
                  result.review += 1;
                }
                continue;
              }
            } else {
              const weakMatch = await ledger.db.select({ id: transactions.id }).from(transactions)
                .where(eq(transactions.dedupeKey, preparation.identity.dedupeKey)).limit(1).get();
              if (weakMatch) {
                await writeReference(ledger, referenceId, row, fingerprinter, senderHash, preparation, 'review', 'weak_overlap', null);
                result.review += 1;
                continue;
              }
            }

            if (reason) {
              await writeReference(ledger, referenceId, row, fingerprinter, senderHash, preparation, 'review', reason, null);
              result.review += 1;
              continue;
            }

            if (!candidate || parsed.kind !== 'transaction') throw new Error('Verified SMS transaction data is incomplete');
            const transactionId = `sms:${referenceId}`;
            const saved = await ledger.upsertImportedTransaction({
              id: transactionId,
              amountPaise: candidate.amountPaise,
              direction: candidate.direction,
              kind: candidate.kind,
              status: 'posted',
              accountId,
              counterparty: candidate.counterparty,
              merchantId: null,
              categoryId: null,
              occurredAt: new Date(candidate.occurredAt),
              note: null,
              source: 'sms',
              smsRefId: `android-sms:${referenceId}`,
              upiRef: candidate.upiRef,
              dedupeKey: preparation.identity.dedupeKey,
              bodyHash: preparation.identity.bodyHash,
              ruleId: parsed.ruleId,
              ruleVersion: parsed.ruleVersion,
              linkedTxnId: null,
              excludeFromStats: false,
            });
            if (!saved) {
              await writeReference(ledger, referenceId, row, fingerprinter, senderHash, preparation, 'review', 'inconsistent_evidence', null);
              result.review += 1;
              continue;
            }
            await writeReference(ledger, referenceId, row, fingerprinter, senderHash, preparation, 'saved', null, transactionId);
            result.inserted += 1;
          }

          const last = rows[rows.length - 1]!;
          const lastCursor = { receivedAt: last.receivedAt, platformId: last.platformId };
          const nextCursor = checkedOptions.replayAfter !== undefined && cursor && compareCursor(cursor, lastCursor) > 0
            ? cursor
            : lastCursor;
          if (state) {
            await ledger.db.update(smsImportState).set({
              cursorReceivedAt: nextCursor.receivedAt,
              cursorPlatformId: nextCursor.platformId,
              keyId: fingerprinter.keyId,
            }).where(eq(smsImportState.id, 1)).run();
          } else {
            await ledger.db.insert(smsImportState).values({
              id: 1,
              cursorReceivedAt: nextCursor.receivedAt,
              cursorPlatformId: nextCursor.platformId,
              keyId: fingerprinter.keyId,
            }).run();
          }
          result.cursor = nextCursor;
          await saveCompletion();
        } finally {
          // A failed final check intentionally takes precedence over a writer error so revocation wins.
          await assertSourceAccess?.();
        }
      });

      if (!result) throw new Error('SMS import transaction completed without a result');
      return result;
    },
  };
}
