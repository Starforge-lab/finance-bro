import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(
  readFileSync(resolve('src/db/index.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function loadLedger(platform: string, options: { failStatement?: string; journalMode?: string } = {}) {
  const calls: string[] = [];
  const failure = new Error('Fictional database configuration failure');
  const client = {
    async execAsync(statement: string) {
      calls.push(statement);
      if (statement === options.failStatement) throw failure;
    },
    async getFirstAsync(statement: string) {
      calls.push(`QUERY ${statement}`);
      return { journal_mode: options.journalMode ?? 'wal' };
    },
    async closeAsync() { calls.push('CLOSE'); },
  };
  const modules: Record<string, Record<string, unknown>> = {
    'expo-sqlite': {
      openDatabaseAsync: async (_name: string, openOptions: { enableChangeListener: boolean }) => {
        assert.equal(openOptions.enableChangeListener, true);
        calls.push('OPEN');
        return client;
      },
    },
    'react-native': { Platform: { OS: platform } },
    './service': {
      createDataLayer: () => {
        calls.push('CREATE DATA LAYER');
        return { migrateLedger: async () => { calls.push('MIGRATE'); } };
      },
    },
    './migrations': { ledgerMigrations: {} },
    '../imports/fingerprint-store': { getFingerprinter: () => undefined },
    './sms-transaction': { createSmsTransactionRunner: () => { calls.push('CREATE SMS RUNNER'); return async () => {}; } },
  };
  const exports: { getLedger?: () => Promise<unknown> } = {};
  runInNewContext(source, {
    exports,
    require(name: string) { return modules[name] ?? {}; },
  });
  assert.ok(exports.getLedger);
  return { getLedger: exports.getLedger, calls, failure };
}

it('enables WAL and a bounded busy timeout on the Android main connection before migration', async () => {
  const test = loadLedger('android');
  await test.getLedger();
  assert.deepEqual(test.calls, [
    'OPEN',
    'PRAGMA busy_timeout = 5000',
    'QUERY PRAGMA journal_mode = WAL',
    'CREATE SMS RUNNER',
    'CREATE DATA LAYER',
    'MIGRATE',
  ]);
});

it('leaves non-Android database opening unchanged', async () => {
  for (const platform of ['ios', 'web']) {
    const test = loadLedger(platform);
    await test.getLedger();
    assert.deepEqual(test.calls, ['OPEN', 'CREATE DATA LAYER', 'MIGRATE']);
  }
});

it('closes the main connection when busy timeout or WAL configuration fails', async () => {
  const timeoutFailure = loadLedger('android', { failStatement: 'PRAGMA busy_timeout = 5000' });
  await assert.rejects(timeoutFailure.getLedger(), (error) => error === timeoutFailure.failure);
  assert.deepEqual(timeoutFailure.calls, ['OPEN', 'PRAGMA busy_timeout = 5000', 'CLOSE']);

  const walUnavailable = loadLedger('android', { journalMode: 'delete' });
  await assert.rejects(walUnavailable.getLedger(), /Could not enable WAL/);
  assert.deepEqual(walUnavailable.calls, [
    'OPEN',
    'PRAGMA busy_timeout = 5000',
    'QUERY PRAGMA journal_mode = WAL',
    'CLOSE',
  ]);
});
