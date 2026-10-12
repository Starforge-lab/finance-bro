import { and, eq } from 'drizzle-orm';
import { parseSms, type ParsedTxn, type RawSms } from '@finance-bro/sms-parser';
import { createLedger, type LedgerMigrations, type LedgerSQLiteClient, type LedgerSQLiteTransactionRunner } from '../db/ledger';
import { accounts, smsImportRefs, smsImportState, transactions } from '../db/schema';
import { DuplicateReviewRequiredError, getFingerprintKeyPolicy, requiresDuplicateReview } from './key-state';
import { preparePastedSms } from './paste';
import type { FingerprintKeyProvider, Fingerprinter } from './fingerprint';

const maxBatchSize = 100;
const maxBodyLength = 16_384;
const maxSenderLength = 256;
const maxPlatformId = 9_223_372_036_854_775_807n;
const verifiedRuleVersions: Readonly<Record<string, number>> = {};

export type SmsCursor = { receivedAt: number; platformId: string };
export type SmsInboxRow = RawSms & { platformId: string };
export type SmsImportBatchResult = {
  cursor: SmsCursor | null;
  inserted: number;
  duplicate: number;
  review: number;
  ignored: number;
};

type ReviewReason =
  | 'unknown_format'
  | 'non_posted'
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
    if (typeof row.sender !== 'string' || row.sender.trim().length === 0 || row.sender.length > maxSenderLength) {
      throw new TypeError(`SMS row ${index} sender is invalid`);
    }
    if (typeof row.body !== 'string' || row.body.length === 0 || row.body.length > maxBodyLength) {
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

function currentCursor(state: { cursorReceivedAt: number | null; cursorPlatformId: string | null } | undefined): SmsCursor | null {
  if (!state || state.cursorReceivedAt === null) return null;
  if (state.cursorPlatformId === null) throw new Error('Stored SMS cursor is incomplete');
  const cursor = { receivedAt: state.cursorReceivedAt, platformId: state.cursorPlatformId };
  assertCursor(cursor, 'storedCursor');
  return cursor;
}

async function resolveAccount(ledger: ReturnType<typeof createLedger>, candidate: ParsedTxn | null): Promise<string | null> {
  if (!candidate?.institution || !candidate.accountLast4) return null;
  const matches = await ledger.db.select({ id: accounts.id }).from(accounts).where(and(
    eq(accounts.institution, candidate.institution),
    eq(accounts.last4, candidate.accountLast4),
    eq(accounts.archived, false),
  )).all();
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
  row: SmsInboxRow,
  fingerprinter: Fingerprinter,
  senderHash: string,
  preparation: Extract<Awaited<ReturnType<typeof preparePastedSms>>, { kind: 'needs-review' }>,
  status: 'review' | 'saved' | 'duplicate',
  reason: ReviewReason | null,
  transactionId: string | null,
): Promise<void> {
  await ledger.db.insert(smsImportRefs).values({
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
    async importSmsBatch(batch: SmsInboxRow[], expectedCursor: SmsCursor | null): Promise<SmsImportBatchResult> {
      validateBatch(batch, expectedCursor);
      const rows = batch.map(({ platformId, sender, body, receivedAt }) => ({ platformId, sender, body, receivedAt }));
      const checkedExpectedCursor = expectedCursor === null ? null : { ...expectedCursor };
      if (!runTransaction) throw new Error('Android SMS import transactions are unavailable on this platform');

      let result: SmsImportBatchResult | undefined;
      await runTransaction(async (transaction) => {
        const ledger = createLedger(transaction, migrations);
        const state = await ledger.db.select().from(smsImportState).where(eq(smsImportState.id, 1)).get();
        const cursor = currentCursor(state);
        if ((cursor?.receivedAt ?? null) !== (checkedExpectedCursor?.receivedAt ?? null) ||
            (cursor?.platformId ?? null) !== (checkedExpectedCursor?.platformId ?? null)) {
          throw new Error('SMS import cursor is stale; reload the current cursor before retrying');
        }

        result = { cursor, inserted: 0, duplicate: 0, review: 0, ignored: 0 };
        if (rows.length === 0) return;
        if (!fingerprints) throw new Error('A platform fingerprint provider is required for SMS imports');
        const fingerprinter = await fingerprints(await getFingerprintKeyPolicy(ledger));
        if (!/^[a-f0-9]{64}$/.test(fingerprinter.keyId)) throw new TypeError('Invalid fingerprint key identifier');
        if (state && state.keyId !== fingerprinter.keyId) throw new DuplicateReviewRequiredError();
        if (await requiresDuplicateReview(ledger, fingerprinter.keyId)) throw new DuplicateReviewRequiredError();

        for (const row of rows) {
          const parsed = parseSms(row);
          const prepared = await preparePastedSms(row, fingerprinter);
          if (prepared.kind === 'ignored') {
            const prior = await ledger.db.select({ platformId: smsImportRefs.platformId }).from(smsImportRefs)
              .where(eq(smsImportRefs.platformId, row.platformId)).get();
            if (prior) throw new Error('A previously imported SMS row changed; import stopped for review');
            result.ignored += 1;
            continue;
          }

          const senderHash = await fingerprinter.fingerprint(JSON.stringify(['sender', row.sender.trim().toUpperCase()]));
          if (!/^[a-f0-9]{64}$/.test(senderHash)) throw new TypeError('Invalid keyed sender fingerprint');
          const prior = await ledger.db.select().from(smsImportRefs)
            .where(eq(smsImportRefs.platformId, row.platformId)).get();
          if (prior) {
            // Parser-derived identity can change; replay depends on the unchanged source.
            if (prior.receivedAt !== row.receivedAt ||
                prior.bodyHash !== prepared.identity.bodyHash || prior.senderHash !== senderHash ||
                prior.keyId !== fingerprinter.keyId) {
              throw new Error('A previously imported SMS row changed; import stopped for review');
            }
            result.duplicate += 1;
            continue;
          }

          const candidate = prepared.candidate;
          const accountId = await resolveAccount(ledger, candidate);
          const reason = getReviewReason(parsed, candidate, accountId, prepared.identity.dedupeKey);
          const strongIdentity = prepared.identity.dedupeKey.startsWith('upi:');
          if (strongIdentity) {
            const matches = await ledger.db.select().from(transactions)
              .where(eq(transactions.dedupeKey, prepared.identity.dedupeKey)).all();
            if (matches.length > 0) {
              const coherent = matches.length === 1 && candidate !== null && candidate.status === 'posted' &&
                Number.isSafeInteger(candidate.amountPaise) && candidate.amountPaise > 0 &&
                (matches[0]!.bodyHash === prepared.identity.bodyHash || matchingEvidence(matches[0]!, candidate, accountId));
              if (coherent) {
                await writeReference(ledger, row, fingerprinter, senderHash, prepared, 'duplicate', null, matches[0]!.id);
                result.duplicate += 1;
              } else {
                await writeReference(ledger, row, fingerprinter, senderHash, prepared, 'review',
                  matches.length > 1 ? 'ambiguous_evidence' : 'inconsistent_evidence', null);
                result.review += 1;
              }
              continue;
            }
          } else {
            const weakMatch = await ledger.db.select({ id: transactions.id }).from(transactions)
              .where(eq(transactions.dedupeKey, prepared.identity.dedupeKey)).limit(1).get();
            if (weakMatch) {
              await writeReference(ledger, row, fingerprinter, senderHash, prepared, 'review', 'weak_overlap', null);
              result.review += 1;
              continue;
            }
          }

          if (reason) {
            await writeReference(ledger, row, fingerprinter, senderHash, prepared, 'review', reason, null);
            result.review += 1;
            continue;
          }

          if (!candidate || parsed.kind !== 'transaction') throw new Error('Verified SMS transaction data is incomplete');
          const transactionId = `sms:${row.platformId}`;
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
            smsRefId: `android-sms:${row.platformId}`,
            upiRef: candidate.upiRef,
            dedupeKey: prepared.identity.dedupeKey,
            bodyHash: prepared.identity.bodyHash,
            ruleId: parsed.ruleId,
            ruleVersion: parsed.ruleVersion,
            linkedTxnId: null,
            excludeFromStats: false,
          });
          if (!saved) {
            await writeReference(ledger, row, fingerprinter, senderHash, prepared, 'review', 'inconsistent_evidence', null);
            result.review += 1;
            continue;
          }
          await writeReference(ledger, row, fingerprinter, senderHash, prepared, 'saved', null, transactionId);
          result.inserted += 1;
        }

        const last = rows[rows.length - 1]!;
        const nextCursor = { receivedAt: last.receivedAt, platformId: last.platformId };
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
      });

      if (!result) throw new Error('SMS import transaction completed without a result');
      return result;
    },
  };
}
