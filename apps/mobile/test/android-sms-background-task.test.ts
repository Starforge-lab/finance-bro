import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { SmsImportSettings, SmsPermissionState, SmsReaderModule } from '../modules/sms-reader';
import type { DataLayer } from '../src/db/service';
import { FingerprintKeyUnavailableError } from '../src/imports/fingerprint';
import {
  clearAndroidSmsCatchupFailure,
  getAndroidSmsCatchupFailure,
} from '../src/imports/android-sms-flow';
import { runAndroidSmsBackgroundTask } from '../src/imports/android-sms-background-runner';

const startDateMs = Date.now() - 1_000;

function fakeReader(
  settings: SmsImportSettings,
  permissions: SmsPermissionState,
  onQuery: () => Promise<{ messages: []; next: null }> = async () => ({ messages: [], next: null }),
) {
  let settingsReads = 0;
  let permissionReads = 0;
  let queries = 0;
  const reader = {
    async getImportSettingsAsync() { settingsReads += 1; return settings; },
    async getPermissionsAsync() { permissionReads += 1; return permissions; },
    async queryInboxAsync() { queries += 1; return await onQuery(); },
  } as unknown as SmsReaderModule;
  return {
    reader,
    reads: () => ({ settingsReads, permissionReads, queries }),
  };
}

function fakeLedger(importFailure?: Error) {
  let cursorReads = 0;
  let batchWrites = 0;
  const ledger = {
    async getSmsImportCursor() { cursorReads += 1; return null; },
    async importSmsBatch(
      _messages: unknown,
      cursor: null,
      options: { catchupCompletedAt?: () => number },
    ) {
      batchWrites += 1;
      options.catchupCompletedAt?.();
      if (importFailure) throw importFailure;
      return { cursor, inserted: 0, duplicate: 0, review: 0, ignored: 0 };
    },
  } as unknown as DataLayer;
  return { ledger, calls: () => ({ cursorReads, batchWrites }) };
}

test('Android SMS background task gates access before storage and shares the catch-up path', async (t) => {
  const granted = { readSms: true, receiveSms: true, granted: true };

  await t.test('non-Android platforms do not load the reader or ledger', async () => {
    let readerCalls = 0;
    let ledgerCalls = 0;
    assert.equal(await runAndroidSmsBackgroundTask(
      'ios',
      () => { readerCalls += 1; return null; },
      async () => { ledgerCalls += 1; return {} as DataLayer; },
    ), 'success');
    assert.deepEqual({ readerCalls, ledgerCalls }, { readerCalls: 0, ledgerCalls: 0 });
  });

  await t.test('disabled consent succeeds without checking permissions, opening storage, or querying', async () => {
    clearAndroidSmsCatchupFailure();
    const source = fakeReader({ enabled: false, startDateMs }, { readSms: false, receiveSms: false, granted: false });
    let ledgerCalls = 0;
    assert.equal(await runAndroidSmsBackgroundTask('android', () => source.reader, async () => {
      ledgerCalls += 1;
      return {} as DataLayer;
    }), 'success');
    assert.deepEqual(source.reads(), { settingsReads: 1, permissionReads: 0, queries: 0 });
    assert.equal(ledgerCalls, 0);
    assert.equal(getAndroidSmsCatchupFailure(), null);
  });

  await t.test('invalid consent fails before permission, ledger, or inbox access', async () => {
    clearAndroidSmsCatchupFailure();
    const source = fakeReader({ enabled: true, startDateMs: null }, granted);
    let ledgerCalls = 0;
    assert.equal(await runAndroidSmsBackgroundTask('android', () => source.reader, async () => {
      ledgerCalls += 1;
      return {} as DataLayer;
    }), 'failed');
    assert.deepEqual(source.reads(), { settingsReads: 1, permissionReads: 0, queries: 0 });
    assert.equal(ledgerCalls, 0);
    assert.equal(getAndroidSmsCatchupFailure(), 'invalid_consent');
  });

  await t.test('denied and unavailable permissions fail before opening the ledger or querying', async () => {
    for (const permission of [
      { value: { readSms: false, receiveSms: true, granted: false }, failure: 'permission_denied' },
      { value: null, failure: 'permission_unavailable' },
    ] as const) {
      clearAndroidSmsCatchupFailure();
      const source = fakeReader(
        { enabled: true, startDateMs },
        permission.value as SmsPermissionState,
      );
      if (permission.value === null) {
        source.reader.getPermissionsAsync = async () => { throw new Error('sensitive permission detail'); };
      }
      let ledgerCalls = 0;
      assert.equal(await runAndroidSmsBackgroundTask('android', () => source.reader, async () => {
        ledgerCalls += 1;
        return {} as DataLayer;
      }), 'failed');
      assert.equal(source.reads().queries, 0);
      assert.equal(ledgerCalls, 0);
      assert.equal(getAndroidSmsCatchupFailure(), permission.failure);
    }
  });

  await t.test('opens the shared ledger and runs the shared catch-up only after both gates pass', async () => {
    clearAndroidSmsCatchupFailure();
    const source = fakeReader({ enabled: true, startDateMs }, granted);
    const storage = fakeLedger();
    let ledgerCalls = 0;
    const outcome = await runAndroidSmsBackgroundTask('android', () => source.reader, async () => {
      ledgerCalls += 1;
      return storage.ledger;
    });
    assert.equal(outcome, 'success', getAndroidSmsCatchupFailure() ?? 'no failure code');
    assert.equal(ledgerCalls, 1);
    assert.ok(source.reads().queries > 0);
    assert.ok(storage.calls().cursorReads > 0);
    assert.equal(storage.calls().batchWrites, 1);
    assert.equal(getAndroidSmsCatchupFailure(), null);
  });

  await t.test('returns a static failure code and writes no log when source errors contain message text', async () => {
    clearAndroidSmsCatchupFailure();
    const secret = 'private SMS body';
    const source = fakeReader({ enabled: true, startDateMs }, granted, async () => {
      throw new Error(secret);
    });
    const storage = fakeLedger();
    const logs: unknown[][] = [];
    const previous = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args) => { logs.push(args); };
    console.warn = (...args) => { logs.push(args); };
    console.error = (...args) => { logs.push(args); };
    try {
      assert.equal(await runAndroidSmsBackgroundTask('android', () => source.reader, async () => storage.ledger), 'failed');
    } finally {
      console.log = previous.log;
      console.warn = previous.warn;
      console.error = previous.error;
    }
    assert.equal(getAndroidSmsCatchupFailure(), 'source_unavailable');
    assert.equal(JSON.stringify(getAndroidSmsCatchupFailure()).includes(secret), false);
    assert.deepEqual(logs, []);
  });

  await t.test('key-access failure returns Failed with a static code and no message logging', async () => {
    clearAndroidSmsCatchupFailure();
    const source = fakeReader({ enabled: true, startDateMs }, granted);
    const storage = fakeLedger(new FingerprintKeyUnavailableError());
    const logs: unknown[][] = [];
    const previous = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args) => { logs.push(args); };
    console.warn = (...args) => { logs.push(args); };
    console.error = (...args) => { logs.push(args); };
    try {
      assert.equal(await runAndroidSmsBackgroundTask('android', () => source.reader, async () => storage.ledger), 'failed');
    } finally {
      console.log = previous.log;
      console.warn = previous.warn;
      console.error = previous.error;
    }
    assert.equal(getAndroidSmsCatchupFailure(), 'key_unavailable');
    assert.deepEqual(logs, []);
  });

  await t.test('loads task definition before Expo Router without registering at module load', () => {
    const entry = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const taskImport = entry.indexOf("import './src/imports/android-sms-background-task';");
    const routerImport = entry.indexOf("import 'expo-router/entry';");
    assert.ok(taskImport >= 0 && routerImport > taskImport);
    const binding = readFileSync(new URL('../src/imports/android-sms-background-task.ts', import.meta.url), 'utf8');
    assert.match(binding, /if \(Platform\.OS === 'android'\)\s*\{\s*TaskManager\.defineTask/);
    assert.match(binding, /minimumInterval:\s*15/);
    assert.doesNotMatch(binding, /triggerTaskWorkerForTestingAsync/);
  });
});
