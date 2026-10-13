import assert from 'node:assert/strict';
import { readFileSync, rmSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { LedgerSQLiteTransactionRunner } from '../src/db/ledger';
import { openTestLedger, temporaryFile } from './helpers/ledger';

const source = ts.transpileModule(
  readFileSync(resolve('src/db/sms-transaction.native.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function loadRunner(openDatabaseAsync: (name: string, options: { useNewConnection: boolean; enableChangeListener: boolean }) => Promise<unknown>, platform = 'android') {
  const exports: { createSmsTransactionRunner?: (name: string) => LedgerSQLiteTransactionRunner } = {};
  runInNewContext(source, {
    exports,
    require(name: string) {
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === 'expo-sqlite') return { openDatabaseAsync };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  assert.ok(exports.createSmsTransactionRunner);
  return exports.createSmsTransactionRunner;
}

function fixture(options: { platform?: string; foreignKeys?: number; failStatement?: string; rollbackFails?: boolean } = {}) {
  const calls: string[] = [];
  const failure = new Error('Fictional transaction failure');
  const transaction = {
    async execAsync(statement: string) {
      calls.push(statement);
      if (statement === options.failStatement || (statement === 'ROLLBACK' && options.rollbackFails)) throw failure;
    },
    async getFirstAsync() { calls.push('VERIFY FOREIGN KEYS'); return { foreign_keys: options.foreignKeys ?? 1 }; },
    async closeAsync() { calls.push('CLOSE'); },
  };
  const createRunner = loadRunner(async (name, openOptions) => {
    assert.equal(name, 'fictional-sms.db');
    assert.equal(openOptions.useNewConnection, true);
    assert.equal(openOptions.enableChangeListener, true);
    calls.push('OPEN');
    return transaction;
  }, options.platform);
  return { run: createRunner('fictional-sms.db'), calls, transaction, failure };
}

it('initialises an isolated Android connection before BEGIN and commits only the supplied connection', async () => {
  const test = fixture();
  await test.run(async (client) => {
    assert.equal(client, test.transaction);
    test.calls.push('TASK');
  });
  assert.deepEqual(test.calls, ['OPEN', 'PRAGMA busy_timeout = 5000', 'PRAGMA foreign_keys = ON', 'VERIFY FOREIGN KEYS', 'BEGIN IMMEDIATE', 'TASK', 'COMMIT', 'CLOSE']);
});

it('fails before opening on other platforms and before starting with unenforced references', async () => {
  const ios = fixture({ platform: 'ios' });
  await assert.rejects(ios.run(async () => { assert.fail('Task must not run'); }), /unavailable/);
  assert.deepEqual(ios.calls, []);
  const disabled = fixture({ foreignKeys: 0 });
  await assert.rejects(disabled.run(async () => { assert.fail('Task must not run'); }), /enforce ledger references/);
  assert.deepEqual(disabled.calls, ['OPEN', 'PRAGMA busy_timeout = 5000', 'PRAGMA foreign_keys = ON', 'VERIFY FOREIGN KEYS', 'CLOSE']);
});

it('closes a connection if the busy timeout cannot be configured before BEGIN', async () => {
  const test = fixture({ failStatement: 'PRAGMA busy_timeout = 5000' });
  await assert.rejects(test.run(async () => { assert.fail('Task must not run'); }), (error) => error === test.failure);
  assert.deepEqual(test.calls, ['OPEN', 'PRAGMA busy_timeout = 5000', 'CLOSE']);
});

it('rolls back task/commit failures, preserves the original error and always closes', async () => {
  for (const failStatement of [undefined, 'COMMIT']) {
    const test = fixture({ failStatement, rollbackFails: true });
    const original = new Error('Fictional task failure');
    await assert.rejects(test.run(async () => {
      if (!failStatement) throw original;
    }), (error) => error === (failStatement ? test.failure : original));
    assert.deepEqual(test.calls.slice(-2), ['ROLLBACK', 'CLOSE']);
  }
});

it('closes a connection whose BEGIN fails without rolling back an unstarted transaction', async () => {
  const test = fixture({ failStatement: 'BEGIN IMMEDIATE' });
  await assert.rejects(test.run(async () => { assert.fail('Task must not run'); }), (error) => error === test.failure);
  assert.deepEqual(test.calls, ['OPEN', 'PRAGMA busy_timeout = 5000', 'PRAGMA foreign_keys = ON', 'VERIFY FOREIGN KEYS', 'BEGIN IMMEDIATE', 'CLOSE']);
});

it('enforces references and lets the main connection read while an isolated WAL writer is pending', async () => {
  const { filename, directory } = temporaryFile();
  const primary = openTestLedger(filename);
  let release!: () => void;
  const pause = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let pending: Promise<void> | undefined;
  try {
    await primary.client.execAsync('PRAGMA busy_timeout = 5000');
    const journalMode = await primary.client.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode = WAL');
    assert.equal(journalMode?.journal_mode, 'wal');
    await primary.ledger.migrateLedger();
    const createRunner = loadRunner(async (name, options) => {
      assert.equal(options.useNewConnection, true);
      assert.equal(options.enableChangeListener, true);
      const connection = openTestLedger(name);
      return { ...connection.client, closeAsync: async () => { connection.sqlite.close(); } };
    });
    const run = createRunner(filename);
    await assert.rejects(run(async (client) => {
      await client.execAsync("INSERT INTO transactions(id,amount_paise,direction,kind,source,account_id,occurred_at,created_at,updated_at) VALUES('invalid',100,'debit','expense','manual','missing',1,1,1)");
    }), /FOREIGN KEY/);
    pending = run(async (client) => {
      await client.execAsync("INSERT INTO accounts(id,name,type) VALUES('first','Fictional account','bank')");
      assert.equal((await client.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout'))?.timeout, 5000);
      entered();
      await pause;
    });
    await ready;
    assert.equal(primary.sqlite.prepare("SELECT count(*) AS count FROM accounts").get()?.count, 0);
    release();
    await pending;
    assert.equal(primary.sqlite.prepare("SELECT count(*) AS count FROM accounts").get()?.count, 1);
  } finally {
    release();
    await pending?.catch(() => {});
    primary.sqlite.close();
    rmSync(filename, { force: true });
    rmdirSync(directory);
  }
});
