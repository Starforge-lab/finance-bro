import type { SmsInboxMessage } from '../modules/sms-reader';
import { eq } from 'drizzle-orm';
import { createLedger, type LedgerMigrations, type LedgerSQLiteClient } from '../src/db/ledger';
import type { Fingerprinter } from '../src/imports/fingerprint';
import { preparePastedSms } from '../src/imports/paste';
import { transactions } from '../src/db/schema';

const message: SmsInboxMessage = {
  id: '9007199254740993',
  dateMs: Date.parse('2026-10-10T12:00:00.000Z'),
  sender: 'VM-HDFCBK-S',
  body: 'Rs.450.00 debited from A/c XX1234 to SWIGGY merchant@okaxis. UPI Ref 612345678901.',
};

function expect(value: unknown, check: string): asserts value {
  if (!value) throw new Error(`SMS runtime check failed: ${check}`);
}

/** Fictional probe only: not a production ingestion or eligibility policy. */
export async function runSmsRuntimeCheck(
  client: LedgerSQLiteClient, migrations: LedgerMigrations, fingerprinter: Fingerprinter,
) {
  const ledger = createLedger(client, migrations);
  await ledger.migrateLedger();
  const prepared = await preparePastedSms({
    sender: message.sender, body: message.body, receivedAt: message.dateMs,
  }, fingerprinter);
  expect(prepared.kind === 'needs-review' && prepared.candidate && prepared.ruleId && prepared.ruleVersion,
    'fictional-parser-handoff');
  const candidate = prepared.candidate;
  expect(candidate.amountPaise === 45000, 'exact-paise');
  expect(candidate.direction === 'debit' && candidate.kind === 'expense' &&
    candidate.status === 'posted' && candidate.occurredAt === message.dateMs, 'transaction-semantics');
  const input = {
    id: `sms-probe:${message.id}`, source: 'sms' as const, smsRefId: message.id,
    amountPaise: candidate.amountPaise, direction: candidate.direction,
    kind: candidate.kind, status: candidate.status, occurredAt: new Date(candidate.occurredAt),
    dedupeKey: prepared.identity.dedupeKey, bodyHash: prepared.identity.bodyHash,
    ruleId: prepared.ruleId, ruleVersion: prepared.ruleVersion,
  };
  expect(await ledger.upsertImportedTransaction(input), 'save-fictional-sms');
  let row = await ledger.db.select().from(transactions).where(eq(transactions.id, input.id)).get();
  expect(row?.smsRefId === message.id && row.amountPaise === 45000, 'string-platform-id');
  expect(/^[a-f0-9]{64}$/.test(row.bodyHash ?? '') && !JSON.stringify(row).includes(message.body),
    'no-persisted-body');
  expect(await ledger.editTransaction(input.id, { amountPaise: 46000 }), 'user-correction');
  expect(!await ledger.upsertImportedTransaction(input), 'preserve-correction-on-replay');
  row = await ledger.db.select().from(transactions).where(eq(transactions.id, input.id)).get();
  expect(row?.amountPaise === 46000, 'corrected-paise');
  expect(await ledger.softDeleteTransaction(input.id), 'user-deletion');
  expect(!await ledger.upsertImportedTransaction(input), 'preserve-tombstone-on-replay');
  return { passed: true, checks: ['parser-handoff', 'exact-paise', 'string-platform-id',
    'no-persisted-body', 'correction-replay', 'tombstone-replay'] };
}
