/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';

describe('SMS review listing', () => {
  it('paginates review rows by timestamp and numeric platform ID without exposing source fingerprints', async () => {
    const fixture = openTestLedger();
    try {
      const api = createDataLayer(fixture.client, ledgerMigrations);
      await api.migrateLedger();
      const insert = fixture.sqlite.prepare(`INSERT INTO sms_import_refs
        (reference_id, platform_id, received_at, sender_hash, dedupe_key, body_hash, key_id, status, reason, rule_id, rule_version, transaction_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
      const add = (id: string, status: 'review' | 'saved' | 'duplicate', receivedAt = 100) => insert.run(
        `legacy:${id}`, id, receivedAt, `sender-secret-${id}`, `dedupe-secret-${id}`, `body-secret-${id}`, `key-secret-${id}`,
        status, status === 'review' ? 'unknown_format' : null, status === 'review' ? 'fictional.rule' : null,
        status === 'review' ? 7 : null, 1,
      );

      add('2', 'review');
      add('3', 'duplicate');
      add('4', 'saved');
      add('9', 'review');
      add('10', 'review');
      add('9007199254740992', 'review');
      add('9007199254740993', 'review');
      add('9223372036854775807', 'review');
      add('1', 'review', 101);

      const first = await api.getSmsReviewPage({ limit: 2 });
      assert.deepEqual(first.rows.map(({ platformId }) => platformId), ['2', '9']);
      assert.deepEqual(first.nextCursor, { receivedAt: 100, platformId: '9', referenceId: 'legacy:9' });
      assert.deepEqual(Object.keys(first.rows[0]!).sort(), ['referenceId', 'platformId', 'reason', 'receivedAt', 'ruleId', 'ruleVersion'].sort());
      assert.equal(JSON.stringify(first).includes('secret'), false);

      fixture.sqlite.prepare("UPDATE sms_import_refs SET status = 'duplicate', reason = NULL WHERE platform_id = '9'").run();
      const second = await api.getSmsReviewPage({ limit: 3, after: first.nextCursor! });
      assert.deepEqual(second.rows.map(({ platformId }) => platformId), ['10', '9007199254740992', '9007199254740993']);
      assert.deepEqual(second.nextCursor, { receivedAt: 100, platformId: '9007199254740993', referenceId: 'legacy:9007199254740993' });

      const third = await api.getSmsReviewPage({ limit: 2, after: second.nextCursor! });
      assert.deepEqual(third.rows.map(({ platformId }) => platformId), ['9223372036854775807', '1']);
      assert.equal(Object.hasOwn(third, 'nextCursor'), false);
      assert.deepEqual(await api.getSmsReviewPage({ after: { receivedAt: 100, platformId: '9223372036854775807', referenceId: 'legacy:9223372036854775807' } }), {
        rows: [{ referenceId: 'legacy:1', platformId: '1', receivedAt: 101, reason: 'unknown_format', ruleId: 'fictional.rule', ruleVersion: 7 }],
      });
    } finally { fixture.sqlite.close(); }
  });

  it('rejects invalid limits, cursors and option fields at the API boundary', async () => {
    const fixture = openTestLedger();
    try {
      const api = createDataLayer(fixture.client, ledgerMigrations);
      await api.migrateLedger();
      const getPage = api.getSmsReviewPage as (options: unknown) => Promise<unknown>;
      for (const options of [
        null,
        [],
        { limit: null },
        { limit: '10' },
        { limit: 0 },
        { limit: 101 },
        { limit: 1.5 },
        { after: { receivedAt: 100, platformId: '01', referenceId: 'legacy:01' } },
        { after: { receivedAt: 100, platformId: '9223372036854775808', referenceId: 'legacy:9223372036854775808' } },
        { after: { receivedAt: 100, platformId: '9223372036854775807', referenceId: 'legacy:9223372036854775807' }, limit: 0 },
        { after: { receivedAt: Number.MAX_SAFE_INTEGER + 1, platformId: '1', referenceId: 'legacy:1' } },
        { after: { receivedAt: 100, platformId: '1', referenceId: 'legacy:1', body: 'not allowed' } },
        { after: { receivedAt: 100, platformId: '1' } },
        { after: { receivedAt: 100, platformId: '1', referenceId: 'invalid ref id' } },
        { unexpected: true },
      ]) {
        await assert.rejects(getPage(options));
      }
      assert.deepEqual(await api.getSmsReviewPage(), { rows: [] });
      assert.deepEqual(await api.getSmsReviewPage({ after: null }), { rows: [] });
      assert.deepEqual(await api.getSmsReviewPage({ after: undefined }), { rows: [] });
    } finally { fixture.sqlite.close(); }
  });

  it('caps the default page at 100 and resumes with the last returned cursor', async () => {
    const fixture = openTestLedger();
    try {
      const api = createDataLayer(fixture.client, ledgerMigrations);
      await api.migrateLedger();
      const insert = fixture.sqlite.prepare(`INSERT INTO sms_import_refs
        (reference_id, platform_id, received_at, sender_hash, dedupe_key, body_hash, key_id, status, reason, created_at)
        VALUES (?, ?, 100, 'sender', 'dedupe', ?, 'key', 'review', 'unknown_format', 1)`);
      for (let id = 1; id <= 101; id += 1) insert.run(`legacy:${id}`, String(id), `body:${id}`);

      const first = await api.getSmsReviewPage();
      assert.equal(first.rows.length, 100);
      assert.deepEqual(first.nextCursor, { receivedAt: 100, platformId: '100', referenceId: 'legacy:100' });
      const second = await api.getSmsReviewPage({ after: first.nextCursor! });
      assert.deepEqual(second.rows.map(({ platformId }) => platformId), ['101']);
      assert.equal(Object.hasOwn(second, 'nextCursor'), false);
    } finally { fixture.sqlite.close(); }
  });

  it('continues past same-time rows that share a recycled platform ID', async () => {
    const fixture = openTestLedger();
    try {
      const api = createDataLayer(fixture.client, ledgerMigrations);
      await api.migrateLedger();
      const insert = fixture.sqlite.prepare(`INSERT INTO sms_import_refs
        (reference_id, platform_id, received_at, sender_hash, dedupe_key, body_hash, key_id, status, reason, created_at)
        VALUES (?, '22', 100, 'sender', 'dedupe', ?, 'key', 'review', 'unknown_format', 1)`);
      insert.run('0'.repeat(64), 'a'.repeat(64));
      insert.run('f'.repeat(64), 'b'.repeat(64));

      const first = await api.getSmsReviewPage({ limit: 1 });
      assert.equal(first.rows[0]?.referenceId, '0'.repeat(64));
      const second = await api.getSmsReviewPage({ limit: 1, after: first.nextCursor! });
      assert.deepEqual(second.rows.map(({ referenceId }) => referenceId), ['f'.repeat(64)]);
      assert.equal(Object.hasOwn(second, 'nextCursor'), false);
    } finally { fixture.sqlite.close(); }
  });
});
