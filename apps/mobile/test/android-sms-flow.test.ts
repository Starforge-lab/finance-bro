import assert from 'node:assert/strict';
import test from 'node:test';

import { AndroidSmsCatchupError } from '../src/imports/android-sms-catchup';
import {
  AndroidSmsBackgroundUnavailableError,
  createAndroidSmsOriginalReader,
  createAndroidSmsOperationGeneration,
  abortAndroidSmsCatchup,
  getAndroidSmsCatchupFailure,
  reconcileAndroidSmsImportSettings,
  runEnabledAndroidSmsCatchup,
  recordAndroidSmsCatchupFailure,
  setAndroidSmsImportSettings,
  shouldAbortAndroidSmsPreviewOnHide,
} from '../src/imports/android-sms-flow';

test('Android SMS adapters keep the source mapping exact and catch-up failures body-free', async (t) => {
  await t.test('invalidates older UI operations as soon as a newer operation starts', () => {
    const operations = createAndroidSmsOperationGeneration();
    const preview = operations.next();
    assert.equal(operations.isCurrent(preview), true);

    const disable = operations.next();
    assert.equal(operations.isCurrent(preview), false);
    assert.equal(operations.isCurrent(disable), true);
  });

  await t.test('does not interrupt an explicit Android permission prompt but cancels hidden source work', () => {
    assert.equal(shouldAbortAndroidSmsPreviewOnHide('permission'), false);
    assert.equal(shouldAbortAndroidSmsPreviewOnHide('source'), true);
    assert.equal(shouldAbortAndroidSmsPreviewOnHide(null), true);
  });

  await t.test('serializes a disable behind a pending enable so the final native setting is off', async () => {
    let releaseEnable!: () => void;
    let markEnableStarted!: () => void;
    const enablePending = new Promise<void>((resolve) => { releaseEnable = resolve; });
    const enableStarted = new Promise<void>((resolve) => { markEnableStarted = resolve; });
    const writes: boolean[] = [];
    const taskEvents: string[] = [];
    let enabled = false;
    let startDateMs: number | null = null;
    const reader = {
      async setImportSettingsAsync(update: { enabled: boolean; startDateMs?: number }) {
        writes.push(update.enabled);
        if (update.enabled) {
          enabled = true;
          startDateMs = update.startDateMs ?? startDateMs;
        } else {
          enabled = false;
        }
        return { enabled, startDateMs };
      },
    };
    const scheduler = {
      async register() {
        taskEvents.push('register');
        markEnableStarted();
        await enablePending;
      },
      async unregister() { taskEvents.push('unregister'); },
    };

    const enabling = setAndroidSmsImportSettings(reader, { enabled: true, startDateMs: 1_700_000_000_000 }, scheduler);
    const disabling = setAndroidSmsImportSettings(reader, { enabled: false }, scheduler);
    await enableStarted;
    assert.deepEqual(writes, [true]);
    assert.deepEqual(taskEvents, ['register']);
    releaseEnable();
    await Promise.all([enabling, disabling]);
    assert.deepEqual(writes, [true, false]);
    assert.deepEqual(taskEvents, ['register', 'unregister']);
    assert.equal(enabled, false);
  });

  await t.test('rolls a failed background registration back to off and removes a partial task', async () => {
    const events: string[] = [];
    let enabled = false;
    const reader = {
      async setImportSettingsAsync(update: { enabled: boolean }) {
        events.push(update.enabled ? 'setting:true' : 'setting:false');
        enabled = update.enabled;
        return { enabled, startDateMs: 1_700_000_000_000 };
      },
    };
    const scheduler = {
      async register() {
        events.push('register');
        throw new Error('secret SMS content');
      },
      async unregister() { events.push('unregister'); },
    };

    await assert.rejects(
      setAndroidSmsImportSettings(reader, { enabled: true, startDateMs: 1_700_000_000_000 }, scheduler),
      (error: unknown) => error instanceof AndroidSmsBackgroundUnavailableError &&
        error.reason === 'registration' && !error.message.includes('secret SMS content'),
    );
    assert.deepEqual(events, ['setting:true', 'register', 'setting:false', 'unregister']);
    assert.equal(enabled, false);
    recordAndroidSmsCatchupFailure(new AndroidSmsBackgroundUnavailableError('registration'));
    assert.equal(getAndroidSmsCatchupFailure(), 'background_unavailable');
  });

  await t.test('persists off before asking the scheduler to unregister', async () => {
    const events: string[] = [];
    const reader = {
      async setImportSettingsAsync(update: { enabled: boolean }) {
        events.push(update.enabled ? 'setting:true' : 'setting:false');
        return { enabled: update.enabled, startDateMs: 1_700_000_000_000 };
      },
    };
    const scheduler = {
      async register() { events.push('register'); },
      async unregister() { events.push('unregister'); },
    };

    await setAndroidSmsImportSettings(reader, { enabled: false }, scheduler);
    assert.deepEqual(events, ['setting:false', 'unregister']);
  });

  await t.test('reconciles only persisted, permitted opt-ins after launch', async () => {
    const events: string[] = [];
    let settings = { enabled: false, startDateMs: null as number | null };
    const reader = {
      async getImportSettingsAsync() {
        events.push('read-settings');
        return settings;
      },
      async getPermissionsAsync() {
        events.push('read-permissions');
        return { readSms: true, receiveSms: true, granted: true };
      },
      async setImportSettingsAsync(update: { enabled: boolean; startDateMs?: number }) {
        settings = { enabled: update.enabled, startDateMs: update.startDateMs ?? settings.startDateMs };
        events.push(update.enabled ? 'setting:true' : 'setting:false');
        return settings;
      },
    };
    const scheduler = {
      async register() { events.push('register'); },
      async unregister() { events.push('unregister'); },
    };

    await reconcileAndroidSmsImportSettings(reader, scheduler);
    assert.deepEqual(events, ['read-settings', 'unregister']);
    events.length = 0;
    settings = { enabled: true, startDateMs: 1_700_000_000_000 };
    await reconcileAndroidSmsImportSettings(reader, scheduler);
    assert.deepEqual(events, ['read-settings', 'read-permissions', 'register']);
  });

  await t.test('maps only the canonical fields used by SMS review', async () => {
    const readOriginal = createAndroidSmsOriginalReader({
      readInboxMessageAsync: async (id) => ({
        id,
        dateMs: 1_700_000_000_123,
        sender: 'BANK',
        body: 'INR 450.00 paid',
      }),
    });
    assert.deepEqual(await readOriginal('32'), {
      platformId: '32',
      receivedAt: 1_700_000_000_123,
      sender: 'BANK',
      body: 'INR 450.00 paid',
    });
  });

  await t.test('publishes a static error code when the native query includes message text', async () => {
    const finishes: { revision: number; outcome: string; code: string | null }[] = [];
    const reader = {
      beginCaptureAttemptAsync: async () => 1,
      finishCaptureAttemptAsync: async (revision: number, outcome: string, code: string | null) => {
        finishes.push({ revision, outcome, code });
      },
      getPermissionsAsync: async () => ({ readSms: true, receiveSms: true, granted: true }),
      getImportSettingsAsync: async () => ({ enabled: true, startDateMs: 1_700_000_000_000 }),
      queryInboxAsync: async () => { throw new Error('INR 450.00 secret body'); },
    };
    const storage = {
      getSmsImportCursor: async () => null,
      getSmsReplayCheckpoint: async () => null,
      importSmsBatch: async () => { throw new Error('Unexpected write'); },
    };

    await assert.rejects(
      runEnabledAndroidSmsCatchup(reader, storage, 1_700_000_000_000, 1_700_000_000_500),
      (error: unknown) => error instanceof AndroidSmsCatchupError && error.code === 'source_unavailable' &&
        !error.message.includes('secret body'),
    );
    assert.equal(getAndroidSmsCatchupFailure(), 'source_unavailable');
    assert.deepEqual(finishes, [{ revision: 1, outcome: 'unavailable', code: 'source_unavailable' }]);
  });

  await t.test('shares one durable attempt and keeps a prior failure until successful completion', async () => {
    let releaseQuery!: (value: { messages: []; next: null }) => void;
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => { markQueryStarted = resolve; });
    const queryPending = new Promise<{ messages: []; next: null }>((resolve) => { releaseQuery = resolve; });
    let beginCalls = 0;
    const finishes: { revision: number; outcome: string; code: string | null }[] = [];
    const reader = {
      beginCaptureAttemptAsync: async () => { beginCalls += 1; return 7; },
      finishCaptureAttemptAsync: async (revision: number, outcome: string, code: string | null) => {
        finishes.push({ revision, outcome, code });
      },
      getPermissionsAsync: async () => ({ readSms: true, receiveSms: true, granted: true }),
      getImportSettingsAsync: async () => ({ enabled: true, startDateMs: 1_700_000_000_000 }),
      queryInboxAsync: async () => { markQueryStarted(); return await queryPending; },
    };
    const storage = {
      getSmsImportCursor: async () => null,
      getSmsReplayCheckpoint: async () => null,
      importSmsBatch: async (_messages: unknown, cursor: null, options: { catchupCompletedAt?: () => number }) => {
        options.catchupCompletedAt?.();
        return { cursor, inserted: 0, duplicate: 0, review: 0, ignored: 0 };
      },
    };

    recordAndroidSmsCatchupFailure(new AndroidSmsCatchupError('key_unavailable'));
    const first = runEnabledAndroidSmsCatchup(reader, storage, 1_700_000_000_000, Date.now());
    const joined = runEnabledAndroidSmsCatchup(reader, storage, 1_700_000_000_000, Date.now());
    assert.equal(first, joined);
    await queryStarted;
    assert.equal(beginCalls, 1);
    assert.deepEqual(finishes, []);
    assert.equal(getAndroidSmsCatchupFailure(), 'key_unavailable');

    releaseQuery({ messages: [], next: null });
    await Promise.all([first, joined]);
    assert.deepEqual(finishes, [{ revision: 7, outcome: 'success', code: null }]);
    assert.equal(getAndroidSmsCatchupFailure(), null);
  });

  await t.test('finishes cancellation without erasing a previous failure', async () => {
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => { markQueryStarted = resolve; });
    let releaseQuery!: (value: { messages: []; next: null }) => void;
    const queryPending = new Promise<{ messages: []; next: null }>((resolve) => { releaseQuery = resolve; });
    const finishes: { revision: number; outcome: string; code: string | null }[] = [];
    const reader = {
      beginCaptureAttemptAsync: async () => 8,
      finishCaptureAttemptAsync: async (revision: number, outcome: string, code: string | null) => {
        finishes.push({ revision, outcome, code });
      },
      getPermissionsAsync: async () => ({ readSms: true, receiveSms: true, granted: true }),
      getImportSettingsAsync: async () => ({ enabled: true, startDateMs: 1_700_000_000_000 }),
      queryInboxAsync: async () => { markQueryStarted(); return await queryPending; },
    };
    const storage = {
      getSmsImportCursor: async () => null,
      getSmsReplayCheckpoint: async () => null,
      importSmsBatch: async () => { throw new Error('Cancellation must prevent financial writes'); },
    };

    recordAndroidSmsCatchupFailure(new AndroidSmsCatchupError('key_unavailable'));
    const catchup = runEnabledAndroidSmsCatchup(reader, storage, 1_700_000_000_000, Date.now());
    await queryStarted;
    abortAndroidSmsCatchup();
    releaseQuery({ messages: [], next: null });
    await assert.rejects(catchup, (error: unknown) =>
      typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
    assert.deepEqual(finishes, [{ revision: 8, outcome: 'cancelled', code: null }]);
    assert.equal(getAndroidSmsCatchupFailure(), 'key_unavailable');
  });

  await t.test('does not report success when durable success metadata cannot be written', async () => {
    const finishes: string[] = [];
    const reader = {
      beginCaptureAttemptAsync: async () => 9,
      finishCaptureAttemptAsync: async (_revision: number, outcome: string) => {
        finishes.push(outcome);
        throw new Error('native metadata unavailable');
      },
      getPermissionsAsync: async () => ({ readSms: true, receiveSms: true, granted: true }),
      getImportSettingsAsync: async () => ({ enabled: true, startDateMs: 1_700_000_000_000 }),
      queryInboxAsync: async () => ({ messages: [], next: null }),
    };
    const storage = {
      getSmsImportCursor: async () => null,
      getSmsReplayCheckpoint: async () => null,
      importSmsBatch: async (_messages: unknown, cursor: null, options: { catchupCompletedAt?: () => number }) => {
        options.catchupCompletedAt?.();
        return { cursor, inserted: 0, duplicate: 0, review: 0, ignored: 0 };
      },
    };

    await assert.rejects(
      runEnabledAndroidSmsCatchup(reader, storage, 1_700_000_000_000, Date.now()),
      (error: unknown) => error instanceof AndroidSmsCatchupError && error.code === 'storage_unavailable',
    );
    assert.deepEqual(finishes, ['success']);
    assert.equal(getAndroidSmsCatchupFailure(), 'storage_unavailable');
  });

  await t.test('does not clear a failure when a late native success write returns after cancellation', async () => {
    let markFinishStarted!: () => void;
    const finishStarted = new Promise<void>((resolve) => { markFinishStarted = resolve; });
    let releaseFinish!: () => void;
    const finishPending = new Promise<void>((resolve) => { releaseFinish = resolve; });
    const finishes: string[] = [];
    let batchWrites = 0;
    let writesAtFinish = 0;
    const reader = {
      beginCaptureAttemptAsync: async () => 10,
      async finishCaptureAttemptAsync(_revision: number, outcome: string) {
        finishes.push(outcome);
        writesAtFinish = batchWrites;
        markFinishStarted();
        await finishPending;
      },
      getPermissionsAsync: async () => ({ readSms: true, receiveSms: true, granted: true }),
      getImportSettingsAsync: async () => ({ enabled: true, startDateMs: 1_700_000_000_000 }),
      queryInboxAsync: async () => ({ messages: [], next: null }),
    };
    const storage = {
      getSmsImportCursor: async () => null,
      getSmsReplayCheckpoint: async () => null,
      importSmsBatch: async (_messages: unknown, cursor: null, options: { catchupCompletedAt?: () => number }) => {
        batchWrites += 1;
        options.catchupCompletedAt?.();
        return { cursor, inserted: 0, duplicate: 0, review: 0, ignored: 0 };
      },
    };

    recordAndroidSmsCatchupFailure(new AndroidSmsCatchupError('key_unavailable'));
    const catchup = runEnabledAndroidSmsCatchup(reader, storage, 1_700_000_000_000, Date.now());
    await finishStarted;
    abortAndroidSmsCatchup();
    releaseFinish();
    await assert.rejects(catchup, (error: unknown) =>
      typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
    assert.deepEqual(finishes, ['success']);
    assert.ok(writesAtFinish > 0);
    assert.equal(batchWrites, writesAtFinish);
    assert.equal(getAndroidSmsCatchupFailure(), 'key_unavailable');
  });
});
