/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPersonalFinance } from '../src/db/personal-finance';
import { createReconciliation } from '../src/db/reconciliation';
import { createDataLayer } from '../src/db/service';
import { getFinanceTransactionRunner } from '../src/db/finance-transaction';
import type { LedgerSQLiteTransactionRunner } from '../src/db/ledger';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';

const now = new Date('2026-10-18T10:00:00Z');
test('overlapping forecast refreshes and Settings reads share a single SQLite transaction queue', async () => {
  const f = openTestLedger();
  try {
    await f.ledger.migrateLedger();
    await f.ledger.createAccount({ id: 'bank', name: 'Fictional bank', type: 'bank' });
    const reconciliation = createReconciliation(f.client, ledgerMigrations);
    const finance = createPersonalFinance(f.client, ledgerMigrations);
    await reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 50000, asOf: now }, now);
    await finance.saveFinanceSetup({ salaryDay: 28, salaryAmountPaise: 100000, reservePaise: 1000, commitmentsConfirmed: true, accountCoverageConfirmed: true });
    await finance.createRecurringSchedule({ id: 'rent', label: 'Fictional rent', amountPaise: 5000, dayOfMonth: 25, kind: 'bill' }, now);
    const results = await Promise.allSettled([
      finance.getPersonalFinancePlan(now), finance.getFinanceSetup(), reconciliation.getAccountBalances(now),
      finance.listRecurringSchedules(), finance.getPersonalFinancePlan(now),
    ]);
    assert.deepEqual(results.filter(result => result.status === 'rejected'), []);
    assert.equal((await finance.getPersonalFinancePlan(now)).safeToSpendPaise, 44000);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM bills').get()?.n, 2);
  } finally { f.sqlite.close(); }
});

test('a failed transaction rolls back and does not poison subsequent queued transactions', async () => {
  const f = openTestLedger();
  try {
    await f.ledger.migrateLedger();
    const run = getFinanceTransactionRunner(f.client);
    assert.equal(getFinanceTransactionRunner(f.client), run);
    const events: string[] = [];
    const failed = run(async transaction => {
      await transaction.execAsync("INSERT INTO preferences (key,value) VALUES ('fictional-rollback','temporary')");
      events.push('failed');
      throw new Error('Fictional failed write');
    });
    const recovered = run(async transaction => {
      assert.equal(await transaction.getFirstAsync("SELECT * FROM preferences WHERE key='fictional-rollback'"), null);
      await transaction.execAsync("INSERT INTO preferences (key,value) VALUES ('fictional-recovery','saved')");
      events.push('recovered');
    });
    const results = await Promise.allSettled([failed, recovered]);
    assert.equal(results[0]?.status, 'rejected');
    assert.equal(results[1]?.status, 'fulfilled');
    assert.deepEqual(events, ['failed', 'recovered']);
    assert.equal(f.sqlite.prepare("SELECT value FROM preferences WHERE key='fictional-recovery'").get()?.value, 'saved');
  } finally { f.sqlite.close(); }
});

test('preserves the supplied platform transaction runner without wrapping it', async () => {
  const f = openTestLedger();
  try {
    const provided: LedgerSQLiteTransactionRunner = async task => { await task(f.client); };
    assert.equal(getFinanceTransactionRunner(f.client, provided), provided);
    assert.notEqual(getFinanceTransactionRunner(f.client), provided);
  } finally { f.sqlite.close(); }
});

test('a failed forecast cannot roll back concurrent successful manual and planning saves', async () => {
  const f = openTestLedger();
  let release!: () => void;
  try {
    const api = createDataLayer(f.client, ledgerMigrations);
    await api.migrateLedger();
    await api.createAccount({ id: 'bank', name: 'Fictional bank', type: 'bank' });
    await api.setAccountBalance({ accountId: 'bank', balancePaise: 50000, asOf: now }, now);
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const prepare = f.client.prepareAsync.bind(f.client);
    let pause = true;
    f.client.prepareAsync = async (...args) => {
      if (pause && args[0].includes('from "accounts" left join')) {
        pause = false;
        await f.client.execAsync("INSERT INTO preferences (key,value) VALUES ('fictional-transient','not committed')");
        entered();
        await resume;
        throw new Error('Fictional forecast failure');
      }
      return prepare(...args);
    };
    const forecast = api.getPersonalFinancePlan(now);
    const rejected = assert.rejects(forecast);
    await paused;
    const writes = [
      api.createAccount({ id: 'wallet', name: 'Fictional wallet', type: 'wallet' }),
      api.saveManualEntry({ id: 'purchase', amountInr: '12.34', direction: 'debit', occurredAt: now, accountId: 'bank' }),
      api.createBill({ id: 'bill', label: 'Fictional bill', amountPaise: 1000, dueDate: '2026-10-25' }),
    ];
    const accounts = api.listAccounts();
    // Allow competing calls to reach SQLite if they are not queued.
    await new Promise<void>(resolve => setImmediate(resolve));
    release();
    await rejected;
    await Promise.all(writes);
    assert.equal((await accounts).some(account => account.id === 'wallet'), true);
    assert.equal((await api.listAccounts()).some(account => account.id === 'wallet'), true);
    assert.equal((await api.listTransactions()).some(transaction => transaction.id === 'purchase'), true);
    assert.equal((await api.listBills('2026-10-18')).some(bill => bill.id === 'bill'), true);
    assert.equal(f.sqlite.prepare("SELECT * FROM preferences WHERE key='fictional-transient'").get(), undefined);
  } finally { release?.(); f.sqlite.close(); }
});
