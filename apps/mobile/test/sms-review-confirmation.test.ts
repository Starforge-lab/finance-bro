/// <reference types="node" />

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import type { LedgerSQLiteClient, LedgerSQLiteTransactionRunner } from '../src/db/ledger';
import { FingerprintKeyUnavailableError } from '../src/imports/fingerprint';
import type { FingerprintKeyPolicy, FingerprintKeyProvider, Fingerprinter } from '../src/imports/fingerprint';
import type { ReviewCorrections } from '../src/imports/paste';
import type { SmsInboxRow, SmsReviewPreparation } from '../src/imports/sms';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';

const strongSms = {
  sender: 'VM-HDFCBK-S',
  body: 'INR 450.00 debited from A/c XX1234 to VPA fictional@axisbank (UPI Ref No 612345678901).',
  receivedAt: Date.parse('2026-10-07T10:00:00.000Z'),
};
const weakSms = {
  sender: 'VM-HDFCBK-S',
  body: 'INR 450.00 debited from A/c XX1234 at a fictional shop.',
  receivedAt: Date.parse('2026-10-07T10:00:00.000Z'),
};
const fixtureSecret = 'fictional-sms-confirmation-key';

function fingerprinter(secret = fixtureSecret): Fingerprinter {
  return {
    keyId: createHmac('sha256', secret).update('fictional-key-id').digest('hex'),
    async fingerprint(value) { return createHmac('sha256', secret).update(value).digest('hex'); },
  };
}

function transactionRunner(sqlite: DatabaseSync, client: LedgerSQLiteClient): LedgerSQLiteTransactionRunner {
  let tail = Promise.resolve();
  return async (task) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      sqlite.exec('BEGIN IMMEDIATE');
      try { await task(client); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } finally { release(); }
  };
}

async function fixture(rows: SmsInboxRow[] = [{ ...strongSms, platformId: '72' }], key = fingerprinter()) {
  const test = openTestLedger();
  const policies: FingerprintKeyPolicy[] = [];
  const provider: FingerprintKeyProvider = async (policy) => {
    if (policy) policies.push(policy);
    return key;
  };
  const runner = transactionRunner(test.sqlite, test.client);
  const api = createDataLayer(test.client, ledgerMigrations, provider, runner);
  await api.migrateLedger();
  await api.importSmsBatch(rows, null);
  return { ...test, api, key, policies, provider, runner };
}

async function ready(api: ReturnType<typeof createDataLayer>, row: SmsInboxRow): Promise<Extract<SmsReviewPreparation, { kind: 'ready' }>> {
  const selected = (await api.getSmsReviewPage()).rows.find((item) => item.platformId === row.platformId && item.receivedAt === row.receivedAt);
  if (!selected) throw new Error('Expected the SMS source to appear in review');
  const result = await api.prepareSmsReview(selected.referenceId, async (id) => {
    assert.equal(id, row.platformId);
    return { ...row };
  });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') throw new Error('Expected a fresh selected-SMS preparation');
  return result;
}

function confirm(
  api: ReturnType<typeof createDataLayer>,
  referenceId: string,
  expected: Extract<SmsReviewPreparation, { kind: 'ready' }>,
  readOriginal: (id: string) => Promise<SmsInboxRow | null>,
  corrections: ReviewCorrections = {},
  options?: { separatePayment?: boolean },
): Promise<unknown> {
  const method = Reflect.get(api, 'confirmSmsReview') as (...args: unknown[]) => Promise<unknown>;
  assert.equal(typeof method, 'function', 'DataLayer must expose confirmSmsReview');
  return method.call(api, referenceId, expected, readOriginal, corrections, options);
}

function totalChanges(sqlite: DatabaseSync): number {
  return (sqlite.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
}

describe('selected Android SMS review confirmation', () => {
  it('applies validated corrections and resolves the reference atomically without moving the cursor', async () => {
    const row = { ...strongSms, platformId: '72' };
    const test = await fixture([row]);
    try {
      const expected = await ready(test.api, row);
      test.policies.length = 0;
      const initialCursor = await test.api.getSmsImportCursor();
      test.sqlite.exec(`CREATE TRIGGER fail_confirmation_link BEFORE UPDATE OF status ON sms_import_refs
        WHEN OLD.platform_id = '72' AND NEW.status = 'saved'
        BEGIN SELECT RAISE(ABORT, 'FICTIONAL_PRIVATE_WRITE_FAILURE'); END`);

      const failed = await confirm(test.api, expected.referenceId, expected, async () => ({ ...row }), {
        amountPaise: 46_000,
        note: 'Fictional correction',
      });
      assert.deepEqual(failed, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'storage_unavailable' });
      assert.equal(await test.api.getTransaction(`sms:${expected.referenceId}`), undefined);
      assert.equal((test.sqlite.prepare('SELECT status, transaction_id FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string; transaction_id: string | null }).status, 'review');
      assert.deepEqual(await test.api.getSmsImportCursor(), initialCursor);
      assert.equal(JSON.stringify(failed).includes('FICTIONAL_PRIVATE_WRITE_FAILURE'), false);

      test.sqlite.exec('DROP TRIGGER fail_confirmation_link');
      const privateDbError = new TypeError('FICTIONAL_PRIVATE_SQLITE_DETAIL');
      const failingClient: LedgerSQLiteClient = {
        ...test.client,
        prepareAsync: (query) => {
          if (/^\s*update\s+"?sms_import_refs"?/i.test(query)) return Promise.reject(privateDbError);
          return test.client.prepareAsync(query);
        },
      };
      const failingDbApi = createDataLayer(
        failingClient,
        ledgerMigrations,
        test.provider,
        transactionRunner(test.sqlite, failingClient),
      );
      const typedFailure = await confirm(failingDbApi, expected.referenceId, expected, async () => ({ ...row }), {
        amountPaise: 46_000,
      });
      assert.deepEqual(typedFailure, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'storage_unavailable' });
      assert.equal(JSON.stringify(typedFailure).includes(privateDbError.message), false);
      assert.equal(await test.api.getTransaction(`sms:${expected.referenceId}`), undefined);
      assert.equal((test.sqlite.prepare('SELECT status FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string }).status, 'review');
      assert.deepEqual(await test.api.getSmsImportCursor(), initialCursor);

      let sourceReads = 0;
      const read = async (id: string) => {
        sourceReads += 1;
        assert.equal(id, row.platformId);
        return { ...row };
      };
      const results = await Promise.all([
        confirm(test.api, expected.referenceId, expected, read, { amountPaise: 46_000, note: 'Fictional correction' }),
        confirm(test.api, expected.referenceId, expected, read, { amountPaise: 46_000, note: 'Fictional correction' }),
      ]);
      assert.equal(results.filter((result) => (result as { kind: string }).kind === 'saved').length, 1);
      assert.equal(results.filter((result) => (result as { kind: string }).kind === 'unavailable').length, 1);
      assert.equal(sourceReads, 1, 'the serialized replay should stop before rereading an already resolved source');
      const saved = await test.api.getTransaction(`sms:${expected.referenceId}`);
      assert.equal(saved?.amountPaise, 46_000);
      assert.equal(saved?.note, 'Fictional correction');
      assert.equal(saved?.source, 'sms');
      assert.equal(saved?.userEdited, true);
      const reference = test.sqlite.prepare('SELECT status, transaction_id FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string; transaction_id: string | null };
      assert.deepEqual({ ...reference }, { status: 'saved', transaction_id: `sms:${expected.referenceId}` });
      assert.deepEqual(await test.api.getSmsImportCursor(), initialCursor);
      assert.equal(test.policies.every((policy) => policy.allowCreate === false), true);
      for (const result of results) {
        const serialized = JSON.stringify(result);
        for (const privateValue of [row.body, row.sender, fixtureSecret]) assert.equal(serialized.includes(privateValue), false);
      }
    } finally { test.sqlite.close(); }
  });

  it('rejects a changed preparation, changed source or unavailable/swapped key before any write', async () => {
    const row = { ...strongSms, platformId: '72' };
    const test = await fixture([row]);
    try {
      const expected = await ready(test.api, row);
      const before = totalChanges(test.sqlite);
      const changedPreparation = structuredClone(expected);
      changedPreparation.preparation.candidate!.amountPaise += 100;
      const altered = await confirm(test.api, expected.referenceId, changedPreparation, async () => ({ ...row }));
      assert.deepEqual(altered, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'stale_preparation' });

      const changedSource = await confirm(test.api, expected.referenceId, expected, async () => ({ ...row, body: `${row.body} changed` }));
      assert.deepEqual(changedSource, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'source_changed' });

      let readerCalls = 0;
      const unavailableApi = createDataLayer(test.client, ledgerMigrations, async () => { throw new FingerprintKeyUnavailableError(); }, test.runner);
      const unavailable = await confirm(unavailableApi, expected.referenceId, expected, async () => {
        readerCalls += 1;
        return { ...row };
      });
      assert.deepEqual(unavailable, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'key_unavailable' });

      const swappedApi = createDataLayer(test.client, ledgerMigrations, async () => fingerprinter('different-fictional-key'), test.runner);
      const swapped = await confirm(swappedApi, expected.referenceId, expected, async () => {
        readerCalls += 1;
        return { ...row };
      });
      assert.deepEqual(swapped, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'key_unavailable' });

      const privateKeyError = new TypeError('FICTIONAL_PRIVATE_KEY_DETAIL');
      const errorKeyApi = createDataLayer(test.client, ledgerMigrations, async () => { throw privateKeyError; }, test.runner);
      const failedKey = await confirm(errorKeyApi, expected.referenceId, expected, async () => {
        readerCalls += 1;
        return { ...row };
      });
      assert.deepEqual(failedKey, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'key_unavailable' });
      assert.equal(JSON.stringify(failedKey).includes(privateKeyError.message), false);

      for (const error of [new TypeError('FICTIONAL_PRIVATE_DB_TYPE'), new RangeError('FICTIONAL_PRIVATE_DB_RANGE')]) {
        const failedRunner: LedgerSQLiteTransactionRunner = async () => { throw error; };
        const failedDbApi = createDataLayer(test.client, ledgerMigrations, test.provider, failedRunner);
        const failedDb = await confirm(failedDbApi, expected.referenceId, expected, async () => {
          readerCalls += 1;
          return { ...row };
        });
        assert.deepEqual(failedDb, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'storage_unavailable' });
        assert.equal(JSON.stringify(failedDb).includes(error.message), false);
      }
      assert.equal(readerCalls, 0);
      assert.equal(totalChanges(test.sqlite), before);
      assert.equal((test.sqlite.prepare('SELECT status FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string }).status, 'review');
      assert.equal(await test.api.getTransaction(`sms:${expected.referenceId}`), undefined);
    } finally { test.sqlite.close(); }
  });

  it('copies corrections before the source read and ignores later caller mutation', async () => {
    const row = { ...strongSms, platformId: '72' };
    const test = await fixture([row]);
    try {
      const expected = await ready(test.api, row);
      let markReaderStarted!: () => void;
      let releaseReader!: () => void;
      const readerStarted = new Promise<void>((resolve) => { markReaderStarted = resolve; });
      const readerGate = new Promise<void>((resolve) => { releaseReader = resolve; });
      const corrections: ReviewCorrections = { amountPaise: 46_000, note: 'Fictional original correction' };
      const pending = confirm(test.api, expected.referenceId, expected, async () => {
        markReaderStarted();
        await readerGate;
        return { ...row };
      }, corrections);
      await readerStarted;
      corrections.amountPaise = 99_000;
      corrections.note = 'Fictional late mutation';
      releaseReader();

      assert.deepEqual(await pending, { kind: 'saved', referenceId: expected.referenceId, platformId: row.platformId, transactionId: `sms:${expected.referenceId}` });
      const saved = await test.api.getTransaction(`sms:${expected.referenceId}`);
      assert.equal(saved?.amountPaise, 46_000);
      assert.equal(saved?.note, 'Fictional original correction');
    } finally { test.sqlite.close(); }
  });

  it('rechecks the protected key after the inbox read without recreating a lost or swapped key', async () => {
    const row = { ...strongSms, platformId: '72' };
    const test = await fixture([row]);
    try {
      let activeKey: Fingerprinter | null = test.key;
      const policies: FingerprintKeyPolicy[] = [];
      const api = createDataLayer(test.client, ledgerMigrations, async (policy) => {
        policies.push(policy!);
        if (!activeKey) throw new FingerprintKeyUnavailableError();
        return activeKey;
      }, test.runner);
      const expected = await ready(api, row);
      const before = totalChanges(test.sqlite);

      activeKey = test.key;
      const lost = await confirm(api, expected.referenceId, expected, async () => {
        activeKey = null;
        return { ...row };
      });
      assert.deepEqual(lost, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'key_unavailable' });
      assert.equal(JSON.stringify(lost).includes(row.body), false);
      assert.equal(await api.getTransaction(`sms:${expected.referenceId}`), undefined);
      assert.equal((test.sqlite.prepare('SELECT status FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string }).status, 'review');
      assert.equal(totalChanges(test.sqlite), before);

      activeKey = test.key;
      const swapped = await confirm(api, expected.referenceId, expected, async () => {
        activeKey = fingerprinter('fictional-replacement-key');
        return { ...row };
      });
      assert.deepEqual(swapped, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'key_unavailable' });
      assert.equal(await api.getTransaction(`sms:${expected.referenceId}`), undefined);
      assert.equal((test.sqlite.prepare('SELECT status FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string }).status, 'review');
      assert.equal(totalChanges(test.sqlite), before);
      assert.equal(policies.every((policy) => policy.allowCreate === false), true);
    } finally { test.sqlite.close(); }
  });

  it('requires a complete correction for an unknown format and stores paired null rule provenance', async () => {
    const row = {
      platformId: '75',
      sender: 'VM-HDFCBK-S',
      body: 'Your A/c XX1234 INR 750 txn 612345678901',
      receivedAt: strongSms.receivedAt,
    };
    const test = await fixture([row]);
    try {
      const expected = await ready(test.api, row);
      assert.equal(expected.preparation.candidate, null);
      assert.equal(expected.preparation.ruleId, null);
      assert.equal(expected.preparation.ruleVersion, null);
      let sourceReads = 0;
      const read = async () => {
        sourceReads += 1;
        return { ...row };
      };
      await assert.rejects(confirm(test.api, expected.referenceId, expected, read), /amountPaise is required/);
      assert.equal(sourceReads, 0, 'incomplete human input must fail before reading the source');
      assert.equal((test.sqlite.prepare('SELECT status FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string }).status, 'review');

      const initialCursor = await test.api.getSmsImportCursor();
      const corrections: ReviewCorrections = {
        amountPaise: 75_000,
        direction: 'debit',
        kind: 'expense',
        status: 'posted',
        occurredAt: new Date(row.receivedAt),
      };
      for (const invalid of [
        { ...corrections, amountPaise: Number.NaN },
        { ...corrections, direction: 'sideways' },
        { ...corrections, occurredAt: new Date(Number.NaN) },
      ]) {
        await assert.rejects(confirm(test.api, expected.referenceId, expected, read, invalid as ReviewCorrections));
      }
      assert.equal(sourceReads, 0, 'invalid money, enum and date input must fail before the source read');

      const invalidReference = await confirm(test.api, expected.referenceId, expected, read, { ...corrections, accountId: 'missing-account' });
      assert.deepEqual(invalidReference, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'invalid_correction' });
      assert.equal(JSON.stringify(invalidReference).includes('missing-account'), false);
      assert.equal(await test.api.getTransaction(`sms:${expected.referenceId}`), undefined);
      assert.equal((test.sqlite.prepare('SELECT status FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string }).status, 'review');

      const result = await confirm(test.api, expected.referenceId, expected, read, corrections);
      assert.deepEqual(result, { kind: 'saved', referenceId: expected.referenceId, platformId: row.platformId, transactionId: `sms:${expected.referenceId}` });
      const stored = test.sqlite.prepare('SELECT source, sms_ref_id, rule_id, rule_version, amount_paise FROM transactions WHERE id = ?').get(`sms:${expected.referenceId}`) as {
        source: string;
        sms_ref_id: string;
        rule_id: string | null;
        rule_version: number | null;
        amount_paise: number;
      };
      assert.deepEqual({ ...stored }, {
        source: 'sms', sms_ref_id: `android-sms:${expected.referenceId}`, rule_id: null, rule_version: null, amount_paise: 75_000,
      });
      assert.deepEqual(await test.api.getSmsImportCursor(), initialCursor);
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes(row.body), false);
      assert.equal(serialized.includes(row.sender), false);
    } finally { test.sqlite.close(); }
  });

  it('keeps weak body-key collisions pending unless the human confirms a distinct purchase', async () => {
    const rows = [
      { ...weakSms, platformId: '73' },
      { ...weakSms, platformId: '74', receivedAt: weakSms.receivedAt + 1 },
    ];
    const test = await fixture(rows);
    try {
      const first = await ready(test.api, rows[0]!);
      const second = await ready(test.api, rows[1]!);
      const firstResult = await confirm(test.api, first.referenceId, first, async () => ({ ...rows[0]! }));
      assert.equal((firstResult as { kind: string }).kind, 'saved');

      const before = totalChanges(test.sqlite);
      const blocked = await confirm(test.api, second.referenceId, second, async () => ({ ...rows[1]! }));
      assert.deepEqual(blocked, { kind: 'unavailable', referenceId: second.referenceId, platformId: '74', reason: 'ambiguous_overlap' });
      assert.equal(totalChanges(test.sqlite), before);
      assert.equal((test.sqlite.prepare('SELECT status FROM sms_import_refs WHERE platform_id = ?').get('74') as { status: string }).status, 'review');

      const separate = await confirm(test.api, second.referenceId, second, async () => ({ ...rows[1]! }), {}, { separatePayment: true });
      assert.equal((separate as { kind: string }).kind, 'saved');
      assert.equal(await test.api.getTransaction(`sms:${first.referenceId}`) !== null, true);
      assert.equal(await test.api.getTransaction(`sms:${second.referenceId}`) !== null, true);
      assert.equal((test.sqlite.prepare("SELECT count(*) AS count FROM transactions WHERE dedupe_key = ?").get(first.preparation.identity.dedupeKey) as { count: number }).count, 2);
    } finally { test.sqlite.close(); }

    const pastedOverlap = await fixture([{ ...weakSms, platformId: '75' }]);
    try {
      const paste = await pastedOverlap.api.preparePaste(weakSms);
      if (paste.kind !== 'needs-review') throw new Error('Fictional weak SMS paste should reach review');
      assert.equal(await pastedOverlap.api.saveReviewedPaste(paste), 'inserted');
      const row = { ...weakSms, platformId: '75' };
      const expected = await ready(pastedOverlap.api, row);
      const blocked = await confirm(pastedOverlap.api, expected.referenceId, expected, async () => ({ ...row }));
      assert.deepEqual(blocked, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'ambiguous_overlap' });
      const separate = await confirm(pastedOverlap.api, expected.referenceId, expected, async () => ({ ...row }), {}, { separatePayment: true });
      assert.deepEqual(separate, { kind: 'saved', referenceId: expected.referenceId, platformId: row.platformId, transactionId: `sms:${expected.referenceId}` });
      assert.ok(await pastedOverlap.api.getTransaction(paste.identity.id));
    } finally { pastedOverlap.sqlite.close(); }
  });

  it('links a single strong overlap without changing an edited tombstone and leaves ambiguous strong matches pending', async () => {
    const row = { ...strongSms, platformId: '72' };
    const test = await fixture([row]);
    try {
      const expected = await ready(test.api, row);
      const candidate = expected.preparation.candidate!;
      const existing = {
        id: 'paste-existing',
        amountPaise: candidate.amountPaise,
        direction: candidate.direction,
        kind: candidate.kind,
        status: candidate.status,
        accountId: null,
        counterparty: candidate.counterparty ?? null,
        merchantId: null,
        categoryId: null,
        occurredAt: new Date(candidate.occurredAt),
        note: null,
        source: 'paste' as const,
        smsRefId: null,
        upiRef: candidate.upiRef ?? null,
        dedupeKey: expected.preparation.identity.dedupeKey,
        bodyHash: expected.preparation.identity.bodyHash,
        ruleId: expected.preparation.ruleId,
        ruleVersion: expected.preparation.ruleVersion,
        linkedTxnId: null,
        excludeFromStats: false,
      };
      await test.ledger.upsertImportedTransaction(existing);
      await test.ledger.editTransaction(existing.id, { amountPaise: 47_000, note: 'Fictional saved correction' });
      await test.ledger.softDeleteTransaction(existing.id);

      const duplicate = await confirm(test.api, expected.referenceId, expected, async () => ({ ...row }), { amountPaise: 46_000 });
      assert.deepEqual(duplicate, { kind: 'duplicate', referenceId: expected.referenceId, platformId: row.platformId, transactionId: existing.id });
      const untouched = test.sqlite.prepare('SELECT amount_paise, note, deleted_at FROM transactions WHERE id = ?').get(existing.id) as {
        amount_paise: number;
        note: string | null;
        deleted_at: number | null;
      };
      assert.equal(untouched.amount_paise, 47_000);
      assert.equal(untouched.note, 'Fictional saved correction');
      assert.notEqual(untouched.deleted_at, null);
      assert.equal(await test.api.getTransaction(`sms:${expected.referenceId}`), undefined);
      const linked = test.sqlite.prepare('SELECT status, transaction_id FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string; transaction_id: string | null };
      assert.deepEqual({ ...linked }, { status: 'duplicate', transaction_id: existing.id });
    } finally { test.sqlite.close(); }

    const ambiguous = await fixture([row]);
    try {
      const expected = await ready(ambiguous.api, row);
      const candidate = expected.preparation.candidate!;
      const base = {
        amountPaise: candidate.amountPaise,
        direction: candidate.direction,
        kind: candidate.kind,
        status: candidate.status,
        accountId: null,
        counterparty: candidate.counterparty ?? null,
        merchantId: null,
        categoryId: null,
        occurredAt: new Date(candidate.occurredAt),
        note: null,
        source: 'paste' as const,
        smsRefId: null,
        upiRef: candidate.upiRef ?? null,
        dedupeKey: expected.preparation.identity.dedupeKey,
        bodyHash: expected.preparation.identity.bodyHash,
        ruleId: expected.preparation.ruleId,
        ruleVersion: expected.preparation.ruleVersion,
        linkedTxnId: null,
        excludeFromStats: false,
      };
      await ambiguous.ledger.upsertImportedTransaction({ ...base, id: 'paste-one' });
      await ambiguous.ledger.upsertImportedTransaction({ ...base, id: 'paste-two', bodyHash: `${'a'.repeat(63)}b` });
      const before = totalChanges(ambiguous.sqlite);
      const result = await confirm(ambiguous.api, expected.referenceId, expected, async () => ({ ...row }));
      assert.deepEqual(result, { kind: 'unavailable', referenceId: expected.referenceId, platformId: row.platformId, reason: 'ambiguous_overlap' });
      assert.equal(totalChanges(ambiguous.sqlite), before);
      assert.equal((ambiguous.sqlite.prepare('SELECT status FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string }).status, 'review');
      assert.equal(await ambiguous.api.getTransaction(`sms:${expected.referenceId}`), undefined);
    } finally { ambiguous.sqlite.close(); }
  });

  it('propagates reader cancellation and rolls back the immediate transaction', async () => {
    const row = { ...strongSms, platformId: '72' };
    const test = await fixture([row]);
    try {
      const expected = await ready(test.api, row);
      const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' });
      await assert.rejects(confirm(test.api, expected.referenceId, expected, async () => { throw cancelled; }), (error) => error === cancelled);
      assert.equal((test.sqlite.prepare('SELECT status FROM sms_import_refs WHERE platform_id = ?').get(row.platformId) as { status: string }).status, 'review');
      assert.equal(await test.api.getTransaction(`sms:${expected.referenceId}`), undefined);
      assert.equal(test.sqlite.prepare('SELECT 1 AS active').get()?.active, 1);
    } finally { test.sqlite.close(); }
  });
});
