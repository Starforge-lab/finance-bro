import assert from 'node:assert/strict';
import test from 'node:test';

import { AndroidSmsCatchupError } from '../src/imports/android-sms-catchup';
import {
  AndroidSmsBackgroundUnavailableError,
  createAndroidSmsOriginalReader,
  createAndroidSmsOperationGeneration,
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
    const reader = {
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
  });
});
