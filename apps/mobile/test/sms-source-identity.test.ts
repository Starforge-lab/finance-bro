/// <reference types="node" />

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { describe, it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import type { LedgerSQLiteClient, LedgerSQLiteTransactionRunner } from '../src/db/ledger';
import { smsImportRefs, smsImportState, transactions } from '../src/db/schema';
import type { Fingerprinter } from '../src/imports/fingerprint';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';
import { smsReferenceId } from './helpers/sms';

const firstReceivedAt = Date.parse('2026-10-07T10:00:00.000Z');
const first = {
  platformId: '55',
  sender: 'VM-HDFCBK-S',
  body: 'INR 450.00 debited from A/c XX1234 to VPA fictional@axisbank (UPI Ref No 612345678901).',
  receivedAt: firstReceivedAt,
};
const recycled = {
  ...first,
  receivedAt: firstReceivedAt + 60_000,
  body: 'INR 450.00 debited from A/c XX1234 to VPA fictional@axisbank (UPI Ref No 612345678902).',
};

function fingerprinter(): Fingerprinter {
  const key = 'fictional-source-identity-key';
  return {
    keyId: createHmac('sha256', key).update('fictional-key-id').digest('hex'),
    async fingerprint(value) { return createHmac('sha256', key).update(value).digest('hex'); },
  };
}

function transactionRunner(sqlite: DatabaseSync, client: LedgerSQLiteClient): LedgerSQLiteTransactionRunner {
  return async (task) => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { await task(client); sqlite.exec('COMMIT'); }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
}

describe('Android SMS source identity', () => {
  it('keeps reused platform IDs as separate sources and replays an exact tuple as a duplicate', async () => {
    const fixture = openTestLedger();
    try {
      const api = createDataLayer(fixture.client, ledgerMigrations, async () => fingerprinter(), transactionRunner(fixture.sqlite, fixture.client));
      await api.migrateLedger();

      const initial = await api.importSmsBatch([first], null);
      const next = await api.importSmsBatch([recycled], initial.cursor);
      assert.deepEqual(next.cursor, { receivedAt: recycled.receivedAt, platformId: recycled.platformId });

      const refs = await fixture.ledger.db.select().from(smsImportRefs)
        .where(eq(smsImportRefs.platformId, first.platformId)).all();
      assert.equal(refs.length, 2);
      assert.deepEqual(refs.map(({ receivedAt }) => receivedAt).sort(), [first.receivedAt, recycled.receivedAt]);

      await fixture.ledger.db.update(smsImportState).set({
        cursorReceivedAt: recycled.receivedAt - 1,
        cursorPlatformId: recycled.platformId,
      }).where(eq(smsImportState.id, 1)).run();
      const retry = await api.importSmsBatch([recycled], { receivedAt: recycled.receivedAt - 1, platformId: recycled.platformId });
      assert.equal(retry.duplicate, 1);
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs)
        .where(eq(smsImportRefs.platformId, first.platformId)).all()).length, 2);
    } finally { fixture.sqlite.close(); }
  });

  it('keeps an old review selection bound to its source when Android recycles the platform ID', async () => {
    const fixture = openTestLedger();
    try {
      const api = createDataLayer(fixture.client, ledgerMigrations, async () => fingerprinter(), transactionRunner(fixture.sqlite, fixture.client));
      await api.migrateLedger();
      await api.importSmsBatch([first], null);
      const oldReferenceId = smsReferenceId(fixture.sqlite, first.platformId, first.receivedAt);
      const expected = await api.prepareSmsReview(oldReferenceId, async () => ({ ...first }));
      assert.equal(expected.kind, 'ready');
      if (expected.kind !== 'ready') throw new Error('Expected the first source to be reviewable');

      await api.importSmsBatch([recycled], { receivedAt: first.receivedAt, platformId: first.platformId });
      const result = await api.confirmSmsReview(oldReferenceId, expected, async () => ({ ...recycled }));

      assert.deepEqual(result, {
        kind: 'unavailable', referenceId: oldReferenceId, platformId: first.platformId, reason: 'source_changed',
      });
      const refs = await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, first.platformId)).all();
      assert.equal(refs.length, 2);
      assert.equal(refs.every(({ status }) => status === 'review'), true);
      assert.equal((await fixture.ledger.db.select().from(transactions).all()).length, 0);
    } finally { fixture.sqlite.close(); }
  });

  it('does not fail ignored or unreadable sources solely because their platform ID was seen before', async () => {
    for (const body of ['  ', 'Your account is eligible for a fictional offer.']) {
      const fixture = openTestLedger();
      try {
        const api = createDataLayer(fixture.client, ledgerMigrations, async () => fingerprinter(), transactionRunner(fixture.sqlite, fixture.client));
        await api.migrateLedger();
        const initial = await api.importSmsBatch([first], null);
        const changed = { ...recycled, body };
        const result = await api.importSmsBatch([changed], initial.cursor);

        assert.deepEqual(result.cursor, { receivedAt: changed.receivedAt, platformId: changed.platformId });
        if (body.trim().length === 0) {
          assert.equal(result.review, 1);
          assert.equal((await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, first.platformId)).all()).length, 2);
        } else {
          assert.equal(result.ignored, 1);
          assert.equal((await fixture.ledger.db.select().from(smsImportRefs).where(eq(smsImportRefs.platformId, first.platformId)).all()).length, 1);
        }
      } finally { fixture.sqlite.close(); }
    }
  });

  it('checks sender identity for an exact ignored-source tuple without stalling on a recycled ID', async () => {
    const fixture = openTestLedger();
    try {
      const key = fingerprinter();
      const api = createDataLayer(fixture.client, ledgerMigrations, async () => key, transactionRunner(fixture.sqlite, fixture.client));
      await api.migrateLedger();
      const ignored = { ...first, body: 'Your account is eligible for a fictional offer.' };
      const initial = await api.importSmsBatch([ignored], null);
      assert.equal(initial.ignored, 1);

      const [senderHash, bodyHash] = await Promise.all([
        key.fingerprint(JSON.stringify(['sender', ignored.sender.toUpperCase()])),
        key.fingerprint(JSON.stringify(['body', ignored.body])),
      ]);
      fixture.sqlite.prepare(`INSERT INTO sms_import_refs
        (reference_id,platform_id,received_at,sender_hash,dedupe_key,body_hash,key_id,status,reason,rule_id,rule_version,transaction_id,created_at)
        VALUES ('legacy:55',?,?,?,?,?,?,'review','unknown_format',NULL,NULL,NULL,1)`)
        .run(ignored.platformId, ignored.receivedAt, senderHash, `body:${bodyHash}`, bodyHash, key.keyId);

      const recycledIgnored = { ...ignored, receivedAt: ignored.receivedAt + 60_000 };
      const recycledResult = await api.importSmsBatch([recycledIgnored], initial.cursor);
      assert.equal(recycledResult.ignored, 1);
      assert.deepEqual(recycledResult.cursor, { receivedAt: recycledIgnored.receivedAt, platformId: recycledIgnored.platformId });

      await fixture.ledger.db.update(smsImportState).set({
        cursorReceivedAt: ignored.receivedAt - 1,
        cursorPlatformId: ignored.platformId,
      }).where(eq(smsImportState.id, 1)).run();
      const retry = await api.importSmsBatch([ignored], { receivedAt: ignored.receivedAt - 1, platformId: ignored.platformId });
      assert.equal(retry.ignored, 1);

      await fixture.ledger.db.update(smsImportState).set({
        cursorReceivedAt: ignored.receivedAt - 1,
        cursorPlatformId: ignored.platformId,
      }).where(eq(smsImportState.id, 1)).run();
      await assert.rejects(
        api.importSmsBatch([{ ...ignored, sender: 'AD-FAKE-S' }], { receivedAt: ignored.receivedAt - 1, platformId: ignored.platformId }),
        /previously imported SMS row changed/,
      );
      assert.deepEqual(await api.getSmsImportCursor(), { receivedAt: ignored.receivedAt - 1, platformId: ignored.platformId });
    } finally { fixture.sqlite.close(); }
  });

  it('does not expose source text when a fingerprint provider fails on a legacy ignored reference', async () => {
    const fixture = openTestLedger();
    const ignored = { ...first, body: 'FICTIONAL_PRIVATE_OFFER_MESSAGE: Your account is eligible for a fictional offer.' };
    const key = fingerprinter();
    let failForSource = false;
    const api = createDataLayer(fixture.client, ledgerMigrations, async () => ({
      ...key,
      async fingerprint(value) {
        if (failForSource && value.includes(ignored.body)) throw new Error(value);
        return key.fingerprint(value);
      },
    }), transactionRunner(fixture.sqlite, fixture.client));
    try {
      await api.migrateLedger();
      const initial = await api.importSmsBatch([ignored], null);
      assert.equal(initial.ignored, 1);
      const [senderHash, bodyHash] = await Promise.all([
        key.fingerprint(JSON.stringify(['sender', ignored.sender.toUpperCase()])),
        key.fingerprint(JSON.stringify(['body', ignored.body])),
      ]);
      fixture.sqlite.prepare(`INSERT INTO sms_import_refs
        (reference_id,platform_id,received_at,sender_hash,dedupe_key,body_hash,key_id,status,reason,rule_id,rule_version,transaction_id,created_at)
        VALUES ('legacy:55',?,?,?,?,?,?,'review','unknown_format',NULL,NULL,NULL,1)`)
        .run(ignored.platformId, ignored.receivedAt, senderHash, `body:${bodyHash}`, bodyHash, key.keyId);
      const replayCursor = { receivedAt: firstReceivedAt - 1, platformId: '54' };
      await fixture.ledger.db.update(smsImportState).set({
        cursorReceivedAt: replayCursor.receivedAt,
        cursorPlatformId: replayCursor.platformId,
      }).where(eq(smsImportState.id, 1)).run();
      failForSource = true;

      await assert.rejects(api.importSmsBatch([ignored], replayCursor), (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).message, 'Unable to create keyed SMS fingerprint');
        assert.equal((error as Error).message.includes(ignored.body), false);
        return true;
      });
      assert.deepEqual(await api.getSmsImportCursor(), replayCursor);
      assert.equal((await fixture.ledger.db.select().from(smsImportRefs).all()).length, 1);
    } finally { fixture.sqlite.close(); }
  });
});
