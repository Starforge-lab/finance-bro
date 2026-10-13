import assert from 'node:assert/strict';
import test from 'node:test';

import { AndroidSmsCatchupError } from '../src/imports/android-sms-catchup';
import {
  createAndroidSmsOriginalReader,
  createAndroidSmsOperationGeneration,
  getAndroidSmsCatchupFailure,
  runEnabledAndroidSmsCatchup,
  setAndroidSmsImportSettings,
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

  await t.test('serializes a disable behind a pending enable so the final native setting is off', async () => {
    let releaseEnable!: () => void;
    let markEnableStarted!: () => void;
    const enablePending = new Promise<void>((resolve) => { releaseEnable = resolve; });
    const enableStarted = new Promise<void>((resolve) => { markEnableStarted = resolve; });
    const writes: boolean[] = [];
    let enabled = false;
    let startDateMs: number | null = null;
    const reader = {
      async setImportSettingsAsync(update: { enabled: boolean; startDateMs?: number }) {
        writes.push(update.enabled);
        if (update.enabled) {
          markEnableStarted();
          await enablePending;
          enabled = true;
          startDateMs = update.startDateMs ?? startDateMs;
        } else {
          enabled = false;
        }
        return { enabled, startDateMs };
      },
    };

    const enabling = setAndroidSmsImportSettings(reader, { enabled: true, startDateMs: 1_700_000_000_000 });
    const disabling = setAndroidSmsImportSettings(reader, { enabled: false });
    await enableStarted;
    assert.deepEqual(writes, [true]);
    releaseEnable();
    await Promise.all([enabling, disabling]);
    assert.deepEqual(writes, [true, false]);
    assert.equal(enabled, false);
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
