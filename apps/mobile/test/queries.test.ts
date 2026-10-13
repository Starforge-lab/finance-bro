/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLedgerQueries } from '../src/db/queries';
import { createLedgerCsvExporter } from '../src/exports/csv';
import type { NewTransaction } from '../src/db/ledger';
import { accounts, categories } from '../src/db/schema';
import { createDataLayer } from '../src/db/service';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';

function transaction(id: string, occurredAt: string, overrides: Partial<NewTransaction> = {}): NewTransaction {
  return {
    id,
    amountPaise: 10_000,
    direction: 'debit',
    kind: 'expense',
    source: 'manual',
    occurredAt: new Date(occurredAt),
    ...overrides,
  };
}

describe('ledger queries', () => {
  it('uses India month boundaries, deterministic filters, and approved cash-flow totals', async () => {
    const { sqlite, ledger } = openTestLedger();
    try {
      await ledger.migrateLedger();
      await ledger.db.insert(accounts).values({ id: 'bank', name: 'Fictional bank', type: 'bank' }).run();
      await ledger.db.insert(categories).values([
        { id: 'food', name: 'Fictional food', kind: 'expense' },
        { id: 'salary', name: 'Fictional income', kind: 'income' },
      ]).run();
      const add = async (id: string, at: string, overrides: Partial<NewTransaction> = {}) =>
        ledger.createTransaction(transaction(id, at, { accountId: 'bank', ...overrides }));

      await add('before-month', '2026-09-30T18:29:59.999Z', { amountPaise: 60_000, categoryId: 'food' });
      await add('start-a', '2026-09-30T18:30:00.000Z', { amountPaise: 10_000, categoryId: 'food' });
      await add('start-z', '2026-09-30T18:30:00.000Z', { amountPaise: 20_000, categoryId: 'food' });
      await add('expense-middle', '2026-10-15T12:00:00.000Z', { amountPaise: 30_000, categoryId: 'food' });
      await add('refund', '2026-10-20T12:00:00.000Z', {
        amountPaise: 5_000, direction: 'credit', kind: 'refund', categoryId: 'food',
      });
      await add('reversal', '2026-10-21T12:00:00.000Z', {
        amountPaise: 2_000, direction: 'credit', kind: 'reversal',
      });
      await add('income', '2026-10-22T12:00:00.000Z', {
        amountPaise: 120_000, direction: 'credit', kind: 'income', categoryId: 'salary',
      });
      await add('pending', '2026-10-23T12:00:00.000Z', { status: 'pending', amountPaise: 11_000, categoryId: 'food' });
      await add('failed', '2026-10-23T13:00:00.000Z', { status: 'failed', amountPaise: 12_000, categoryId: 'food' });
      await add('transfer', '2026-10-23T14:00:00.000Z', { kind: 'transfer', amountPaise: 13_000, categoryId: 'food' });
      await add('withdrawal', '2026-10-23T15:00:00.000Z', { kind: 'cash_withdrawal', amountPaise: 14_000, categoryId: 'food' });
      await add('excluded', '2026-10-23T16:00:00.000Z', { excludeFromStats: true, amountPaise: 15_000, categoryId: 'food' });
      await assert.rejects(add('wrong-direction-income', '2026-10-23T17:00:00.000Z', { kind: 'income', categoryId: 'salary' }));
      await assert.rejects(add('wrong-direction-expense', '2026-10-23T18:00:00.000Z', { direction: 'credit', kind: 'expense', categoryId: 'food' }));
      await add('month-end', '2026-10-31T18:30:00.000Z', { amountPaise: 50_000, categoryId: 'food' });
      await add('deleted', '2026-10-24T12:00:00.000Z', { amountPaise: 70_000, categoryId: 'food' });
      await ledger.softDeleteTransaction('deleted');

      const queries = createLedgerQueries(ledger.db);
      const summary = await queries.getMonthlySummary('2026-10');
      assert.equal(summary.start.toISOString(), '2026-09-30T18:30:00.000Z');
      assert.equal(summary.end.toISOString(), '2026-10-31T18:30:00.000Z');
      assert.equal(summary.expensePaise, 53_000);
      assert.equal(summary.incomePaise, 120_000);
      assert.equal(summary.netPaise, 67_000);
      assert.deepEqual(summary.categories, [
        { categoryId: null, categoryName: null, expensePaise: -2_000, incomePaise: 0 },
        { categoryId: 'food', categoryName: 'Fictional food', expensePaise: 55_000, incomePaise: 0 },
        { categoryId: 'salary', categoryName: 'Fictional income', expensePaise: 0, incomePaise: 120_000 },
      ]);

      const sameTime = await queries.listTransactions({ month: '2026-10', categoryId: 'food', accountId: 'bank', direction: 'debit' });
      assert.deepEqual(sameTime.map(({ id }) => id), [
        'excluded', 'withdrawal', 'transfer', 'failed', 'pending', 'expense-middle', 'start-z', 'start-a',
      ]);
      const transactionDetails = await queries.getTransaction('expense-middle');
      assert.equal(transactionDetails?.categoryName, 'Fictional food');
      assert.equal(transactionDetails?.accountName, 'Fictional bank');
      assert.equal(await queries.getTransaction('deleted'), undefined);
      await assert.rejects(queries.listTransactions({ month: '2026-13' }), TypeError);
      await assert.rejects(queries.getMonthlySummary('2026-2'), TypeError);
    } finally {
      sqlite.close();
    }
  });

  it('rejects totals outside the safe integer paise range', async () => {
    const { sqlite, ledger } = openTestLedger();
    try {
      await ledger.migrateLedger();
      await ledger.createTransaction(transaction('large', '2026-10-10T00:00:00Z', { amountPaise: Number.MAX_SAFE_INTEGER }));
      await ledger.createTransaction(transaction('overflow', '2026-10-11T00:00:00Z', { amountPaise: 1 }));
      await assert.rejects(createLedgerQueries(ledger.db).getMonthlySummary('2026-10'), RangeError);
    } finally {
      sqlite.close();
    }
  });

  it('exports all live statuses with exact INR values and spreadsheet-safe RFC CSV', async () => {
    const { sqlite, ledger } = openTestLedger();
    try {
      await ledger.migrateLedger();
      await ledger.db.insert(accounts).values({ id: '@account', name: '\t=Fictional bank', type: 'bank' }).run();
      await ledger.db.insert(categories).values({ id: '=category', name: ' +Fictional', kind: 'income' }).run();
      await ledger.createTransaction(transaction('=row', '2026-10-07T10:11:12.345Z', {
        amountPaise: Number.MAX_SAFE_INTEGER,
        direction: 'credit',
        kind: 'income',
        status: 'pending',
        accountId: '@account',
        categoryId: '=category',
        counterparty: '  -fictional merchant',
        note: '\t+SUM(1,2)\r\nline "two"',
        excludeFromStats: true,
        upiRef: 'private-upi-ref',
        smsRefId: 'private-sms-ref',
        bodyHash: 'private-body-hash',
        dedupeKey: 'private-dedupe-key',
      }));
      await ledger.createTransaction(transaction('deleted-csv-row', '2026-10-08T10:00:00Z'));
      await ledger.softDeleteTransaction('deleted-csv-row');

      const csv = await createLedgerCsvExporter(ledger.db).exportTransactionsCsv();
      assert.ok(csv.startsWith('"id","amount_inr","direction","kind","status","occurred_at","category_id","category_name","account_id","account_name","source","counterparty","note"\r\n'));
      assert.ok(csv.includes('"\'=row","90071992547409.91","credit","income","pending","2026-10-07T10:11:12.345Z","\'=category","\' +Fictional","\'@account","\'\t=Fictional bank","manual","\'  -fictional merchant","\'\t+SUM(1,2)\r\nline ""two"""'));
      assert.equal(csv.includes('deleted-csv-row'), false);
      for (const privateValue of ['private-upi-ref', 'private-sms-ref', 'private-body-hash', 'private-dedupe-key']) {
        assert.equal(csv.includes(privateValue), false);
      }
      assert.equal(csv.endsWith('\r\n'), true);
    } finally {
      sqlite.close();
    }
  });
});

it('lists only months that hold entries, newest first, with their spending', async () => {
  const fixture = openTestLedger();
  const ledger = createDataLayer(fixture.client, ledgerMigrations);
  try {
    await ledger.migrateLedger();
    const add = (id: string, at: string, amountPaise: number, extra: Record<string, unknown> = {}) => ledger.createTransaction({
      id, amountPaise, direction: 'debit', kind: 'expense', status: 'posted', source: 'manual', occurredAt: new Date(at), ...extra,
    } as never);
    await add('jul', '2026-07-10T10:00:00Z', 5_000);
    // 31 Aug 20:00 UTC is 1 Sep in India.
    await add('late', '2026-08-31T20:00:00Z', 1_000);
    await add('sep', '2026-09-05T10:00:00Z', 2_000);
    await add('sep-failed', '2026-09-06T10:00:00Z', 9_999, { status: 'failed' });
    await add('sep-refund', '2026-09-07T10:00:00Z', 500, { direction: 'credit', kind: 'refund' });
    await add('gone', '2026-06-01T10:00:00Z', 700);
    await ledger.softDeleteTransaction('gone');
    assert.deepEqual(await ledger.listEntryMonths(), [
      { month: '2026-09', expensePaise: 2_500, entryCount: 4 },
      { month: '2026-07', expensePaise: 5_000, entryCount: 1 },
    ]);
  } finally { fixture.sqlite.close(); }
});
