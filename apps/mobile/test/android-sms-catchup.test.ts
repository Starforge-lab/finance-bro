/// <reference types="node" />

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { describe, it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import type { LedgerSQLiteClient, LedgerSQLiteTransactionRunner } from '../src/db/ledger';
import { importKeyState, smsImportRefs, smsImportState, transactions } from '../src/db/schema';
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

function transactionSms(id: string, dateMs: number, amount: string, reference: string): AndroidSmsReaderMessage {
  return { id, dateMs, sender: 'VM-HDFCBK-S', body: body.replace('450.00', amount).replace('612345678901', reference) };
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
      assert.deepEqual(reader.calls.map(({ limit }) => limit), [100, 100, 100]);
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
        assert.deepEqual(options, { startDateMs: start, endDateMs: start + 1, limit: 100 });
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

  it('does not checkpoint an exhausted replay after its saved key is lost or rotated', async () => {
    for (const failure of ['lost', 'rotated'] as const) {
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
        const reader = fakeReader((_options, index) => {
          if (index === 0) return { messages: [sms('20')], next: { dateMs: start, id: '20' } };
          if (failure === 'lost') keyAvailable = false;
          else keyId = 'b'.repeat(64);
          return { messages: [], next: null };
        });

        await assert.rejects(catchUpAndroidSms({
          reader: reader.reader, storage: unavailable.api, startDateMs: start, endDateMs: start, clock: () => start + 30,
        }), (error: unknown) => error instanceof AndroidSmsCatchupError &&
          error.code === (failure === 'lost' ? 'key_unavailable' : 'duplicate_review_required') && !error.message.includes(body));

        assert.deepEqual(await unavailable.api.getSmsImportCursor(), { receivedAt: start, platformId: '20' });
        assert.equal((await unavailable.fixture.ledger.db.select().from(smsImportRefs).all()).length, 1);
        assert.equal((await unavailable.fixture.ledger.db.select().from(importKeyState).get())?.keyId, 'a'.repeat(64));
        assert.equal((await unavailable.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
      } finally { unavailable.fixture.sqlite.close(); }
    }
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
        { messages: Array.from({ length: 101 }, (_, index) => sms(String(index + 1))), next: null },
        { messages: [{ ...valid, sender: null } as unknown as AndroidSmsReaderMessage], next: null },
        { messages: [{ ...valid, body: null } as unknown as AndroidSmsReaderMessage], next: null },
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

  it('continues a page across an oversized unreadable row and commits the last cursor', async () => {
    const fixture = openApi();
    try {
      await fixture.api.migrateLedger();
      const oversizedBody = `FICTIONAL_UNREADABLE_BODY_${'x'.repeat(16_384)}`;
      const first = sms('10');
      const unreadable = { ...sms('11', start + 1), body: oversizedBody };
      const last = sms('12', start + 2);
      const reader = fakeReader(() => ({ messages: [first, unreadable, last], next: null }));

      const result = await catchup(reader.reader, fixture.api, start, start + 2);

      assert.deepEqual(result, { inserted: 0, duplicate: 0, review: 3, ignored: 0, completedAt: start + 10_000 });
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: start + 2, platformId: '12' });
      const refs = await fixture.fixture.ledger.db.select().from(smsImportRefs).all();
      assert.deepEqual(refs.map(({ platformId, reason }) => [platformId, reason]), [
        ['10', 'unknown_account'],
        ['11', 'unreadable_source'],
        ['12', 'unknown_account'],
      ]);
      assert.equal(JSON.stringify(refs).includes(oversizedBody), false);
      assert.equal(JSON.stringify(refs).includes('FICTIONAL_UNREADABLE_BODY_'), false);
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

  it('replays the consented date range below the main cursor and preserves protected transactions', async () => {
    const fixture = openApi();
    const previousDate = start + 1;
    const mainDate = start + 2;
    try {
      await fixture.api.migrateLedger();
      await fixture.api.createAccount({ id: 'hdfc-1234', name: 'Fictional HDFC', type: 'bank', institution: 'hdfc', last4: '1234' });
      const initial = [
        transactionSms('80', previousDate, '450.00', '612345678901'),
        transactionSms('81', previousDate, '650.00', '612345678902'),
        transactionSms('90', mainDate, '900.00', '612345678903'),
      ].map(({ id, dateMs, sender, body: messageBody }) => ({ platformId: id, receivedAt: dateMs, sender, body: messageBody }));
      await fixture.api.importSmsBatch(initial, null);

      const initialRefs = await fixture.fixture.ledger.db.select().from(smsImportRefs).all();
      const editedRef = initialRefs.find((row) => row.platformId === '80')!;
      const deletedRef = initialRefs.find((row) => row.platformId === '81')!;
      const editedId = `sms:${editedRef.referenceId}`;
      const deletedId = `sms:${deletedRef.referenceId}`;
      for (const [reference, transactionId, amountPaise, upiRef] of [
        [editedRef, editedId, 45000, '612345678901'],
        [deletedRef, deletedId, 65000, '612345678902'],
      ] as const) {
        await fixture.fixture.ledger.insertReviewedSmsTransaction({
          id: transactionId,
          amountPaise,
          direction: 'debit',
          kind: 'expense',
          status: 'posted',
          accountId: 'hdfc-1234',
          counterparty: null,
          merchantId: null,
          categoryId: null,
          occurredAt: new Date(reference.receivedAt),
          note: null,
          source: 'sms',
          smsRefId: `android-sms:${reference.referenceId}`,
          upiRef,
          dedupeKey: reference.dedupeKey!,
          bodyHash: reference.bodyHash!,
          ruleId: null,
          ruleVersion: null,
          linkedTxnId: null,
          excludeFromStats: false,
        });
        await fixture.fixture.ledger.db.update(smsImportRefs).set({ status: 'saved', reason: null, transactionId })
          .where(eq(smsImportRefs.referenceId, reference.referenceId)).run();
      }
      await fixture.fixture.ledger.db.update(transactions).set({ amountPaise: 777, note: 'Fictional manual edit', userEdited: true })
        .where(eq(transactions.id, editedId)).run();
      await fixture.fixture.ledger.softDeleteTransaction(deletedId, new Date(mainDate + 1));

      const newlyVisible = transactionSms('900', previousDate, '700.00', '612345678904');
      const reader = fakeReader((options) => {
        assert.deepEqual(options, { startDateMs: start, endDateMs: mainDate, limit: 100 });
        return {
          messages: [
            transactionSms('80', previousDate, '451.00', '612345678901'),
            transactionSms('81', previousDate, '650.00', '612345678902'),
            newlyVisible,
            transactionSms('90', mainDate, '900.00', '612345678903'),
          ],
          next: null,
        };
      });

      const result = await catchUpAndroidSms({
        reader: reader.reader, storage: fixture.api, startDateMs: start, endDateMs: mainDate, clock: () => mainDate + 10,
      });
      const replayed = await catchUpAndroidSms({
        reader: reader.reader, storage: fixture.api, startDateMs: start, endDateMs: mainDate, clock: () => mainDate + 11,
      });

      assert.equal(result.inserted, 0);
      assert.equal(result.review, 2);
      assert.equal(replayed.duplicate, 4);
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: mainDate, platformId: '90' });
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, mainDate + 11);

      const refs = await fixture.fixture.ledger.db.select().from(smsImportRefs).all();
      const oldSourceRefs = refs.filter((row) => row.platformId === '80');
      assert.equal(oldSourceRefs.length, 2);
      assert.notEqual(oldSourceRefs[0]!.bodyHash, oldSourceRefs[1]!.bodyHash);
      assert.notEqual(oldSourceRefs[0]!.referenceId, oldSourceRefs[1]!.referenceId);
      assert.equal(refs.filter((row) => row.platformId === '900').length, 1);
      assert.equal(refs.length, 5);
      assert.equal(JSON.stringify(refs).includes(body), false);

      const edited = await fixture.fixture.ledger.db.select().from(transactions).where(eq(transactions.id, editedId)).get();
      const deleted = await fixture.fixture.ledger.db.select().from(transactions).where(eq(transactions.id, deletedId)).get();
      assert.equal(edited?.amountPaise, 777);
      assert.equal(edited?.note, 'Fictional manual edit');
      assert.equal(edited?.userEdited, true);
      assert.equal(edited?.deletedAt, null);
      assert.ok(deleted?.deletedAt);
      assert.equal((await fixture.fixture.ledger.db.select().from(transactions).all()).length, 2);
    } finally { fixture.fixture.sqlite.close(); }
  });

  it('uses the caller consent floor independently of the main cursor without rewinding it', async () => {
    const fixture = openApi();
    try {
      await fixture.api.migrateLedger();
      const cursorDate = start - 200 * 24 * 60 * 60 * 1_000;
      await fixture.api.importSmsBatch([{ platformId: '1', sender: 'VM-HDFCBK-S', body, receivedAt: cursorDate }], null);
      const reader = fakeReader(() => ({ messages: [], next: null }));
      await catchup(reader.reader, fixture.api, start, start);
      assert.deepEqual(reader.calls, [{ startDateMs: start, endDateMs: start, limit: 100 }]);
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: cursorDate, platformId: '1' });
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, start + 10_000);
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
        if (!options.after) return { messages: [first], next: { dateMs: first.dateMs, id: first.id } };
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
      assert.deepEqual(resumed, { inserted: 0, duplicate: 1, review: 1, ignored: 0, completedAt: start + 4 });
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: start + 1, platformId: '31' });
      assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, start + 4);
    } finally { fixture.fixture.sqlite.close(); }
  });

  it('keeps source pages ordered and capped at 100 rows during a replay', async () => {
    const fixture = openApi();
    try {
      await fixture.api.migrateLedger();
      const highWater = sms('900', start + 1);
      await fixture.api.importSmsBatch([{
        platformId: highWater.id, receivedAt: highWater.dateMs, sender: highWater.sender, body: highWater.body,
      }], null);
      const rows = Array.from({ length: 101 }, (_, index) => sms(String(index + 1)));
      const reader = fakeReader((options, index) => {
        if (index === 0) return { messages: rows.slice(0, 100), next: { dateMs: start, id: '100' } };
        assert.deepEqual(options.after, { dateMs: start, id: '100' });
        return { messages: [rows[100]!, highWater], next: null };
      });

      const result = await catchUpAndroidSms({
        reader: reader.reader, storage: fixture.api, startDateMs: start, endDateMs: start + 1, clock: () => start + 20,
      });

      assert.deepEqual(reader.calls.map(({ limit }) => limit), [100, 100]);
      assert.equal(result.review, 101);
      assert.deepEqual(await fixture.api.getSmsImportCursor(), { receivedAt: start + 1, platformId: '900' });
      assert.equal((await fixture.fixture.ledger.db.select().from(smsImportRefs).all()).length, 102);
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

      const invalidClocks = [
        () => Number.MAX_SAFE_INTEGER + 1,
        () => { throw new Error(body); },
      ];
      for (const clock of invalidClocks) {
        const invalidClockReader = fakeReader(() => ({ messages: [sms('40')], next: null }));
        await assert.rejects(catchUpAndroidSms({
          reader: invalidClockReader.reader, storage: fixture.api, startDateMs: start, endDateMs: start,
          clock,
        }), (error: unknown) => error instanceof AndroidSmsCatchupError &&
          error.code === 'invalid_clock' && !error.message.includes(body));
        assert.deepEqual(await fixture.api.getSmsImportCursor(), null);
        assert.equal((await fixture.fixture.ledger.db.select().from(smsImportRefs).all()).length, 0);
        assert.equal((await fixture.api.getSmsImportHealth()).lastSuccessfulCatchupAt, null);
      }
    } finally { fixture.fixture.sqlite.close(); }
  });
});
