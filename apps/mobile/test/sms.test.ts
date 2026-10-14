/// <reference types="node" />

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { rmSync, rmdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { describe, it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import type { LedgerSQLiteClient, LedgerSQLiteTransactionRunner, LedgerMigrations } from '../src/db/ledger';
import { importKeyState, preferences, smsImportRefs, smsImportState, transactions } from '../src/db/schema';
import { FingerprintKeyUnavailableError, type FingerprintKeyProvider, type Fingerprinter } from '../src/imports/fingerprint';
import { ledgerMigrations, openTestLedger, temporaryFile } from './helpers/ledger';
import { smsReferenceId } from './helpers/sms';

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
  it('adds SMS storage to the current dev schema without losing existing data', async () => {
    const fixture = openTestLedger();
    try {
      const oldMigrations: LedgerMigrations = {
        journal: { entries: ledgerMigrations.journal.entries.slice(0, 7) },
        migrations: Object.fromEntries(Object.entries(ledgerMigrations.migrations).filter(([key]) => Number(key.slice(1)) < 7)),
      };
      const oldApi = createDataLayer(fixture.client, oldMigrations);
      await oldApi.migrateLedger();
      fixture.sqlite.exec(`INSERT INTO accounts(id,name,type,archived) VALUES('old-account','Old account','bank',0)`);
      fixture.sqlite.exec(`INSERT INTO categories(id,name,kind,is_fixed) VALUES('old-category','Old category','expense',1)`);
      fixture.sqlite.exec(`INSERT INTO preferences(key,value) VALUES('theme','dark')`);
      fixture.sqlite.exec("INSERT INTO transactions(id,amount_paise,direction,kind,source,occurred_at,created_at,updated_at) VALUES('old-row',100,'debit','expense','manual',1,1,1)");

      const api = createApi(fixture);
      await api.migrateLedger();
      assert.equal((await api.getTransaction('old-row'))?.amountPaise, 100);
      assert.equal((fixture.sqlite.prepare('SELECT value FROM preferences WHERE key = ?').get('theme') as { value: string }).value, 'dark');
      assert.equal((fixture.sqlite.prepare('SELECT is_fixed FROM categories WHERE id = ?').get('old-category') as { is_fixed: number }).is_fixed, 1);
      assert.equal(await api.getSmsImportCursor(), null);
      assert.equal((fixture.sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
      for (const [table, name] of [
        ['transactions', 'transactions_dedupe_key_idx'],
        ['sms_import_refs', 'sms_import_refs_dedupe_key_idx'],
      ]) {
        const indexes = fixture.sqlite.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string; unique: number }>;
        assert.equal(indexes.find((index) => index.name === name)?.unique, 0);
      }
      const sourceUnique = fixture.sqlite.prepare("PRAGMA index_list('sms_import_refs')").all() as Array<{ name: string; unique: number }>;
      assert.equal(sourceUnique.find((index) => index.name === 'sms_import_refs_source_unique')?.unique, 1);
    } finally { fixture.sqlite.close(); }
  });

  it('rejects the superseded prototype migration lineage without resetting its records', async () => {
    const fixture = openTestLedger();
    try {
      const prototypeBase: LedgerMigrations = {
        journal: { entries: ledgerMigrations.journal.entries.slice(0, 5) },
        migrations: Object.fromEntries(Object.entries(ledgerMigrations.migrations).filter(([key]) => Number(key.slice(1)) < 5)),
      };
      await createDataLayer(fixture.client, prototypeBase).migrateLedger();
      fixture.sqlite.exec(ledgerMigrations.migrations.m0007!);
      fixture.sqlite.exec("PRAGMA user_version = 7; INSERT INTO transactions(id,amount_paise,direction,kind,source,occurred_at,created_at,updated_at) VALUES('prototype-row',100,'debit','expense','manual',1,1,1)");
      const api = createApi(fixture);
      await assert.rejects(api.migrateLedger(), /already exists/);
      assert.equal((await api.getTransaction('prototype-row'))?.amountPaise, 100);
      assert.equal((fixture.sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
      assert.equal(fixture.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'preferences'").get(), undefined);
    } finally { fixture.sqlite.close(); }
  });

  it('adds stable reference IDs without changing legacy SMS links or transaction history', async () => {
    const fixture = openTestLedger();
    try {
      const oldMigrations: LedgerMigrations = {
        journal: { entries: ledgerMigrations.journal.entries.slice(0, 8) },
        migrations: Object.fromEntries(Object.entries(ledgerMigrations.migrations).filter(([key]) => Number(key.slice(1)) < 8)),
      };
      await createDataLayer(fixture.client, oldMigrations).migrateLedger();
      const key = fingerprinter('fictional-sms-key');
      const source = smsRow('71');
      const [senderHash, bodyHash] = await Promise.all([
        key.fingerprint(JSON.stringify(['sender', source.sender.toUpperCase()])),
        key.fingerprint(JSON.stringify(['body', source.body])),
      ]);
      fixture.sqlite.prepare('INSERT INTO import_key_state(id,key_id) VALUES(1, ?)').run(key.keyId);
      fixture.sqlite.exec(`
        INSERT INTO transactions(id,amount_paise,direction,kind,status,occurred_at,note,source,sms_ref_id,upi_ref,dedupe_key,body_hash,rule_id,rule_version,linked_txn_id,exclude_from_stats,user_edited,created_at,updated_at,deleted_at)
        VALUES
          ('migration-edited',45000,'debit','expense','posted',1791367200000,'Fictional edit','sms','android-sms:71','612345678901','upi:${'a'.repeat(64)}','${'b'.repeat(64)}','fictional.rule',7,'migration-deleted',0,1,1,2,NULL),
          ('migration-deleted',100,'debit','expense','posted',1791367200000,'Fictional tombstone','manual',NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,1,1,2,3)
      `);
      fixture.sqlite.prepare(`INSERT INTO sms_import_refs
        (platform_id,received_at,sender_hash,dedupe_key,body_hash,key_id,status,reason,rule_id,rule_version,transaction_id,created_at)
        VALUES ('71',?,?,?,?,?,'saved',NULL,'fictional.rule',7,'migration-edited',1)`)
        .run(source.receivedAt, senderHash, `body:${'a'.repeat(64)}`, bodyHash, key.keyId);
      const oldReference = fixture.sqlite.prepare('SELECT * FROM sms_import_refs WHERE platform_id = ?').get('71') as Record<string, unknown>;
      const oldTransactions = fixture.sqlite.prepare(`SELECT * FROM transactions WHERE id IN ('migration-edited','migration-deleted') ORDER BY id`).all();

      const api = createApi(fixture, key);
      await api.migrateLedger();

      const reference = fixture.sqlite.prepare('SELECT * FROM sms_import_refs WHERE platform_id = ?').get('71') as Record<string, unknown>;
      const { reference_id: _, ...preservedReference } = reference;
      assert.equal(reference.reference_id, 'legacy:71');
      assert.deepEqual({ ...preservedReference }, { ...oldReference });
      assert.deepEqual(fixture.sqlite.prepare(`SELECT * FROM transactions WHERE id IN ('migration-edited','migration-deleted') ORDER BY id`).all().map((row) => ({ ...row })),
        oldTransactions.map((row) => ({ ...row })));
      assert.deepEqual(fixture.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal((fixture.sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
      const replay = await api.importSmsBatch([source], null);
      assert.equal(replay.duplicate, 1);
      assert.equal(smsReferenceId(fixture.sqlite, source.platformId, source.receivedAt), 'legacy:71');
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

  it('keeps unreadable string content in body-free review and advances the cursor', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      const oversizedBody = `FICTIONAL_UNREADABLE_BODY_${'x'.repeat(16_384)}`;
      const oversizedSender = 'S'.repeat(257);
      const rows = [
        smsRow('210', { ...strongSms, sender: ' \t ' }),
        smsRow('211', { ...strongSms, body: '  ' }),
        smsRow('212', { ...strongSms, body: oversizedBody }),
        smsRow('213', { ...strongSms, sender: oversizedSender }),
      ];

      const result = await api.importSmsBatch(rows, null);

      assert.equal(result.review, 4);
      assert.equal(result.ignored, 0);
      assert.deepEqual(result.cursor, { receivedAt: strongSms.receivedAt, platformId: '213' });
      const refs = await fixture.ledger.db.select().from(smsImportRefs).all();
      assert.deepEqual(refs.map((ref) => [ref.platformId, ref.reason]), rows.map((row) => [row.platformId, 'unreadable_source']));
      assert.equal(JSON.stringify(refs).includes(oversizedBody), false);
      assert.equal(JSON.stringify(refs).includes('FICTIONAL_UNREADABLE_BODY_'), false);
      assert.deepEqual(await api.getSmsImportCursor(), result.cursor);
      let sourceReads = 0;
      const referenceId = smsReferenceId(fixture.sqlite, '212');
      assert.deepEqual(await api.prepareSmsReview(referenceId, async () => {
        sourceReads += 1;
        throw new Error('Unreadable source must not be parsed');
      }), { kind: 'unavailable', referenceId, platformId: '212', reason: 'unreadable_source' });
      assert.equal(sourceReads, 0);

      await assert.rejects(api.importSmsBatch([{
        ...smsRow('214'),
        body: null as unknown as string,
      }], result.cursor), /body is invalid/);
      assert.deepEqual(await api.getSmsImportCursor(), result.cursor);
    } finally { fixture.sqlite.close(); }
  });

  it('does not echo unreadable source content when keyed fingerprinting fails', async () => {
    const fixture = openTestLedger();
    const secret = 'FICTIONAL_PRIVATE_SMS_CONTENT';
    const provider: FingerprintKeyProvider = async () => ({
      keyId: 'a'.repeat(64),
      async fingerprint(value) {
        if (value.includes(secret)) throw new Error(value);
        return createHmac('sha256', 'fictional-sms-key').update(value).digest('hex');
      },
    });
    try {
      const api = createDataLayer(fixture.client, ledgerMigrations, provider, transactionRunner(fixture.sqlite, fixture.client));
      await api.migrateLedger();
      const unreadable = smsRow('220', { ...strongSms, body: `${secret}${'x'.repeat(16_385)}` });
      await assert.rejects(api.importSmsBatch([unreadable], null), (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).message.includes(secret), false);
        return true;
      });
      assert.deepEqual(await api.getSmsImportCursor(), null);
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 0);
    } finally { fixture.sqlite.close(); }
  });

  it('uses numeric platform ID ordering at equal timestamps and rejects a stale concurrent batch', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      const time = strongSms.receivedAt;
      await assert.rejects(api.importSmsBatch([smsRow('10', strongSms, time), smsRow('2', strongSms, time)], null), /ordered/);

      const completionTimes = [1_800_000_000_001, 1_800_000_000_002];
      const outcomes = await Promise.allSettled(completionTimes.map((catchupCompletedAt) =>
        api.importSmsBatch([smsRow('2', strongSms, time), smsRow('10', strongSms, time)], null, { catchupCompletedAt }),
      ));
      assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((entry) => entry.status === 'rejected').length, 1);
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 2);
      assert.deepEqual(await api.getSmsImportCursor(), { receivedAt: time, platformId: '10' });
      const winner = outcomes.findIndex((entry) => entry.status === 'fulfilled');
      assert.equal((await api.getSmsImportHealth()).lastSuccessfulCatchupAt, completionTimes[winner]);
    } finally { fixture.sqlite.close(); }
  });

  it('validates replay pages separately while atomically preserving the main high-water cursor', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      const time = strongSms.receivedAt;
      const mainTime = time + 10_000;
      const main = await api.importSmsBatch([smsRow('90', strongSms, mainTime)], null);
      const page1 = await api.importSmsBatch([smsRow('10', strongSms, time)], main.cursor, { replayAfter: null });
      assert.deepEqual(page1.cursor, main.cursor);

      const replayAfter = { receivedAt: time, platformId: '10' };
      const page2 = await api.importSmsBatch([smsRow('20', strongSms, time)], page1.cursor, { replayAfter });
      assert.deepEqual(page2.cursor, main.cursor);
      const nextReplayAfter = { receivedAt: time, platformId: '20' };
      await assert.rejects(
        api.importSmsBatch([smsRow('20', strongSms, time)], page2.cursor, { replayAfter: nextReplayAfter }),
        /ordered/,
      );
      await assert.rejects(
        api.importSmsBatch([], page2.cursor, { replayAfter: { receivedAt: time, platformId: '01' } }),
        /canonical positive Android row ID/,
      );
      const accessor = Object.defineProperty({}, 'replayAfter', { get: () => null });
      await assert.rejects(api.importSmsBatch([], page2.cursor, accessor as never), /plain values/);

      const advanced = await api.importSmsBatch([smsRow('100', strongSms, mainTime + 1_000)], page2.cursor);
      await assert.rejects(
        api.importSmsBatch([smsRow('30', strongSms, time)], page2.cursor, { replayAfter: nextReplayAfter }),
        /cursor is stale/,
      );
      assert.deepEqual(await api.getSmsImportCursor(), advanced.cursor);
      assert.equal(await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '30')).get(), undefined);
    } finally { fixture.sqlite.close(); }
  });

  it('fails an empty completion when protected SMS history has no key provider', async () => {
    const fixture = openTestLedger();
    try {
      const keyedApi = createApi(fixture);
      await keyedApi.migrateLedger();
      const imported = await keyedApi.importSmsBatch([smsRow('20')], null);
      const keyState = await fixture.ledger.db.select().from(importKeyState).get();
      const noProviderApi = createDataLayer(fixture.client, ledgerMigrations, undefined, transactionRunner(fixture.sqlite, fixture.client));

      await assert.rejects(noProviderApi.importSmsBatch([], imported.cursor, { catchupCompletedAt: strongSms.receivedAt + 1_000 }), /fingerprint provider/);

      assert.deepEqual(await keyedApi.getSmsImportCursor(), imported.cursor);
      assert.equal((await fixture.ledger.db.select().from(importKeyState).get())?.keyId, keyState?.keyId);
      assert.equal((await keyedApi.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
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

  it('records only an explicit empty catch-up completion without creating fingerprint state', async () => {
    const fixture = openTestLedger();
    try {
      const key = fingerprinter('fictional-empty-catchup-key');
      const policies: boolean[] = [];
      const provider: FingerprintKeyProvider = async (policy) => {
        policies.push(policy?.allowCreate ?? false);
        return key;
      };
      const api = createDataLayer(fixture.client, ledgerMigrations, provider, transactionRunner(fixture.sqlite, fixture.client));
      await api.migrateLedger();
      await api.setThemePreference('dark');

      assert.deepEqual(await api.getSmsImportHealth(), {
        lastSuccessfulCatchupAt: null,
        pendingReviewCount: 0,
        nonPostedReviewCount: 0,
      });
      assert.deepEqual(await api.importSmsBatch([], null), {
        cursor: null, inserted: 0, duplicate: 0, review: 0, ignored: 0,
      });
      assert.equal((await api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
      assert.equal(policies.length, 0, 'ordinary empty batches and health reads must not access the key provider');

      const completedAt = 1_800_000_000_003;
      await api.importSmsBatch([], null, { catchupCompletedAt: completedAt });
      assert.deepEqual(await api.getSmsImportHealth(), {
        lastSuccessfulCatchupAt: completedAt,
        pendingReviewCount: 0,
        nonPostedReviewCount: 0,
      });
      assert.equal(await fixture.ledger.db.select().from(smsImportState).get(), undefined);
      assert.equal(await fixture.ledger.db.select().from(importKeyState).get(), undefined);
      assert.equal((await fixture.ledger.db.select().from(preferences).where(eq(preferences.key, 'theme')).get())?.value, 'dark');

      await api.importSmsBatch([smsRow('100')], null);
      assert.deepEqual(policies, [true, false], 'the health marker must not block first-use key creation or final key verification');
    } finally { fixture.sqlite.close(); }
  });

  it('reports pending reviews and their non-posted subset, excluding resolved references', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      await addHdfcAccount(api);
      const normal = smsRow('101');
      const nonPosted = smsRow('102', {
        ...strongSms,
        body: strongSms.body.replace('debited', 'debited but failed').replace('612345678901', '612345678902'),
      }, strongSms.receivedAt + 1_000);
      await api.importSmsBatch([normal, nonPosted], null);
      assert.deepEqual(await api.getSmsImportHealth(), {
        lastSuccessfulCatchupAt: null,
        pendingReviewCount: 2,
        nonPostedReviewCount: 1,
      });

      const referenceId = smsReferenceId(fixture.sqlite, normal.platformId, normal.receivedAt);
      const prepared = await api.prepareSmsReview(referenceId, async () => normal);
      assert.equal(prepared.kind, 'ready');
      if (prepared.kind !== 'ready') throw new Error('Expected the fictional pending SMS to be reviewable');
      assert.deepEqual(
        await api.confirmSmsReview(referenceId, prepared, async () => normal),
        { kind: 'saved', referenceId, platformId: normal.platformId, transactionId: `sms:${referenceId}` },
      );
      assert.deepEqual(await api.getSmsImportHealth(), {
        lastSuccessfulCatchupAt: null,
        pendingReviewCount: 1,
        nonPostedReviewCount: 1,
      });
    } finally { fixture.sqlite.close(); }
  });

  it('rejects unsafe completion times and reports corrupt stored time without echoing it', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      for (const catchupCompletedAt of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(api.importSmsBatch([], null, { catchupCompletedAt }), /positive safe integer/);
      }
      await assert.rejects(
        api.importSmsBatch([], null, { catchupCompletedAt: 1_800_000_000_004, unexpected: true } as never),
        /invalid shape/,
      );
      assert.equal(await fixture.ledger.db.select().from(preferences)
        .where(eq(preferences.key, 'sms.last_successful_catchup_at')).get(), undefined);

      fixture.sqlite.prepare('INSERT INTO preferences(key, value) VALUES(?, ?)')
        .run('sms.last_successful_catchup_at', 'FICTIONAL_CORRUPT_TIMESTAMP');
      await assert.rejects(api.getSmsImportHealth(), (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).message, 'Stored SMS catch-up completion time is invalid');
        assert.equal((error as Error).message.includes('FICTIONAL_CORRUPT_TIMESTAMP'), false);
        return true;
      });
    } finally { fixture.sqlite.close(); }
  });

  it('uses the validated completion-time snapshot if row validation mutates options', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      const completedAt = 1_800_000_000_007;
      let capturedChecks = 0;
      let replacedChecks = 0;
      let capturedClockCalls = 0;
      const options = {
        catchupCompletedAt: () => { capturedClockCalls += 1; return completedAt; },
        assertSourceAccess: () => { capturedChecks += 1; },
      };
      const row = smsRow('150');
      Object.defineProperty(row, 'body', {
        configurable: true,
        enumerable: true,
        get() {
          options.catchupCompletedAt = () => { throw new Error('replacement clock called'); };
          options.assertSourceAccess = () => { replacedChecks += 1; };
          return strongSms.body;
        },
      });

      await api.importSmsBatch([row], null, options);

      assert.equal((await api.getSmsImportHealth()).lastSuccessfulCatchupAt, completedAt);
      assert.equal(capturedClockCalls, 1);
      assert.equal(capturedChecks, 6);
      assert.equal(replacedChecks, 0);
    } finally { fixture.sqlite.close(); }
  });

  it('checks source access inside the writer transaction and rolls back when it is revoked', async () => {
    const fixture = openTestLedger();
    try {
      const api = createApi(fixture);
      await api.migrateLedger();
      let checks = 0;
      const revoked = new Error('source access revoked');
      await assert.rejects(api.importSmsBatch([smsRow('151')], null, {
        assertSourceAccess() {
          checks += 1;
          if (checks === 2) throw revoked;
        },
      }), (error: unknown) => error === revoked);

      assert.equal(checks, 2);
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 0);
      assert.equal(await fixture.ledger.db.select().from(smsImportState).get(), undefined);
      assert.equal(await fixture.ledger.db.select().from(importKeyState).get(), undefined);
      assert.equal(await api.getSmsImportCursor(), null);
      assert.equal((await api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);

      await assert.rejects(api.importSmsBatch([], null, { assertSourceAccess: true } as never), /assertSourceAccess must be a function/);
      const accessor: Record<string, unknown> = {};
      Object.defineProperty(accessor, 'assertSourceAccess', { get: () => () => {} });
      await assert.rejects(api.importSmsBatch([], null, accessor as never), /plain values/);
    } finally { fixture.sqlite.close(); }
  });

  it('rolls back health with a failed final batch and leaves manual entry available after key loss', async () => {
    const fixture = openTestLedger();
    try {
      const key = fingerprinter('fictional-sms-key-loss');
      let keyAvailable = true;
      const policies: boolean[] = [];
      const provider: FingerprintKeyProvider = async (policy) => {
        policies.push(policy?.allowCreate ?? false);
        if (!keyAvailable) throw new FingerprintKeyUnavailableError();
        return key;
      };
      const api = createDataLayer(fixture.client, ledgerMigrations, provider, transactionRunner(fixture.sqlite, fixture.client));
      await api.migrateLedger();
      const previousSuccess = 1_800_000_000_005;
      const failedCompletion = 1_800_000_000_006;
      await api.importSmsBatch([], null, { catchupCompletedAt: previousSuccess });
      fixture.sqlite.exec(`CREATE TRIGGER reject_sms_health_update BEFORE UPDATE ON preferences
        WHEN NEW.key = 'sms.last_successful_catchup_at'
        BEGIN SELECT RAISE(ABORT, 'fictional health write failure'); END`);
      await assert.rejects(api.importSmsBatch([smsRow('200')], null, { catchupCompletedAt: failedCompletion }));
      assert.deepEqual(await api.getSmsImportHealth(), {
        lastSuccessfulCatchupAt: previousSuccess,
        pendingReviewCount: 0,
        nonPostedReviewCount: 0,
      });
      assert.equal(await api.getSmsImportCursor(), null);
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 0);
      assert.equal(await fixture.ledger.db.select().from(smsImportState).get(), undefined);
      assert.equal(await fixture.ledger.db.select().from(importKeyState).get(), undefined);
      fixture.sqlite.exec('DROP TRIGGER reject_sms_health_update');

      const first = await api.importSmsBatch([smsRow('201')], null, { catchupCompletedAt: previousSuccess });
      keyAvailable = false;
      await assert.rejects(api.importSmsBatch(
        [smsRow('202', strongSms, strongSms.receivedAt + 1_000)],
        first.cursor,
        { catchupCompletedAt: failedCompletion },
      ), FingerprintKeyUnavailableError);
      assert.deepEqual(await api.getSmsImportHealth(), {
        lastSuccessfulCatchupAt: previousSuccess,
        pendingReviewCount: 1,
        nonPostedReviewCount: 0,
      });
      assert.deepEqual(await api.getSmsImportCursor(), first.cursor);
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 1);

      await api.saveManualEntry({
        id: 'manual-after-sms-key-loss', amountInr: '1.25', direction: 'debit',
        occurredAt: new Date(1_800_000_000_000),
      });
      assert.equal(await api.getTransaction('manual-after-sms-key-loss') !== undefined, true);
      assert.deepEqual(policies, [true, false, true, false, false]);
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

  it('checks the cursor before key access and serializes only first-key provisioning', async () => {
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
      assert.deepEqual(policies, [true, false]);
      await assert.rejects(api.importSmsBatch([smsRow('62')], null), /cursor is stale/);
      assert.deepEqual(policies, [true, false], 'stale cursor must fail before key-store access');

      await api.createAccount({ id: 'hdfc-1234', name: 'Fictional HDFC', type: 'bank', institution: 'hdfc', last4: '1234' });
      const prepared = await api.preparePaste(strongSms);
      assert.equal(prepared.kind, 'needs-review');
      assert.deepEqual(policies, [true, false, false]);
      assert.equal(await api.saveReviewedPaste(prepared, { accountId: 'hdfc-1234' }), 'inserted');
      assert.deepEqual(policies, [true, false, false, false]);
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

  it('keeps the SQLite writer available while a batch fingerprint is pending', async () => {
    const temp = temporaryFile();
    const importFixture = openTestLedger(temp.filename);
    const manualFixture = openTestLedger(temp.filename);
    let releaseFingerprint!: () => void;
    const fingerprintGate = new Promise<void>((resolve) => { releaseFingerprint = resolve; });
    let notifyFingerprintStarted!: () => void;
    const fingerprintStarted = new Promise<void>((resolve) => { notifyFingerprintStarted = resolve; });
    try {
      const key = fingerprinter('fictional-sms-preflight-key');
      const initialApi = createDataLayer(
        importFixture.client, ledgerMigrations, async () => key, transactionRunner(importFixture.sqlite, importFixture.client),
      );
      const manualApi = createDataLayer(manualFixture.client, ledgerMigrations);
      await initialApi.migrateLedger();
      await manualApi.migrateLedger();
      const first = await initialApi.importSmsBatch([smsRow('230')], null);
      if (!first.cursor) throw new Error('Expected a saved cursor');

      const blockedKey: Fingerprinter = {
        keyId: key.keyId,
        async fingerprint(value) {
          notifyFingerprintStarted();
          await fingerprintGate;
          return key.fingerprint(value);
        },
      };
      const importingApi = createDataLayer(
        importFixture.client, ledgerMigrations, async () => blockedKey, transactionRunner(importFixture.sqlite, importFixture.client),
      );
      const pendingImport = importingApi.importSmsBatch(
        [smsRow('231', strongSms, strongSms.receivedAt + 1_000)], first.cursor,
      );
      await fingerprintStarted;

      await manualApi.saveManualEntry({
        id: 'manual-during-sms-preflight', amountInr: '1.25', direction: 'debit',
        occurredAt: new Date(strongSms.receivedAt + 2_000),
      });
      assert.ok(await manualApi.getTransaction('manual-during-sms-preflight'));

      releaseFingerprint();
      const result = await pendingImport;
      assert.equal(result.review, 1);
      assert.deepEqual(await importingApi.getSmsImportCursor(), { receivedAt: strongSms.receivedAt + 1_000, platformId: '231' });
    } finally {
      releaseFingerprint();
      importFixture.sqlite.close();
      manualFixture.sqlite.close();
      rmSync(temp.filename, { force: true });
      rmdirSync(temp.directory);
    }
  });

  it('revalidates the key after preflight and fails closed without leaking provider errors', async () => {
    for (const failure of ['lost', 'rotated', 'provider-error'] as const) {
      const fixture = openTestLedger();
      try {
        const key = fingerprinter('fictional-sms-key-before-preflight');
        const initialApi = createApi(fixture, key);
        await initialApi.migrateLedger();
        const first = await initialApi.importSmsBatch([smsRow('240')], null);
        if (!first.cursor) throw new Error('Expected a saved cursor');

        let providerCalls = 0;
        const provider: FingerprintKeyProvider = async () => {
          providerCalls += 1;
          if (providerCalls === 1) return key;
          if (failure === 'lost') throw new FingerprintKeyUnavailableError();
          if (failure === 'rotated') return fingerprinter('fictional-sms-key-after-preflight');
          throw new Error(strongSms.body);
        };
        const api = createDataLayer(fixture.client, ledgerMigrations, provider, transactionRunner(fixture.sqlite, fixture.client));

        await assert.rejects(api.importSmsBatch(
          [smsRow('241', strongSms, strongSms.receivedAt + 1_000)],
          first.cursor,
          { catchupCompletedAt: strongSms.receivedAt + 10_000 },
        ), (error: unknown) => {
          assert.equal(error instanceof Error, true);
          if (failure === 'lost') assert.equal(error instanceof FingerprintKeyUnavailableError, true);
          if (failure === 'rotated') assert.match((error as Error).message, /key changed|review/i);
          if (failure === 'provider-error') assert.equal((error as Error).message.includes(strongSms.body), false);
          return true;
        });

        assert.equal(providerCalls, 2);
        assert.deepEqual(await api.getSmsImportCursor(), first.cursor);
        assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 1);
        assert.equal((await fixture.ledger.db.select().from(importKeyState).get())?.keyId, key.keyId);
        assert.equal((await api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
      } finally { fixture.sqlite.close(); }
    }
  });

  it('rejects a stale cursor or revoked source after preflight without committing the pending batch', async () => {
    for (const scenario of ['cursor-changed', 'cancelled'] as const) {
      const temp = temporaryFile();
      const firstFixture = openTestLedger(temp.filename);
      const secondFixture = scenario === 'cursor-changed' ? openTestLedger(temp.filename) : undefined;
      let releaseFingerprint!: () => void;
      const fingerprintGate = new Promise<void>((resolve) => { releaseFingerprint = resolve; });
      let notifyFingerprintStarted!: () => void;
      const fingerprintStarted = new Promise<void>((resolve) => { notifyFingerprintStarted = resolve; });
      try {
        const key = fingerprinter(`fictional-sms-${scenario}-key`);
        const firstApi = createDataLayer(
          firstFixture.client, ledgerMigrations, async () => key, transactionRunner(firstFixture.sqlite, firstFixture.client),
        );
        await firstApi.migrateLedger();
        const first = await firstApi.importSmsBatch([smsRow('250')], null);
        if (!first.cursor) throw new Error('Expected a saved cursor');

        let fingerprintCalls = 0;
        const blockedKey: Fingerprinter = {
          keyId: key.keyId,
          async fingerprint(value) {
            fingerprintCalls += 1;
            notifyFingerprintStarted();
            await fingerprintGate;
            return key.fingerprint(value);
          },
        };
        const importingApi = createDataLayer(
          firstFixture.client, ledgerMigrations, async () => blockedKey, transactionRunner(firstFixture.sqlite, firstFixture.client),
        );
        let cancelled = false;
        const pending = importingApi.importSmsBatch(
          [
            smsRow('251', strongSms, strongSms.receivedAt + 1_000),
            smsRow('253', strongSms, strongSms.receivedAt + 1_500),
          ],
          first.cursor,
          {
            catchupCompletedAt: strongSms.receivedAt + 10_000,
            ...(scenario === 'cancelled' ? {
              assertSourceAccess: () => {
                if (cancelled) {
                  const aborted = new Error('The operation was aborted.');
                  aborted.name = 'AbortError';
                  throw aborted;
                }
              },
            } : {}),
          },
        );
        await fingerprintStarted;

        if (scenario === 'cursor-changed') {
          const secondApi = createDataLayer(
            secondFixture!.client, ledgerMigrations, async () => key,
            transactionRunner(secondFixture!.sqlite, secondFixture!.client),
          );
          await secondApi.importSmsBatch(
            [smsRow('252', strongSms, strongSms.receivedAt + 2_000)], first.cursor,
          );
        } else {
          cancelled = true;
        }
        releaseFingerprint();

        await assert.rejects(pending, scenario === 'cursor-changed' ? /cursor is stale/ : /aborted/i);
        assert.deepEqual(await firstApi.getSmsImportCursor(), scenario === 'cursor-changed'
          ? { receivedAt: strongSms.receivedAt + 2_000, platformId: '252' }
          : first.cursor);
        assert.equal((await firstFixture.ledger.db.select().from(smsImportRefs).all()).length, scenario === 'cursor-changed' ? 2 : 1);
        if (scenario === 'cancelled') assert.equal(fingerprintCalls, 4, 'the canceled preflight must not fingerprint the next row');
        assert.equal((await firstApi.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
      } finally {
        releaseFingerprint();
        firstFixture.sqlite.close();
        secondFixture?.sqlite.close();
        rmSync(temp.filename, { force: true });
        rmdirSync(temp.directory);
      }
    }
  });

  it('replays unchanged source content when a parser upgrade changes derived identity', async () => {
    const fixture = openTestLedger();
    try {
      const key = fingerprinter('fictional-sms-key');
      const api = createApi(fixture, key);
      await api.migrateLedger();
      await api.importSmsBatch([smsRow('81')], null);
      const oldIdentity = `body:${await key.fingerprint(JSON.stringify(['sms', strongSms.sender.toUpperCase(), strongSms.body]))}`;
      await fixture.ledger.db.update(smsImportRefs).set({ dedupeKey: oldIdentity, ruleVersion: 4 })
        .where(eq(smsImportRefs.platformId, '81')).run();
      const original = await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '81')).get();
      const expected = { receivedAt: strongSms.receivedAt - 1_000, platformId: '80' };
      await fixture.ledger.db.update(smsImportState).set({ cursorReceivedAt: expected.receivedAt, cursorPlatformId: expected.platformId })
        .where(eq(smsImportState.id, 1)).run();
      const current = await api.preparePaste(strongSms);
      assert.equal(current.kind, 'needs-review');
      if (current.kind !== 'needs-review') throw new Error('Fictional fixture must reach review');
      assert.equal(current.identity.dedupeKey.startsWith('upi:'), true);
      const result = await api.importSmsBatch([smsRow('81')], expected);
      assert.equal(result.duplicate, 1);
      assert.equal(result.inserted, 0);
      assert.deepEqual(await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, '81')).get(), original);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 0);
    } finally { fixture.sqlite.close(); }
  });

  it('rejects sender conflicts for an exact source tuple and accepts changed content as a new source', async () => {
    for (const change of ['sender', 'body', 'date'] as const) {
      const fixture = openTestLedger();
      try {
        const api = createApi(fixture);
        await api.migrateLedger();
        const imported = await api.importSmsBatch([smsRow('80')], null);
        assert.deepEqual(imported.cursor, { receivedAt: strongSms.receivedAt, platformId: '80' });
        const expected = { receivedAt: strongSms.receivedAt - 1_000, platformId: '79' };
        await fixture.ledger.db.update(smsImportState).set({
          cursorReceivedAt: expected.receivedAt,
          cursorPlatformId: expected.platformId,
        }).where(eq(smsImportState.id, 1)).run();
        const changed = change === 'sender'
          ? smsRow('80', { ...strongSms, sender: 'AD-FAKEBANK-S' }, strongSms.receivedAt)
          : change === 'body'
            ? smsRow('80', { ...strongSms, body: strongSms.body.replace('450.00', '451.00') })
            : smsRow('80', strongSms, strongSms.receivedAt + 1_000);
        if (change === 'sender') {
          await assert.rejects(api.importSmsBatch([changed], expected), /previously imported SMS row changed/);
          assert.deepEqual(await api.getSmsImportCursor(), expected);
          assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 1);
        } else {
          const next = await api.importSmsBatch([changed], expected);
          assert.deepEqual(next.cursor, { receivedAt: changed.receivedAt, platformId: changed.platformId });
          const refs = await fixture.ledger.db.select().from(smsImportRefs).all();
          assert.equal(refs.length, 2);
          assert.notEqual(refs[0]?.referenceId, refs[1]?.referenceId);
        }
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
            referenceId: 'legacy:legacy',
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
