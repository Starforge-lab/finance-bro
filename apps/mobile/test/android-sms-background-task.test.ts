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
import {
  readAndroidSmsWakeDeadline,
  runAndroidSmsBackgroundTask,
} from '../src/imports/android-sms-background-runner';

const startDateMs = Date.now() - 1_000;
const backgroundBudgetMs = 7 * 60 * 1_000;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function flushTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeCaptureHealth(settings: SmsImportSettings) {
  let begins = 0;
  let latestRevision = 0;
  let latestFinished = false;
  const finishes: { revision: number; outcome: string; code: string | null }[] = [];
  return {
    async beginCaptureAttemptAsync() {
      if (settings.enabled !== true || settings.startDateMs === null) return null;
      begins += 1;
      latestRevision = begins;
      latestFinished = false;
      return latestRevision;
    },
    async finishCaptureAttemptAsync(revision: number, outcome: string, code: string | null) {
      if (revision !== latestRevision || latestFinished) return;
      latestFinished = true;
      finishes.push({ revision, outcome, code });
    },
    healthCalls: () => ({ begins, finishes: [...finishes] }),
  };
}

function fakeReader(
  settings: SmsImportSettings,
  permissions: SmsPermissionState,
  onQuery: () => Promise<{ messages: []; next: null }> = async () => ({ messages: [], next: null }),
) {
  let settingsReads = 0;
  let permissionReads = 0;
  let queries = 0;
  const health = fakeCaptureHealth(settings);
  const reader = {
    ...health,
    async getImportSettingsAsync() { settingsReads += 1; return settings; },
    async getPermissionsAsync() { permissionReads += 1; return permissions; },
    async queryInboxAsync() { queries += 1; return await onQuery(); },
    async getElapsedRealtimeAsync() { return 0; },
  } as unknown as SmsReaderModule;
  return {
    reader,
    reads: () => ({ settingsReads, permissionReads, queries }),
    healthCalls: health.healthCalls,
  };
}

function fakeLedger(importFailure?: Error) {
  let cursorReads = 0;
  let batchWrites = 0;
  const ledger = {
    async getSmsImportCursor() { cursorReads += 1; return null; },
    async getSmsReplayCheckpoint() { return null; },
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

  await t.test('wake task data accepts only a single safe monotonic deadline', () => {
    assert.equal(readAndroidSmsWakeDeadline({ deadlineElapsedRealtimeMs: 123_456 }), 123_456);
    for (const data of [
      null,
      [],
      {},
      { deadlineElapsedRealtimeMs: 0 },
      { deadlineElapsedRealtimeMs: Number.MAX_SAFE_INTEGER + 1 },
      { deadlineElapsedRealtimeMs: 123_456, message: 'must not be present' },
      Object.create({ deadlineElapsedRealtimeMs: 123_456 }),
    ]) {
      assert.equal(readAndroidSmsWakeDeadline(data), null);
    }
  });

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

  await t.test('clears the handler budget timer on disabled and denied exits', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const disabled = fakeReader({ enabled: false, startDateMs }, { readSms: false, receiveSms: false, granted: false });
    clearAndroidSmsCatchupFailure();
    assert.equal(await runAndroidSmsBackgroundTask('android', () => disabled.reader, async () => ({} as DataLayer)), 'success');
    t.mock.timers.tick(backgroundBudgetMs);
    assert.equal(getAndroidSmsCatchupFailure(), null);

    const denied = fakeReader({ enabled: true, startDateMs }, { readSms: false, receiveSms: true, granted: false });
    assert.equal(await runAndroidSmsBackgroundTask('android', () => denied.reader, async () => ({} as DataLayer)), 'failed');
    t.mock.timers.tick(backgroundBudgetMs);
    assert.equal(getAndroidSmsCatchupFailure(), 'permission_denied');
    assert.deepEqual(denied.healthCalls(), {
      begins: 1,
      finishes: [{ revision: 1, outcome: 'unavailable', code: 'permission_denied' }],
    });
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

  await t.test('invalid wake metadata fails before loading the native reader or ledger', async () => {
    clearAndroidSmsCatchupFailure();
    const source = fakeReader({ enabled: true, startDateMs }, granted);
    let readerCalls = 0;
    let ledgerCalls = 0;
    assert.equal(await runAndroidSmsBackgroundTask('android', () => {
      readerCalls += 1;
      return source.reader;
    }, async () => {
      ledgerCalls += 1;
      return {} as DataLayer;
    }, null, { deadlineElapsedRealtimeMs: readAndroidSmsWakeDeadline({}) }), 'failed');
    assert.equal(readerCalls, 0);
    assert.equal(ledgerCalls, 0);
    assert.equal(getAndroidSmsCatchupFailure(), 'time_budget_exceeded');
  });

  await t.test('expired or implausibly distant wake deadlines fail before settings or ledger reads', async () => {
    for (const deadlineElapsedRealtimeMs of [499_999, 500_000 + backgroundBudgetMs + 1]) {
      clearAndroidSmsCatchupFailure();
      const source = fakeReader({ enabled: true, startDateMs }, granted);
      let clockReads = 0;
      source.reader.getElapsedRealtimeAsync = async () => { clockReads += 1; return 500_000; };
      let ledgerCalls = 0;
      assert.equal(await runAndroidSmsBackgroundTask('android', () => source.reader, async () => {
        ledgerCalls += 1;
        return {} as DataLayer;
      }, null, { deadlineElapsedRealtimeMs }), 'failed');
      assert.equal(clockReads, 1);
      assert.deepEqual(source.reads(), { settingsReads: 0, permissionReads: 0, queries: 0 });
      assert.equal(ledgerCalls, 0);
      assert.equal(getAndroidSmsCatchupFailure(), 'time_budget_exceeded');
    }

    clearAndroidSmsCatchupFailure();
    const source = fakeReader({ enabled: false, startDateMs }, granted);
    let clockReads = 0;
    source.reader.getElapsedRealtimeAsync = async () => { clockReads += 1; return 500_000; };
    assert.equal(await runAndroidSmsBackgroundTask('android', () => source.reader,
      async () => ({} as DataLayer), null,
      { deadlineElapsedRealtimeMs: 500_000 + backgroundBudgetMs }), 'success');
    assert.equal(clockReads, 1);
    assert.deepEqual(source.reads(), { settingsReads: 1, permissionReads: 0, queries: 0 });
    assert.equal(getAndroidSmsCatchupFailure(), null);
  });

  await t.test('wake deadline expires while the native clock bridge is delayed before settings access', async () => {
    clearAndroidSmsCatchupFailure();
    const clockPending = deferred<number>();
    const clockStarted = deferred<void>();
    const source = fakeReader({ enabled: true, startDateMs }, granted);
    source.reader.getElapsedRealtimeAsync = () => {
      clockStarted.resolve();
      return clockPending.promise;
    };
    let ledgerCalls = 0;
    const task = runAndroidSmsBackgroundTask('android', () => source.reader, async () => {
      ledgerCalls += 1;
      return {} as DataLayer;
    }, null, { deadlineElapsedRealtimeMs: 500_000 + backgroundBudgetMs });
    await clockStarted.promise;
    clockPending.resolve(500_000 + backgroundBudgetMs);
    assert.equal(await task, 'failed');
    assert.deepEqual(source.reads(), { settingsReads: 0, permissionReads: 0, queries: 0 });
    assert.equal(ledgerCalls, 0);
    assert.equal(getAndroidSmsCatchupFailure(), 'time_budget_exceeded');
  });

  await t.test('remaining wake deadline aborts a late settings response before permission or ledger work', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    clearAndroidSmsCatchupFailure();
    const settingsPending = deferred<SmsImportSettings>();
    const settingsStarted = deferred<void>();
    let permissionReads = 0;
    let ledgerReads = 0;
    const reader = {
      ...fakeCaptureHealth({ enabled: true, startDateMs }),
      async getElapsedRealtimeAsync() { return 500_000; },
      getImportSettingsAsync() { settingsStarted.resolve(); return settingsPending.promise; },
      async getPermissionsAsync() { permissionReads += 1; return granted; },
      async queryInboxAsync() { throw new Error('Inbox must not be queried'); },
    } as unknown as SmsReaderModule;

    const task = runAndroidSmsBackgroundTask('android', () => reader, async () => {
      ledgerReads += 1;
      return {} as DataLayer;
    }, null, { deadlineElapsedRealtimeMs: 501_000 });
    await settingsStarted.promise;
    t.mock.timers.tick(1_000);
    assert.equal(await task, 'failed');
    assert.equal(getAndroidSmsCatchupFailure(), 'time_budget_exceeded');

    settingsPending.resolve({ enabled: true, startDateMs });
    await flushTurn();
    assert.equal(permissionReads, 0);
    assert.equal(ledgerReads, 0);
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

  await t.test('budget expiry during consent read blocks late permission, ledger, and inbox work', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    clearAndroidSmsCatchupFailure();
    const settingsPending = deferred<SmsImportSettings>();
    const settingsStarted = deferred<void>();
    let permissionReads = 0;
    let ledgerReads = 0;
    const reader = {
      ...fakeCaptureHealth({ enabled: true, startDateMs }),
      getImportSettingsAsync() { settingsStarted.resolve(); return settingsPending.promise; },
      async getPermissionsAsync() { permissionReads += 1; return granted; },
      async queryInboxAsync() { throw new Error('Inbox must not be queried'); },
    } as unknown as SmsReaderModule;

    const task = runAndroidSmsBackgroundTask('android', () => reader, async () => {
      ledgerReads += 1;
      return {} as DataLayer;
    });
    await settingsStarted.promise;
    t.mock.timers.tick(backgroundBudgetMs);
    assert.equal(await task, 'failed');
    assert.equal(getAndroidSmsCatchupFailure(), 'time_budget_exceeded');

    settingsPending.resolve({ enabled: true, startDateMs });
    await flushTurn();
    assert.equal(permissionReads, 0);
    assert.equal(ledgerReads, 0);
  });

  await t.test('returns at the deadline when preflight health persistence hangs and prevents late work', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    clearAndroidSmsCatchupFailure();
    const settingsPending = deferred<SmsImportSettings>();
    const settingsStarted = deferred<void>();
    const healthFinishPending = deferred<void>();
    let healthBegins = 0;
    let healthFinishes = 0;
    let permissionReads = 0;
    let ledgerReads = 0;
    const reader = {
      async beginCaptureAttemptAsync() { healthBegins += 1; return 1; },
      finishCaptureAttemptAsync() { healthFinishes += 1; return healthFinishPending.promise; },
      getImportSettingsAsync() { settingsStarted.resolve(); return settingsPending.promise; },
      async getPermissionsAsync() { permissionReads += 1; return granted; },
      async queryInboxAsync() { throw new Error('Inbox must not be queried'); },
      async getElapsedRealtimeAsync() { return 0; },
    } as unknown as SmsReaderModule;

    const task = runAndroidSmsBackgroundTask('android', () => reader, async () => {
      ledgerReads += 1;
      return {} as DataLayer;
    });
    await settingsStarted.promise;
    t.mock.timers.tick(backgroundBudgetMs);
    assert.equal(await task, 'failed');
    await flushTurn();
    assert.equal(healthBegins, 1);
    assert.equal(healthFinishes, 1);
    assert.equal(permissionReads, 0);
    assert.equal(ledgerReads, 0);

    settingsPending.resolve({ enabled: true, startDateMs });
    healthFinishPending.resolve();
    await flushTurn();
    assert.equal(healthBegins, 1);
    assert.equal(healthFinishes, 1);
    assert.equal(permissionReads, 0);
    assert.equal(ledgerReads, 0);
  });

  await t.test('budget expiry during ledger open blocks late catch-up startup', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    clearAndroidSmsCatchupFailure();
    const ledgerPending = deferred<DataLayer>();
    const ledgerStarted = deferred<void>();
    let queries = 0;
    const reader = {
      ...fakeCaptureHealth({ enabled: true, startDateMs }),
      async getImportSettingsAsync() { return { enabled: true, startDateMs }; },
      async getPermissionsAsync() { return granted; },
      async queryInboxAsync() { queries += 1; return { messages: [], next: null }; },
    } as unknown as SmsReaderModule;

    const task = runAndroidSmsBackgroundTask('android', () => reader, () => {
      ledgerStarted.resolve();
      return ledgerPending.promise;
    });
    await ledgerStarted.promise;
    t.mock.timers.tick(backgroundBudgetMs);
    assert.equal(await task, 'failed');
    assert.equal(getAndroidSmsCatchupFailure(), 'time_budget_exceeded');

    ledgerPending.resolve(fakeLedger().ledger);
    await flushTurn();
    assert.equal(queries, 0);
  });

  await t.test('budget expiry during inbox read aborts later writes after the native read returns', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    clearAndroidSmsCatchupFailure();
    const queryPending = deferred<{ messages: []; next: null }>();
    const queryStarted = deferred<void>();
    const source = fakeReader({ enabled: true, startDateMs }, granted, () => {
      queryStarted.resolve();
      return queryPending.promise;
    });
    const storage = fakeLedger();

    const task = runAndroidSmsBackgroundTask('android', () => source.reader, async () => storage.ledger);
    await queryStarted.promise;
    t.mock.timers.tick(backgroundBudgetMs);
    assert.equal(await task, 'failed');
    assert.equal(getAndroidSmsCatchupFailure(), 'time_budget_exceeded');

    queryPending.resolve({ messages: [], next: null });
    await flushTurn();
    assert.equal(storage.calls().batchWrites, 0);
    assert.equal(getAndroidSmsCatchupFailure(), 'time_budget_exceeded');
    assert.deepEqual(source.healthCalls(), {
      begins: 2,
      finishes: [{ revision: 2, outcome: 'failed', code: 'time_budget_exceeded' }],
    });
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
    assert.match(binding, /ANDROID_SMS_WAKE_TASK = 'finance-bro-android-sms-wake'/);
    assert.match(binding, /TaskManager\.defineTask\(ANDROID_SMS_BACKGROUND_TASK, executeAndroidSmsCatchupTask\)/);
    assert.match(binding, /TaskManager\.defineTask\(ANDROID_SMS_WAKE_TASK, executeAndroidSmsWakeTask\)/);
    assert.match(binding, /readAndroidSmsWakeDeadline\(data\)/);
    assert.equal(binding.match(/runAndroidSmsBackgroundTask\(/g)?.length, 1,
      'the periodic and receiver task names must delegate to the same guarded runner');
    assert.match(binding, /minimumInterval:\s*15/);
    assert.doesNotMatch(binding, /triggerTaskWorkerForTestingAsync/);
    assert.match(binding, /reader\.registerWakeTaskAsync\(\)/);
    assert.match(binding, /reader\.unregisterWakeTaskAsync\(\)/);
  });
});
