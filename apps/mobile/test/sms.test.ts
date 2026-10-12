/// <reference types="node" />

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { rmSync, rmdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { describe, it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import type { LedgerSQLiteClient, LedgerSQLiteTransactionRunner, LedgerMigrations } from '../src/db/ledger';
import { importKeyState, smsImportRefs, smsImportState, transactions } from '../src/db/schema';
import type { FingerprintKeyProvider, Fingerprinter } from '../src/imports/fingerprint';
import { ledgerMigrations, openTestLedger, temporaryFile } from './helpers/ledger';

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

function fingerprinter(key: string): Fingerprinter {
  const keyId = createHmac('sha256', key).update('fictional-key-id').digest('hex');
  return { keyId, fingerprint: async (value) => createHmac('sha256', key).update(value).digest('hex') };
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
      try {
        await task(client);
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    } finally {
      release();
    }
  };
}

function createApi(fixture: ReturnType<typeof openTestLedger>, key = fingerprinter('fictional-sms-key')) {
  const run = transactionRunner(fixture.sqlite, fixture.client);
  return createDataLayer(fixture.client, ledgerMigrations, async () => key, run);
}

async function addHdfcAccount(api: ReturnType<typeof createApi>) {
  await api.createAccount({ id: 'hdfc-1234', name: 'Fictional HDFC', type: 'bank', institution: 'hdfc', last4: '1234' });
}

function smsRow(platformId: string, raw = strongSms, receivedAt = raw.receivedAt) {
  return { ...raw, platformId, receivedAt };
}

describe('Android SMS ingestion storage seam', () => {
  it('adds storage tables without losing pre-existing ledger data', async () => {
    const fixture = openTestLedger();
    try {
      const oldMigrations: LedgerMigrations = {
        journal: { entries: ledgerMigrations.journal.entries.slice(0, 5) },
        migrations: Object.fromEntries(Object.entries(ledgerMigrations.migrations).filter(([key]) => Number(key.slice(1)) < 5)),
      };
      const oldApi = createDataLayer(fixture.client, oldMigrations);
      await oldApi.migrateLedger();
      fixture.sqlite.exec(`INSERT INTO accounts(id,name,type,archived) VALUES('old-account','Old account','bank',0)`);
      fixture.sqlite.exec("INSERT INTO transactions(id,amount_paise,direction,kind,source,occurred_at,created_at,updated_at) VALUES('old-row',100,'debit','expense','manual',1,1,1)");

      const api = createApi(fixture);
      await api.migrateLedger();
      assert.equal((await api.getTransaction('old-row'))?.amountPaise, 100);
      assert.equal(await api.getSmsImportCursor(), null);
      assert.equal((fixture.sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
      for (const [table, name] of [
        ['transactions', 'transactions_dedupe_key_idx'],
        ['sms_import_refs', 'sms_import_refs_dedupe_key_idx'],
      ]) {
        const indexes = fixture.sqlite.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string; unique: number }>;
        assert.equal(indexes.find((index) => index.name === name)?.unique, 0);
      }
    } finally { fixture.sqlite.close(); }
  });

  it('stores only keyed metadata for unverified formats and advances a compound cursor', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      await addHdfcAccount(api);

      const result = await api.importSmsBatch([smsRow('2')], null);
      assert.deepEqual(result, {
        cursor: { receivedAt: strongSms.receivedAt, platformId: '2' },
        inserted: 0,
        duplicate: 0,
        review: 1,
        ignored: 0,
      });
      const stored = await fixture.ledger.db.select().from(smsImportRefs).all();
      assert.equal(stored[0]?.status, 'review');
      assert.equal(stored[0]?.reason, 'unverified_rule');
      assert.equal(Object.keys(stored[0] ?? {}).some((key) => /^(body|sender)$/i.test(key)), false);
      assert.equal(JSON.stringify(stored).includes(strongSms.body), false);
      assert.equal(JSON.stringify(stored).includes(strongSms.sender), false);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 0);
      const columns = fixture.sqlite.prepare('PRAGMA table_info(sms_import_refs)').all() as { name: string }[];
      assert.equal(columns.some(({ name }) => /^(body|sender)$/i.test(name)), false);
      assert.deepEqual(await api.getSmsImportCursor(), result.cursor);
    } finally { fixture.sqlite.close(); }
  });

  it('uses numeric platform ID ordering at equal timestamps and rejects a stale concurrent batch', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      const time = strongSms.receivedAt;
      await assert.rejects(api.importSmsBatch([smsRow('10', strongSms, time), smsRow('2', strongSms, time)], null), /ordered/);

      const outcomes = await Promise.allSettled([
        api.importSmsBatch([smsRow('2', strongSms, time), smsRow('10', strongSms, time)], null),
        api.importSmsBatch([smsRow('2', strongSms, time), smsRow('10', strongSms, time)], null),
      ]);
      assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((entry) => entry.status === 'rejected').length, 1);
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 2);
      assert.deepEqual(await api.getSmsImportCursor(), { receivedAt: time, platformId: '10' });
    } finally { fixture.sqlite.close(); }
  });

  it('rolls back refs, key state and cursor together after a write failure', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      fixture.sqlite.exec(`CREATE TRIGGER reject_sms_ref BEFORE INSERT ON sms_import_refs BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`);
      await assert.rejects(api.importSmsBatch([smsRow('20')], null));
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 0);
      assert.equal(await fixture.ledger.db.select().from(smsImportState).get(), undefined);
      assert.equal(await fixture.ledger.db.select().from(importKeyState).get(), undefined);
      assert.equal(await api.getSmsImportCursor(), null);
    } finally { fixture.sqlite.close(); }
  });

  it('ties coherent strong UPI overlap to an edited paste row without overwriting it', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      await addHdfcAccount(api);
      const prepared = await api.preparePaste(strongSms);
      if (prepared.kind !== 'needs-review') throw new Error('Fictional fixture must reach review');
      assert.equal(await api.saveReviewedPaste(prepared, { accountId: 'hdfc-1234', note: 'Reviewed fictional note' }), 'inserted');
      assert.equal(await api.editTransaction(prepared.identity.id, {
        amountPaise: 45123,
        accountId: null,
        note: 'Corrected fictional amount and account',
      }), true);

      const result = await api.importSmsBatch([smsRow('30')], null);
      const ref = await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '30')).get();
      const paste = await api.getTransaction(prepared.identity.id);
      assert.equal(result.duplicate, 1);
      assert.equal(ref?.status, 'duplicate');
      assert.equal(ref?.transactionId, prepared.identity.id);
      assert.equal(paste?.amountPaise, 45123);
      assert.equal(paste?.accountId, null);
      assert.equal(paste?.note, 'Corrected fictional amount and account');
      assert.equal(paste?.userEdited, true);
    } finally { fixture.sqlite.close(); }
  });

  it('resolves a strong review reference when the same message is confirmed by paste', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      await addHdfcAccount(api);
      const imported = await api.importSmsBatch([smsRow('110')], null);
      assert.equal(imported.review, 1);

      const prepared = await api.preparePaste(strongSms);
      if (prepared.kind !== 'needs-review') throw new Error('Fictional fixture must reach review');
      assert.equal(await api.saveReviewedPaste(prepared, { accountId: 'hdfc-1234' }), 'inserted');

      const ref = await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '110')).get();
      assert.equal(ref?.status, 'duplicate');
      assert.equal(ref?.reason, null);
      assert.equal(ref?.transactionId, prepared.identity.id);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 1);
    } finally { fixture.sqlite.close(); }
  });

  it('links an exact paste replay to a tombstoned SMS transaction without resurrecting it', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      await addHdfcAccount(api);
      await api.importSmsBatch([smsRow('111')], null);
      const prepared = await api.preparePaste(strongSms);
      if (prepared.kind !== 'needs-review' || !prepared.candidate) throw new Error('Fictional fixture must parse');
      const candidate = prepared.candidate;
      await fixture.ledger.upsertImportedTransaction({
        id: 'sms:131',
        amountPaise: candidate.amountPaise,
        direction: candidate.direction,
        kind: candidate.kind,
        status: candidate.status,
        accountId: 'hdfc-1234',
        counterparty: candidate.counterparty,
        merchantId: null,
        categoryId: null,
        occurredAt: new Date(candidate.occurredAt),
        note: null,
        source: 'sms',
        smsRefId: 'android-sms:131',
        upiRef: candidate.upiRef,
        dedupeKey: prepared.identity.dedupeKey,
        bodyHash: prepared.identity.bodyHash,
        ruleId: prepared.ruleId,
        ruleVersion: prepared.ruleVersion,
        linkedTxnId: null,
        excludeFromStats: false,
      });
      await fixture.ledger.softDeleteTransaction('sms:131');

      assert.equal(await api.saveReviewedPaste(prepared, { accountId: 'hdfc-1234' }), 'duplicate');
      const ref = await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '111')).get();
      const tombstone = await fixture.ledger.db.select().from(transactions).where(eq(transactions.id, 'sms:131')).get();
      assert.equal(ref?.status, 'duplicate');
      assert.equal(ref?.transactionId, 'sms:131');
      assert.ok(tombstone?.deletedAt);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 1);
    } finally { fixture.sqlite.close(); }
  });

  it('keeps a strong reference with changed message content in ambiguous review', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      await addHdfcAccount(api);
      await api.importSmsBatch([smsRow('112')], null);
      const changedMessage = { ...strongSms, body: strongSms.body.replace('450.00', '451.00') };
      const prepared = await api.preparePaste(changedMessage);
      if (prepared.kind !== 'needs-review') throw new Error('Fictional fixture must reach review');

      assert.equal(await api.saveReviewedPaste(prepared, { accountId: 'hdfc-1234' }), 'inserted');
      const ref = await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '112')).get();
      assert.equal(ref?.status, 'review');
      assert.equal(ref?.reason, 'ambiguous_evidence');
      assert.equal(ref?.transactionId, null);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 1);
    } finally { fixture.sqlite.close(); }
  });

  it('keeps identical weak review references distinct when paste confirms a transaction', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      await addHdfcAccount(api);
      const imported = await api.importSmsBatch([
        smsRow('120', weakSms),
        smsRow('121', weakSms, weakSms.receivedAt + 1_000),
      ], null);
      assert.equal(imported.review, 2);

      const prepared = await api.preparePaste(weakSms);
      if (prepared.kind !== 'needs-review') throw new Error('Fictional fixture must reach review');
      assert.equal(await api.saveReviewedPaste(prepared, { accountId: 'hdfc-1234' }), 'inserted');

      const refs = await fixture.ledger.db.select().from(smsImportRefs).all();
      assert.deepEqual(refs.map((ref) => ref.platformId).sort(), ['120', '121']);
      assert.ok(refs.every((ref) => ref.status === 'review' && ref.reason === 'weak_overlap' && ref.transactionId === null));
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 1);
    } finally { fixture.sqlite.close(); }
  });

  it('rolls back a new paste transaction if SMS reference linking fails', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      await addHdfcAccount(api);
      await api.importSmsBatch([smsRow('130')], null);
      const prepared = await api.preparePaste(strongSms);
      if (prepared.kind !== 'needs-review') throw new Error('Fictional fixture must reach review');
      const before = await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '130')).get();
      fixture.sqlite.exec(`CREATE TRIGGER fail_sms_ref_link BEFORE UPDATE ON sms_import_refs
        BEGIN SELECT RAISE(ABORT, 'injected SMS reference-link failure'); END`);

      await assert.rejects(api.saveReviewedPaste(prepared, { accountId: 'hdfc-1234' }), /Failed query: update "sms_import_refs"/);

      const after = await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '130')).get();
      assert.equal(after?.status, before?.status);
      assert.equal(after?.reason, before?.reason);
      assert.equal(after?.transactionId, null);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 0);
    } finally { fixture.sqlite.close(); }
  });

  it('ties an identical pasted message to an edited SMS transaction and exposes weak SMS collisions', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      await addHdfcAccount(api);

      const strong = await api.preparePaste(strongSms);
      if (strong.kind !== 'needs-review' || !strong.candidate) throw new Error('Fictional fixture must parse');
      assert.equal(strong.duplicateReviewRequired, false);
      await fixture.ledger.upsertImportedTransaction({
        id: 'sms:900',
        amountPaise: strong.candidate.amountPaise,
        direction: strong.candidate.direction,
        kind: strong.candidate.kind,
        status: strong.candidate.status,
        accountId: 'hdfc-1234',
        counterparty: strong.candidate.counterparty,
        merchantId: null,
        categoryId: null,
        occurredAt: new Date(strong.candidate.occurredAt),
        note: null,
        source: 'sms',
        smsRefId: 'android-sms:900',
        upiRef: strong.candidate.upiRef,
        dedupeKey: strong.identity.dedupeKey,
        bodyHash: strong.identity.bodyHash,
        ruleId: strong.ruleId,
        ruleVersion: strong.ruleVersion,
        linkedTxnId: null,
        excludeFromStats: false,
      });
      await api.editTransaction('sms:900', {
        amountPaise: 44999,
        accountId: null,
        note: 'User correction stays intact',
      });

      const sameSmsPaste = await api.preparePaste(strongSms);
      if (sameSmsPaste.kind !== 'needs-review') throw new Error('Fictional fixture must reach review');
      assert.equal(await api.saveReviewedPaste(sameSmsPaste, { accountId: 'hdfc-1234' }), 'duplicate');
      const imported = await api.getTransaction('sms:900');
      assert.equal(imported?.amountPaise, 44999);
      assert.equal(imported?.accountId, null);
      assert.equal(imported?.note, 'User correction stays intact');
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 1);

      const weak = await api.preparePaste(weakSms);
      if (weak.kind !== 'needs-review' || !weak.candidate) throw new Error('Fictional weak fixture must parse');
      await fixture.ledger.upsertImportedTransaction({
        id: 'sms:901',
        amountPaise: weak.candidate.amountPaise,
        direction: weak.candidate.direction,
        kind: weak.candidate.kind,
        status: weak.candidate.status,
        accountId: 'hdfc-1234',
        counterparty: weak.candidate.counterparty,
        merchantId: null,
        categoryId: null,
        occurredAt: new Date(weak.candidate.occurredAt),
        note: null,
        source: 'sms',
        smsRefId: 'android-sms:901',
        upiRef: weak.candidate.upiRef,
        dedupeKey: weak.identity.dedupeKey,
        bodyHash: weak.identity.bodyHash,
        ruleId: weak.ruleId,
        ruleVersion: weak.ruleVersion,
        linkedTxnId: null,
        excludeFromStats: false,
      });
      const weakPaste = await api.preparePaste(weakSms);
      if (weakPaste.kind !== 'needs-review') throw new Error('Fictional weak fixture must reach review');
      assert.deepEqual(weakPaste.collision, {
        occurredAt: (await api.getTransaction('sms:901'))!.occurredAt.getTime(),
        deleted: false,
      });
      assert.equal(await api.saveReviewedPaste(weakPaste, { accountId: 'hdfc-1234' }), 'duplicate');
      const existing = await api.getTransaction('sms:901');
      const separateAt = new Date((Math.floor(existing!.occurredAt.getTime() / 1_000) + 10) * 1_000);
      assert.equal(await api.saveReviewedPaste(weakPaste, { accountId: 'hdfc-1234' }, { separatePaymentAt: separateAt }), 'inserted');
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 3);
    } finally { fixture.sqlite.close(); }
  });

  it('routes weak overlaps, conflicting strong evidence, unsafe amounts and failed alerts to review', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      await addHdfcAccount(api);
      const weak = await api.preparePaste(weakSms);
      if (weak.kind !== 'needs-review') throw new Error('Fictional weak fixture must reach review');
      assert.equal(await api.saveReviewedPaste(weak, { accountId: 'hdfc-1234' }), 'inserted');
      const strong = await api.preparePaste(strongSms);
      if (strong.kind !== 'needs-review') throw new Error('Fictional strong fixture must reach review');
      assert.equal(await api.saveReviewedPaste(strong, { accountId: 'hdfc-1234' }), 'inserted');

      const amountConflict = { ...strongSms, body: strongSms.body.replace('450.00', '451.00') };
      const failed = { ...strongSms, body: strongSms.body.replace('debited', 'debited but failed').replace('612345678901', '612345678902') };
      const unsafe = { ...strongSms, body: 'INR 90071992547409.92 debited from A/c XX1234 (UPI Ref No 612345678903).' };
      const rows = [smsRow('40', weakSms), smsRow('41', amountConflict), smsRow('42', failed), smsRow('43', unsafe)];
      const result = await api.importSmsBatch(rows, null);
      assert.equal(result.review, 4);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 2);
      const refs = await fixture.ledger.db.select().from(smsImportRefs).all();
      assert.equal(refs.find((ref) => ref.platformId === '40')?.reason, 'weak_overlap');
      assert.equal(refs.find((ref) => ref.platformId === '41')?.reason, 'inconsistent_evidence');
      assert.equal(refs.find((ref) => ref.platformId === '42')?.reason, 'non_posted');
      assert.ok(['unsafe_amount', 'unknown_format'].includes(refs.find((ref) => ref.platformId === '43')?.reason ?? ''));
    } finally { fixture.sqlite.close(); }
  });

  it('keeps separate identical no-reference purchases in review and stops when the key changes', async () => {
    const fixture = openTestLedger();
    try {
      const key = fingerprinter('fictional-sms-key');
      const api = createApi(fixture, key);
      await api.migrateLedger();
      await addHdfcAccount(api);
      const first = smsRow('50', weakSms);
      const second = smsRow('51', weakSms, weakSms.receivedAt + 1_000);
      const result = await api.importSmsBatch([first, second], null);
      assert.equal(result.review, 2);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 0);

      const changedKeyApi = createApi(fixture, fingerprinter('fictional-replacement-key'));
      const next = smsRow('52', weakSms, weakSms.receivedAt + 2_000);
      await assert.rejects(changedKeyApi.importSmsBatch([next], result.cursor), /Duplicate|key|review/i);
      assert.deepEqual(await api.getSmsImportCursor(), result.cursor);
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 2);
    } finally { fixture.sqlite.close(); }
  });

  it('does not advance state when the fingerprint provider is unavailable', async () => {
    const fixture = openTestLedger();
    try {
      const run = transactionRunner(fixture.sqlite, fixture.client);
      const api = createDataLayer(fixture.client, ledgerMigrations, undefined, run);
      await api.migrateLedger();
      await assert.rejects(api.importSmsBatch([smsRow('60')], null), /fingerprint provider/);
      assert.equal(await api.getSmsImportCursor(), null);
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 0);
      assert.equal(await fixture.ledger.db.select().from(smsImportState).get(), undefined);
      assert.equal(await fixture.ledger.db.select().from(importKeyState).get(), undefined);
    } finally { fixture.sqlite.close(); }
  });

  it('checks the cursor before loading a key and keeps Android paste key work inside the writer transaction', async () => {
    const fixture = openTestLedger();
    try {
      const baseRunner = transactionRunner(fixture.sqlite, fixture.client);
      let inTransaction = false;
      const run: LedgerSQLiteTransactionRunner = (task) => baseRunner(async (transaction) => {
        inTransaction = true;
        try { await task(transaction); }
        finally { inTransaction = false; }
      });
      const key = fingerprinter('fictional-sms-key');
      const policies: boolean[] = [];
      const provider: FingerprintKeyProvider = async (policy) => {
        assert.equal(inTransaction, true, 'key provider must run after BEGIN IMMEDIATE');
        policies.push(policy?.allowCreate ?? false);
        return key;
      };
      const api = createDataLayer(fixture.client, ledgerMigrations, provider, run);
      await api.migrateLedger();

      const imported = await api.importSmsBatch([smsRow('61')], null);
      assert.equal(policies.length, 1);
      assert.equal(policies[0], true);
      await assert.rejects(api.importSmsBatch([smsRow('62')], null), /cursor is stale/);
      assert.equal(policies.length, 1, 'stale cursor must fail before key-store access');

      await api.createAccount({ id: 'hdfc-1234', name: 'Fictional HDFC', type: 'bank', institution: 'hdfc', last4: '1234' });
      const prepared = await api.preparePaste(strongSms);
      assert.equal(prepared.kind, 'needs-review');
      assert.deepEqual(policies, [true, false]);
      assert.equal(await api.saveReviewedPaste(prepared, { accountId: 'hdfc-1234' }), 'inserted');
      assert.deepEqual(policies, [true, false, false]);
      assert.deepEqual(await api.getSmsImportCursor(), imported.cursor);
    } finally { fixture.sqlite.close(); }
  });

  it('persists the cursor and body-free references across a database reopen', async () => {
    const temp = temporaryFile();
    let fixture = openTestLedger(temp.filename);
    try {
      const firstApi = createApi(fixture);
      await firstApi.migrateLedger();
      const first = await firstApi.importSmsBatch([smsRow('61')], null);
      fixture.sqlite.close();

      fixture = openTestLedger(temp.filename);
      const reopenedApi = createApi(fixture);
      await reopenedApi.migrateLedger();
      assert.deepEqual(await reopenedApi.getSmsImportCursor(), first.cursor);
      const refs = await fixture.ledger.db.select().from(smsImportRefs).all();
      assert.equal(refs.length, 1);
      assert.equal(refs[0]?.platformId, '61');
      assert.equal(JSON.stringify(refs).includes(strongSms.body), false);
      assert.equal(JSON.stringify(refs).includes(strongSms.sender), false);
    } finally {
      fixture.sqlite.close();
      rmSync(temp.filename, { force: true });
      rmdirSync(temp.directory);
    }
  });

  it('uses only validated copies while an asynchronous fingerprint provider is pending', async () => {
    const fixture = openTestLedger();
    try {
      const key = fingerprinter('fictional-sms-key');
      const firstApi = createApi(fixture, key);
      await firstApi.migrateLedger();
      const first = await firstApi.importSmsBatch([smsRow('69')], null);

      let notifyProviderStarted!: () => void;
      let releaseProvider!: () => void;
      const providerStarted = new Promise<void>((resolve) => { notifyProviderStarted = resolve; });
      const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
      const api = createDataLayer(fixture.client, ledgerMigrations, async () => {
        notifyProviderStarted();
        await providerGate;
        return key;
      }, transactionRunner(fixture.sqlite, fixture.client));
      const expectedCursor = { ...first.cursor! };
      const receivedAt = expectedCursor.receivedAt + 1_000;
      const rows = [smsRow('70', strongSms, receivedAt)];
      const pending = api.importSmsBatch(rows, expectedCursor);
      await providerStarted;
      rows[0]!.platformId = '999';
      rows[0]!.sender = 'AD-FAKEBANK-S';
      rows[0]!.body = 'mutated fictional message';
      rows[0]!.receivedAt = receivedAt + 100_000;
      expectedCursor.receivedAt += 100_000;
      releaseProvider();

      const result = await pending;
      assert.deepEqual(result.cursor, { receivedAt, platformId: '70' });
      const ref = await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '70')).get();
      assert.equal(ref?.bodyHash, await key.fingerprint(JSON.stringify(['body', strongSms.body])));
      assert.equal(ref?.senderHash, await key.fingerprint(JSON.stringify(['sender', strongSms.sender.toUpperCase()])));
      assert.equal(await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '999')).get(), undefined);
    } finally { fixture.sqlite.close(); }
  });

  it('rejects changed sender or date for an already referenced platform ID', async () => {
    for (const change of ['sender', 'date'] as const) {
      const fixture = openTestLedger();
      try {
        const api = createApi(fixture);
        await api.migrateLedger();
        const imported = await api.importSmsBatch([smsRow('80')], null);
        const expected = { receivedAt: strongSms.receivedAt - 1_000, platformId: '79' };
        await fixture.ledger.db.update(smsImportState).set({
          cursorReceivedAt: expected.receivedAt,
          cursorPlatformId: expected.platformId,
        }).where(eq(smsImportState.id, 1)).run();
        const changed = change === 'sender'
          ? smsRow('80', { ...strongSms, sender: 'AD-FAKEBANK-S' }, strongSms.receivedAt)
          : smsRow('80', strongSms, strongSms.receivedAt + 1_000);
        await assert.rejects(api.importSmsBatch([changed], expected), /previously imported SMS row changed/);
        assert.deepEqual(await api.getSmsImportCursor(), expected);
        assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 1);
        assert.deepEqual(imported.cursor, { receivedAt: strongSms.receivedAt, platformId: '80' });
      } finally { fixture.sqlite.close(); }
    }
  });

  it('treats legacy SMS transactions and references as a key-state mismatch', async () => {
    for (const legacy of ['transaction', 'reference'] as const) {
      const fixture = openTestLedger();
      try {
        const api = createApi(fixture);
        await api.migrateLedger();
        if (legacy === 'transaction') {
          fixture.sqlite.exec(`INSERT INTO transactions(id,amount_paise,direction,kind,occurred_at,source,sms_ref_id,dedupe_key,body_hash,created_at,updated_at)
            VALUES('sms:legacy',100,'debit','expense',1,'sms','android-sms:legacy','body:${'a'.repeat(64)}','${'b'.repeat(64)}',1,1)`);
        } else {
          await fixture.ledger.db.insert(smsImportRefs).values({
            platformId: 'legacy',
            receivedAt: 1,
            senderHash: 'a'.repeat(64),
            dedupeKey: `body:${'b'.repeat(64)}`,
            bodyHash: 'c'.repeat(64),
            keyId: 'd'.repeat(64),
            status: 'review',
            reason: 'unknown_format',
            ruleId: null,
            ruleVersion: null,
            transactionId: null,
            createdAt: 1,
          }).run();
        }
        const prepared = await api.preparePaste(strongSms);
        if (prepared.kind !== 'needs-review') throw new Error('Fictional fixture must reach review');
        assert.equal(prepared.duplicateReviewRequired, true);
        assert.equal((await fixture.ledger.db.select().from(importKeyState).get())?.keyId, 'legacy');
      } finally { fixture.sqlite.close(); }
    }
  });

});
