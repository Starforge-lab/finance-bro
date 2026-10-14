/// <reference types="node" />

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import type { LedgerSQLiteClient, LedgerSQLiteTransactionRunner } from '../src/db/ledger';
import type { FingerprintKeyPolicy, FingerprintKeyProvider, Fingerprinter } from '../src/imports/fingerprint';
import { FingerprintKeyUnavailableError } from '../src/imports/fingerprint';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';
import { smsReferenceId } from './helpers/sms';

const source = {
  platformId: '72',
  sender: 'VM-HDFCBK-S',
  body: 'INR 450.00 debited from A/c XX1234 to VPA fictional@axisbank (UPI Ref No 612345678901).',
  receivedAt: Date.parse('2026-10-07T10:00:00.000Z'),
};
const fixtureSecret = 'fictional-sms-review-key';

function fingerprinter(secret = fixtureSecret): Fingerprinter {
  return {
    keyId: createHmac('sha256', secret).update('fictional-key-id').digest('hex'),
    async fingerprint(value) { return createHmac('sha256', secret).update(value).digest('hex'); },
  };
}

function transactionRunner(sqlite: DatabaseSync, client: LedgerSQLiteClient): LedgerSQLiteTransactionRunner {
  return async (task) => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { await task(client); sqlite.exec('COMMIT'); }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
}

async function fixture() {
  const test = openTestLedger();
  const key = fingerprinter();
  const policies: FingerprintKeyPolicy[] = [];
  const provider: FingerprintKeyProvider = async (policy) => {
    if (policy) policies.push(policy);
    return key;
  };
  const api = createDataLayer(test.client, ledgerMigrations, provider, transactionRunner(test.sqlite, test.client));
  await api.migrateLedger();
  await api.importSmsBatch([source], null);
  return { ...test, key, policies, api, provider, referenceId: smsReferenceId(test.sqlite, source.platformId, source.receivedAt) };
}

function totalChanges(sqlite: DatabaseSync): number {
  return (sqlite.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
}

describe('selected Android SMS review preparation', () => {
  it('re-reads one pending source and returns only its transient paste preparation', async () => {
    const test = await fixture();
    try {
      const before = totalChanges(test.sqlite);
      let calls = 0;
      const result = await test.api.prepareSmsReview(test.referenceId, async (id) => {
        calls += 1;
        assert.equal(id, source.platformId);
        return { ...source };
      });
      assert.equal(result.kind, 'ready');
      if (result.kind !== 'ready') throw new Error('Expected selected SMS to be ready for review');
      assert.equal(result.referenceId, test.referenceId);
      assert.equal(result.platformId, source.platformId);
      assert.equal(result.receivedAt, source.receivedAt);
      assert.equal(result.preparation.kind, 'needs-review');
      assert.equal(result.preparation.candidate?.amountPaise, 45_000);
      assert.deepEqual(test.policies.at(-1), { allowCreate: false });
      assert.equal(calls, 1);
      assert.equal(totalChanges(test.sqlite), before);
      const serialized = JSON.stringify(result);
      for (const privateValue of [source.body, source.sender, fixtureSecret]) assert.equal(serialized.includes(privateValue), false);
    } finally { test.sqlite.close(); }
  });

  it('does not call the reader for non-pending rows, missing keys, or mismatched history', async () => {
    const test = await fixture();
    try {
      let calls = 0;
      const reader = async () => { calls += 1; return { ...source }; };
      assert.deepEqual(await test.api.prepareSmsReview('f'.repeat(64), reader), {
        kind: 'unavailable', referenceId: 'f'.repeat(64), platformId: null, reason: 'not_pending',
      });
      assert.equal(calls, 0);

      const lostKey = createDataLayer(test.client, ledgerMigrations, async () => {
        throw new FingerprintKeyUnavailableError();
      });
      assert.deepEqual(await lostKey.prepareSmsReview(test.referenceId, reader), {
        kind: 'unavailable', referenceId: test.referenceId, platformId: source.platformId, reason: 'key_unavailable',
      });
      assert.equal(calls, 0);

      const changedKey = createDataLayer(test.client, ledgerMigrations, async () => fingerprinter('fictional-replacement-key'));
      assert.deepEqual(await changedKey.prepareSmsReview(test.referenceId, reader), {
        kind: 'unavailable', referenceId: test.referenceId, platformId: source.platformId, reason: 'key_unavailable',
      });
      assert.equal(calls, 0);

      const failedStore = createDataLayer(test.client, ledgerMigrations, async () => {
        throw new Error('FICTIONAL_PRIVATE_KEYSTORE_FAILURE');
      });
      const changesBeforeFailedStore = totalChanges(test.sqlite);
      const failedStoreResult = await failedStore.prepareSmsReview(test.referenceId, reader);
      assert.deepEqual(failedStoreResult, {
        kind: 'unavailable', referenceId: test.referenceId, platformId: source.platformId, reason: 'key_unavailable',
      });
      assert.equal(JSON.stringify(failedStoreResult).includes('FICTIONAL_PRIVATE_KEYSTORE_FAILURE'), false);
      assert.equal(calls, 0);
      assert.equal(totalChanges(test.sqlite), changesBeforeFailedStore);

      test.sqlite.prepare("UPDATE import_key_state SET key_id = 'legacy' WHERE id = 1").run();
      assert.deepEqual(await test.api.prepareSmsReview(test.referenceId, reader), {
        kind: 'unavailable', referenceId: test.referenceId, platformId: source.platformId, reason: 'key_unavailable',
      });
      assert.equal(calls, 0);
    } finally { test.sqlite.close(); }
  });

  it('keeps storage-read failures distinct from provider and inbox failures', async () => {
    const test = await fixture();
    try {
      for (const failAt of [1, 3]) {
        let reads = 0;
        const basePrepare = test.client.prepareAsync.bind(test.client);
        const failingClient = {
          ...test.client,
          prepareAsync: async (query: string) => {
            reads += 1;
            if (reads === failAt) throw new Error('FICTIONAL_PRIVATE_DATABASE_FAILURE');
            return basePrepare(query);
          },
        };
        const api = createDataLayer(failingClient, ledgerMigrations, async () => test.key);
        let sourceCalls = 0;
        const before = totalChanges(test.sqlite);
        const result = await api.prepareSmsReview(test.referenceId, async () => {
          sourceCalls += 1;
          return { ...source };
        });
        assert.deepEqual(result, {
          kind: 'unavailable', referenceId: test.referenceId, platformId: failAt === 1 ? null : source.platformId, reason: 'storage_unavailable',
        });
        assert.equal(JSON.stringify(result).includes('FICTIONAL_PRIVATE_DATABASE_FAILURE'), false);
        assert.equal(sourceCalls, 0);
        assert.equal(totalChanges(test.sqlite), before);
      }
    } finally { test.sqlite.close(); }
  });

  it('classifies fingerprint hashing failures as key loss without returning provider errors', async () => {
    const test = await fixture();
    try {
      const brokenFingerprinter: Fingerprinter = {
        keyId: test.key.keyId,
        async fingerprint() { throw new Error('FICTIONAL_PRIVATE_SIGNING_FAILURE'); },
      };
      const api = createDataLayer(test.client, ledgerMigrations, async () => brokenFingerprinter);
      let calls = 0;
      const before = totalChanges(test.sqlite);
      const result = await api.prepareSmsReview(test.referenceId, async () => {
        calls += 1;
        return { ...source };
      });
      assert.deepEqual(result, { kind: 'unavailable', referenceId: test.referenceId, platformId: source.platformId, reason: 'key_unavailable' });
      assert.equal(JSON.stringify(result).includes('FICTIONAL_PRIVATE_SIGNING_FAILURE'), false);
      assert.equal(calls, 1);
      assert.equal(totalChanges(test.sqlite), before);
    } finally { test.sqlite.close(); }
  });

  it('reports deleted, changed, malformed and no-longer-financial source rows without returning source text', async () => {
    for (const [read, reason] of [
      [async () => null, 'missing_original'],
      [async () => ({ ...source, platformId: '73' }), 'source_changed'],
      [async () => ({ ...source, receivedAt: source.receivedAt + 1 }), 'source_changed'],
      [async () => ({ ...source, sender: 'AD-HDFCBK-S' }), 'source_changed'],
      [async () => ({ ...source, body: `${source.body} changed` }), 'source_changed'],
      [async () => ({ ...source, sender: '' }), 'source_changed'],
      [async () => ({ ...source, extra: 'not accepted' }), 'source_changed'],
    ] as const) {
      const test = await fixture();
      try {
        const result = await test.api.prepareSmsReview(test.referenceId, read);
        assert.deepEqual(result, { kind: 'unavailable', referenceId: test.referenceId, platformId: source.platformId, reason });
        assert.equal(JSON.stringify(result).includes(source.body), false);
      } finally { test.sqlite.close(); }
    }
  });

  it('does not offer confirmation when the same source now parses as ignored', async () => {
    const test = await fixture();
    try {
      const ignored = { ...source, body: 'Your account is eligible for a fictional offer.' };
      const bodyHash = await test.key.fingerprint(JSON.stringify(['body', ignored.body]));
      const senderHash = await test.key.fingerprint(JSON.stringify(['sender', ignored.sender.trim().toUpperCase()]));
      test.sqlite.prepare('UPDATE sms_import_refs SET body_hash = ?, sender_hash = ? WHERE reference_id = ?')
        .run(bodyHash, senderHash, test.referenceId);
      const result = await test.api.prepareSmsReview(test.referenceId, async () => ignored);
      assert.deepEqual(result, { kind: 'unavailable', referenceId: test.referenceId, platformId: source.platformId, reason: 'no_longer_financial' });
    } finally { test.sqlite.close(); }
  });

  it('permits parser-derived identity changes when the keyed source proof still matches', async () => {
    const test = await fixture();
    try {
      test.sqlite.prepare('UPDATE sms_import_refs SET dedupe_key = ?, rule_version = 4 WHERE reference_id = ?')
        .run(`body:${'a'.repeat(64)}`, test.referenceId);
      const result = await test.api.prepareSmsReview(test.referenceId, async () => ({ ...source }));
      assert.equal(result.kind, 'ready');
      if (result.kind !== 'ready') throw new Error('Expected unchanged source to remain reviewable after parser identity change');
      assert.notEqual(result.preparation.identity.dedupeKey, `body:${'a'.repeat(64)}`);
    } finally { test.sqlite.close(); }
  });

  it('does not return a row that becomes resolved while its original is being read', async () => {
    const test = await fixture();
    try {
      const result = await test.api.prepareSmsReview(test.referenceId, async () => {
        test.sqlite.prepare("UPDATE sms_import_refs SET status = 'duplicate' WHERE reference_id = ?").run(test.referenceId);
        return { ...source };
      });
      assert.deepEqual(result, { kind: 'unavailable', referenceId: test.referenceId, platformId: source.platformId, reason: 'not_pending' });
    } finally { test.sqlite.close(); }
  });

  it('keeps transient source failures private and preserves cancellation', async () => {
    const test = await fixture();
    try {
      const result = await test.api.prepareSmsReview(test.referenceId, async () => {
        throw new Error('FICTIONAL_PRIVATE_SOURCE_FAILURE');
      });
      assert.deepEqual(result, { kind: 'unavailable', referenceId: test.referenceId, platformId: source.platformId, reason: 'source_unavailable' });
      assert.equal(JSON.stringify(result).includes('FICTIONAL_PRIVATE_SOURCE_FAILURE'), false);

      const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' });
      await assert.rejects(test.api.prepareSmsReview(test.referenceId, async () => { throw cancelled; }), (error) => error === cancelled);
    } finally { test.sqlite.close(); }
  });

  it('validates the ID and callback before any provider or reader use', async () => {
    const test = await fixture();
    try {
      let calls = 0;
      const api = createDataLayer(test.client, ledgerMigrations, async () => {
        calls += 1;
        return test.key;
      });
      const prepare = api.prepareSmsReview as (referenceId: unknown, reader: unknown) => Promise<unknown>;
      await assert.rejects(prepare('bad ref', async () => { calls += 1; return { ...source }; }));
      await assert.rejects(prepare(test.referenceId, null));
      assert.equal(calls, 0);
    } finally { test.sqlite.close(); }
  });
});
