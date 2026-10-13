/// <reference types="node" />

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import type { LedgerSQLiteClient, LedgerSQLiteTransactionRunner } from '../src/db/ledger';
import { importKeyState, smsImportRefs, smsImportState } from '../src/db/schema';
import { FingerprintKeyUnavailableError, type FingerprintKeyProvider, type Fingerprinter } from '../src/imports/fingerprint';
import {
  AndroidSmsCatchupError,
  catchUpAndroidSms,
  type AndroidSmsReader,
  type AndroidSmsReaderCursor,
  type AndroidSmsReaderMessage,
} from '../src/imports/android-sms-catchup';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';

const start = 1_800_000_000_000;
const body = 'INR 450.00 debited from A/c XX1234 to VPA fictional@axisbank (UPI Ref No 612345678901).';
const permissions = { readSms: true, receiveSms: true, granted: true };
const maxWindowMs = 90 * 24 * 60 * 60 * 1_000;

type Query = Parameters<AndroidSmsReader['queryInboxAsync']>[0];
type QueryResult = { messages: AndroidSmsReaderMessage[]; next: AndroidSmsReaderCursor | null };

function fingerprinter(fingerprint: (value: string) => Promise<string> = async (value) => createHmac('sha256', 'fictional-sms-key').update(value).digest('hex')): Fingerprinter {
  return { keyId: 'a'.repeat(64), fingerprint };
}

function transactionRunner(sqlite: DatabaseSync, client: LedgerSQLiteClient): LedgerSQLiteTransactionRunner {
  return async (task) => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { await task(client); sqlite.exec('COMMIT'); }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
}

function openApi(provider: FingerprintKeyProvider = async () => fingerprinter()) {
  const fixture = openTestLedger();
  const api = createDataLayer(fixture.client, ledgerMigrations, provider, transactionRunner(fixture.sqlite, fixture.client));
  return { fixture, api };
}

function sms(id: string, dateMs = start): AndroidSmsReaderMessage {
  return { id, dateMs, sender: 'VM-HDFCBK-S', body };
}

function fakeReader(
  query: (options: Query, index: number) => QueryResult | Promise<QueryResult>,
  initialPermissions = permissions,
) {
  const calls: Query[] = [];
  const state = { ...initialPermissions };
  const reader: AndroidSmsReader = {
    async getPermissionsAsync() { return { ...state }; },
    async queryInboxAsync(options) {
      calls.push({ ...options, ...(options.after ? { after: { ...options.after } } : {}) });
      return query(options, calls.length - 1);
    },
  };
  return { reader, calls, state };
}

function storageSpy(api: ReturnType<typeof openApi>['api']) {
  let cursorReads = 0;
  let writes = 0;
  return {
    storage: {
      async getSmsImportCursor() { cursorReads += 1; return api.getSmsImportCursor(); },
      importSmsBatch(rows: Parameters<typeof api.importSmsBatch>[0], cursor: Parameters<typeof api.importSmsBatch>[1], options?: Parameters<typeof api.importSmsBatch>[2]) {
        writes += 1;
        return api.importSmsBatch(rows, cursor, options);
      },
    },
    get cursorReads() { return cursorReads; },
    get writes() { return writes; },
  };
}

async function catchup(
  reader: AndroidSmsReader,
  storage: ReturnType<typeof storageSpy>['storage'],
  startDateMs = start,
  endDateMs = start,
  signal?: AbortSignal,
  clock: () => number = () => start + 10_000,
) {
  return catchUpAndroidSms({ reader, storage, startDateMs, endDateMs, ...(signal ? { signal } : {}), clock });
}

describe('Android SMS foreground catch-up coordinator', () => {
  it('does not read the inbox or write when either permission is denied, and stops after post-read revocation', async () => {
    const fixture = openApi();
    try {
      await fixture.api.migrateLedger();
      const denied = fakeReader(() => ({ messages: [], next: null }), { readSms: true, receiveSms: false, granted: false });
      const deniedStorage = storageSpy(fixture.api);
      await assert.rejects(catchup(denied.reader, deniedStorage.storage), (error: unknown) =>
        error instanceof AndroidSmsCatchupError && error.code === 'permission_denied');
      assert.equal(denied.calls.length, 0);
      assert.equal(deniedStorage.cursorReads, 0);
      assert.equal(deniedStorage.writes, 0);

      const revoked = fakeReader(() => {
        revoked.state.readSms = false;
        revoked.state.granted = false;
        return { messages: [sms('1')], next: null };
      });
      const revokedStorage = storageSpy(fixture.api);
      await assert.rejects(catchup(revoked.reader, revokedStorage.storage), (error: unknown) =>
        error instanceof AndroidSmsCatchupError && error.code === 'permission_denied');
      assert.equal(revoked.calls.length, 1);
      assert.equal(revokedStorage.writes, 0);
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
      assert.equal(await fixture.api.getSmsImportCursor(), null);
    } finally { fixture.fixture.sqlite.close(); }
  });

  it('paginates IDs beyond the safe-number range and records completion only on the empty final page', async () => {
    const fixture = openApi();
    try {
      await fixture.api.migrateLedger();
      const ids = ['9007199254740999', '9007199254741000'];
      let clockCalls = 0;
      const reader = fakeReader(async (options, index) => {
        if (index === 0) {
          const first = sms(ids[0]!);
          return { messages: [first], next: { dateMs: first.dateMs, id: first.id } };
        }
        assert.equal(clockCalls, 0);
        assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
        if (index === 1) {
          assert.deepEqual(options.after, { dateMs: start, id: ids[0] });
          const second = sms(ids[1]!);
          return { messages: [second], next: { dateMs: second.dateMs, id: second.id } };
        }
        assert.deepEqual(options.after, { dateMs: start, id: ids[1] });
        return { messages: [], next: null };
      });
      const result = await catchUpAndroidSms({
        reader: reader.reader,
        storage: fixture.api,
        startDateMs: start,
        endDateMs: start,
        clock: () => { clockCalls += 1; return start + 1; },
      });

      assert.equal(reader.calls.length, 3);
      assert.deepEqual(reader.calls.map((call) => call.after?.id), [undefined, ids[0], ids[1]]);
      assert.deepEqual(result, { inserted: 0, duplicate: 0, review: 2, ignored: 0, completedAt: start + 1 });
      assert.equal(JSON.stringify(result).includes(body), false);
      assert.equal('body' in result, false);
      assert.equal('sender' in result, false);
      assert.equal(clockCalls, 1);
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: start, platformId: ids[1] });
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, start + 1);
    } finally { fixture.fixture.sqlite.close(); }
  });

  it('captures completion time after final row work and preserves a body-free key-loss outcome', async () => {
    let fingerprintStarted!: () => void;
    const started = new Promise<void>((resolve) => { fingerprintStarted = resolve; });
    let releaseFingerprint!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFingerprint = resolve; });
    let pause = true;
    const key = fingerprinter(async (value) => {
      if (pause) {
        pause = false;
        fingerprintStarted();
        await gate;
      }
      return createHmac('sha256', 'fictional-sms-key').update(value).digest('hex');
    });
    const fixture = openApi(async () => key);
    try {
      await fixture.api.migrateLedger();
      let clockCalls = 0;
      const reader = fakeReader(() => ({ messages: [sms('15')], next: null }));
      const pending = catchUpAndroidSms({
        reader: reader.reader,
        storage: fixture.api,
        startDateMs: start,
        endDateMs: start,
        clock: () => { clockCalls += 1; return start + 12; },
      });
      await started;
      assert.equal(clockCalls, 0);
      releaseFingerprint();
      const result = await pending;
      assert.equal(clockCalls, 1);
      assert.equal(result.completedAt, start + 12);
    } finally {
      releaseFingerprint();
      fixture.fixture.sqlite.close();
    }

    let keyAvailable = true;
    let keyId = 'a'.repeat(64);
    const unavailable = openApi(async () => {
      if (!keyAvailable) throw new FingerprintKeyUnavailableError();
      return {
        keyId,
        fingerprint: async (value) => createHmac('sha256', 'fictional-sms-key').update(value).digest('hex'),
      };
    });
    try {
      await unavailable.api.migrateLedger();
      const initial = sms('16');
      await unavailable.api.importSmsBatch([{
        platformId: initial.id,
        receivedAt: initial.dateMs,
        sender: initial.sender,
        body: initial.body,
      }], null);
      keyAvailable = false;
      const reader = fakeReader((options) => {
        assert.deepEqual(options.after, { dateMs: start, id: '16' });
        return { messages: [sms('17', start + 1)], next: null };
      });
      await assert.rejects(catchUpAndroidSms({
        reader: reader.reader,
        storage: unavailable.api,
        startDateMs: start,
        endDateMs: start + 1,
        clock: () => start + 13,
      }), (error: unknown) => error instanceof AndroidSmsCatchupError && error.code === 'key_unavailable' && !error.message.includes(body));
      assert.equal((await unavailable.fixture.ledger.db.select().from(smsImportRefs).all()).length, 1);
      assert.deepEqual(await unavailable.api.getSmsImportCursor(), { receivedAt: start, platformId: '16' });
      assert.equal((await unavailable.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);

      keyAvailable = true;
      keyId = 'b'.repeat(64);
      await assert.rejects(catchUpAndroidSms({
        reader: reader.reader,
        storage: unavailable.api,
        startDateMs: start,
        endDateMs: start + 1,
        clock: () => start + 14,
      }), (error: unknown) => error instanceof AndroidSmsCatchupError &&
        error.code === 'duplicate_review_required' && !error.message.includes(body));
      assert.equal((await unavailable.fixture.ledger.db.select().from(smsImportRefs).all()).length, 1);
      assert.deepEqual(await unavailable.api.getSmsImportCursor(), { receivedAt: start, platformId: '16' });
      assert.equal((await unavailable.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
    } finally { unavailable.fixture.sqlite.close(); }
  });

  it('rejects malformed and non-progressing source pages before their rows are committed', async () => {
    const fixture = openApi();
    try {
      await fixture.api.migrateLedger();
      const valid = sms('10');
      const malformed: QueryResult[] = [
        { messages: [valid], next: { dateMs: start, id: '11' } },
        { messages: [valid, sms('9')], next: null },
        { messages: [], next: { dateMs: start, id: '10' } },
      ];
      for (const result of malformed) {
        const reader = fakeReader(() => result);
        await assert.rejects(catchup(reader.reader, fixture.api), (error: unknown) =>
          error instanceof AndroidSmsCatchupError && error.code === 'invalid_source_page');
        assert.equal((await fixture.api.getSmsImportCursor()), null);
        assert.equal((await fixture.fixture.ledger.db.select().from(smsImportRefs).all()).length, 0);
        assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
      }

      const repeated = fakeReader((options, index) => {
        if (index === 0) return { messages: [valid], next: { dateMs: start, id: '10' } };
        assert.deepEqual(options.after, { dateMs: start, id: '10' });
        return { messages: [valid], next: { dateMs: start, id: '10' } };
      });
      await assert.rejects(catchup(repeated.reader, fixture.api), (error: unknown) =>
        error instanceof AndroidSmsCatchupError && error.code === 'invalid_source_page');
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: start, platformId: '10' });
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
    } finally { fixture.fixture.sqlite.close(); }
  });

  it('sweeps long ranges in inclusive adjacent windows of at most 90 days', async () => {
    const fixture = openApi();
    try {
      await fixture.api.migrateLedger();
      const end = start + maxWindowMs * 2 + 23;
      const reader = fakeReader(() => ({ messages: [], next: null }));
      await catchUpAndroidSms({ reader: reader.reader, storage: fixture.api, startDateMs: start, endDateMs: end, clock: () => start + 1 });

      assert.equal(reader.calls.length, 3);
      assert.deepEqual(reader.calls.map(({ startDateMs, endDateMs }) => [startDateMs, endDateMs]), [
        [start, start + maxWindowMs - 1],
        [start + maxWindowMs, start + maxWindowMs * 2 - 1],
        [start + maxWindowMs * 2, end],
      ]);
      assert.ok(reader.calls.every((query) => query.endDateMs - query.startDateMs < maxWindowMs));
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, start + 1);
    } finally { fixture.fixture.sqlite.close(); }
  });

  it('rejects ranges that skip or precede an existing cursor and does not clamp it', async () => {
    const fixture = openApi();
    try {
      await fixture.api.migrateLedger();
      const cursorDate = start - 200 * 24 * 60 * 60 * 1_000;
      await fixture.api.importSmsBatch([{ platformId: '1', sender: 'VM-HDFCBK-S', body, receivedAt: cursorDate }], null);
      for (const [startDateMs, endDateMs] of [[cursorDate + 1, start], [cursorDate - 100, cursorDate - 1]]) {
        const reader = fakeReader(() => ({ messages: [], next: null }));
        await assert.rejects(catchup(reader.reader, fixture.api, startDateMs, endDateMs), RangeError);
        assert.equal(reader.calls.length, 0);
      }
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: cursorDate, platformId: '1' });
    } finally { fixture.fixture.sqlite.close(); }
  });

  it('rolls back an active page when permission is revoked or cancellation arrives during fingerprinting', async () => {
    for (const mode of ['revoked', 'cancelled'] as const) {
      let releaseFingerprint!: () => void;
      let fingerprintStarted!: () => void;
      const started = new Promise<void>((resolve) => { fingerprintStarted = resolve; });
      const gate = new Promise<void>((resolve) => { releaseFingerprint = resolve; });
      let pause = true;
      const key = fingerprinter(async (value) => {
        if (pause) {
          pause = false;
          fingerprintStarted();
          await gate;
        }
        return createHmac('sha256', 'fictional-sms-key').update(value).digest('hex');
      });
      const fixture = openApi(async () => key);
      const controller = new AbortController();
      try {
        await fixture.api.migrateLedger();
        const reader = fakeReader(() => ({ messages: [sms('20')], next: null }));
        const pending = catchUpAndroidSms({
          reader: reader.reader,
          storage: fixture.api,
          startDateMs: start,
          endDateMs: start,
          signal: controller.signal,
          clock: () => start + 2,
        });
        await started;
        if (mode === 'cancelled') controller.abort(body);
        else {
          reader.state.receiveSms = false;
          reader.state.granted = false;
        }
        releaseFingerprint();
        await assert.rejects(pending, (error: unknown) => {
          if (mode === 'cancelled') return error instanceof Error && error.name === 'AbortError' && !error.message.includes(body);
          return error instanceof AndroidSmsCatchupError && error.code === 'permission_denied';
        });
        assert.equal((await fixture.fixture.ledger.db.select().from(smsImportRefs).all()).length, 0);
        assert.equal(await fixture.fixture.ledger.db.select().from(smsImportState).get(), undefined);
        assert.equal(await fixture.fixture.ledger.db.select().from(importKeyState).get(), undefined);
        assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
      } finally {
        releaseFingerprint();
        fixture.fixture.sqlite.close();
      }
    }
  });

  it('stops on a concurrent cursor advance during the source query', async () => {
    const fixture = openApi();
    try {
      await fixture.api.migrateLedger();
      const concurrent = sms('90');
      const reader = fakeReader(async () => {
        await fixture.api.importSmsBatch([{
          platformId: concurrent.id,
          receivedAt: concurrent.dateMs,
          sender: concurrent.sender,
          body: concurrent.body,
        }], null);
        return { messages: [sms('91')], next: null };
      });
      await assert.rejects(catchUpAndroidSms({
        reader: reader.reader, storage: fixture.api, startDateMs: start, endDateMs: start,
        clock: () => start + 5,
      }), (error: unknown) => error instanceof AndroidSmsCatchupError && error.code === 'stale_cursor');
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: start, platformId: '90' });
      const refs = await fixture.fixture.ledger.db.select().from(smsImportRefs).all();
      assert.deepEqual(refs.map((row) => row.platformId), ['90']);
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
    } finally { fixture.fixture.sqlite.close(); }
  });

  it('keeps completed pages resumable when a later query is cancelled', async () => {
    const fixture = openApi();
    const controller = new AbortController();
    try {
      await fixture.api.migrateLedger();
      const first = sms('30');
      const second = sms('31', start + 1);
      let firstRun = true;
      const reader = fakeReader((options) => {
        if (firstRun && !options.after) return { messages: [first], next: { dateMs: first.dateMs, id: first.id } };
        if (firstRun) {
          controller.abort(body);
          return { messages: [second], next: null };
        }
        assert.deepEqual(options.after, { dateMs: first.dateMs, id: first.id });
        return { messages: [second], next: null };
      });
      await assert.rejects(catchUpAndroidSms({
        reader: reader.reader, storage: fixture.api, startDateMs: start, endDateMs: start + 1,
        signal: controller.signal, clock: () => start + 3,
      }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: start, platformId: '30' });
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);

      firstRun = false;
      const resumed = await catchUpAndroidSms({
        reader: reader.reader, storage: fixture.api, startDateMs: start, endDateMs: start + 1,
        clock: () => start + 4,
      });
      assert.deepEqual(resumed, { inserted: 0, duplicate: 0, review: 1, ignored: 0, completedAt: start + 4 });
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: start + 1, platformId: '31' });
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, start + 4);
    } finally { fixture.fixture.sqlite.close(); }
  });

  it('sanitizes source failures and rejects an invalid completion clock without stamping health', async () => {
    const fixture = openApi();
    try {
      await fixture.api.migrateLedger();
      const sourceFailure = new Error(body);
      const reader = fakeReader(() => { throw sourceFailure; });
      await assert.rejects(catchup(reader.reader, fixture.api), (error: unknown) =>
        error instanceof AndroidSmsCatchupError && error.code === 'source_unavailable' && !error.message.includes(body));

      const invalidClockReader = fakeReader(() => ({ messages: [sms('40')], next: null }));
      await assert.rejects(catchUpAndroidSms({
        reader: invalidClockReader.reader, storage: fixture.api, startDateMs: start, endDateMs: start,
        clock: () => Number.MAX_SAFE_INTEGER + 1,
      }), (error: unknown) => error instanceof AndroidSmsCatchupError && error.code === 'invalid_clock');
      assert.deepEqual(await fixture.api.getSmsImportCursor(), null);
      assert.equal((await fixture.fixture.ledger.db.select().from(smsImportRefs).all()).length, 0);
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
    } finally { fixture.fixture.sqlite.close(); }
  });
});
