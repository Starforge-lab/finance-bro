/// <reference types="node" />

import assert from 'node:assert/strict';
import { rmSync, rmdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { describe, it } from 'node:test';
import { createPlanning } from '../src/db/planning';
import { migrateLedger, type LedgerMigrations } from '../src/db/ledger';
import { accounts, categories, transactions } from '../src/db/schema';
import { ledgerMigrations, openTestLedger, temporaryFile } from './helpers/ledger';

describe('planning storage', () => {
  it('adds planning tables to an existing ledger and keeps rows across reopening', async () => {
    const { directory, filename } = temporaryFile();
    const olderMigrations: LedgerMigrations = {
      journal: { entries: ledgerMigrations.journal.entries.slice(0, 2) },
      migrations: { m0000: ledgerMigrations.migrations.m0000!, m0001: ledgerMigrations.migrations.m0001! },
    };
    const old = openTestLedger(filename);
    try {
      await migrateLedger(old.client, olderMigrations);
      // Raw SQL: the current ORM schema has columns this older ledger doesn't.
      old.sqlite.exec("INSERT INTO accounts (id, name, type) VALUES ('cash', 'Cash', 'cash'); INSERT INTO categories (id, name, kind) VALUES ('food', 'Food', 'expense');");
      await old.ledger.createTransaction({
        id: 'old-txn', amountPaise: 12300, direction: 'debit', kind: 'expense',
        occurredAt: new Date('2026-10-06T12:00:00.000Z'), source: 'manual',
      });
    } finally {
      old.sqlite.close();
    }

    const reopened = openTestLedger(filename);
    try {
      await reopened.ledger.migrateLedger();
      const planning = createPlanning(reopened.ledger.db);
      await planning.setBudget({ id: 'food-oct', categoryId: 'food', month: '2026-10', amountPaise: 50000 });
      await planning.createBill({ id: 'power', label: 'Electricity', amountPaise: 280000, dueDate: '2026-10-31' });

      const account = await reopened.ledger.db.select().from(accounts).where(eq(accounts.id, 'cash')).get();
      const category = await reopened.ledger.db.select().from(categories).where(eq(categories.id, 'food')).get();
      const transaction = await reopened.ledger.db.select().from(transactions).where(eq(transactions.id, 'old-txn')).get();
      assert.equal(account?.name, 'Cash');
      assert.equal(category?.name, 'Food');
      assert.equal(transaction?.amountPaise, 12300);
      assert.equal(transaction?.userEdited, true);
    } finally {
      reopened.sqlite.close();
    }

    const finalOpen = openTestLedger(filename);
    try {
      await finalOpen.ledger.migrateLedger();
      const planning = createPlanning(finalOpen.ledger.db);
      assert.deepEqual(await planning.listBudgets('2026-10'), [
        { id: 'food-oct', categoryId: 'food', month: '2026-10', amountPaise: 50000 },
      ]);
      assert.equal((await planning.listBills('2026-10-01'))[0]?.label, 'Electricity');
    } finally {
      finalOpen.sqlite.close();
      rmSync(filename, { force: true });
      rmdirSync(directory);
    }
  });

  it('sets one positive safe monthly budget per expense category and supports edits/removal', async () => {
    const fixture = openTestLedger();
    try {
      await fixture.ledger.migrateLedger();
      await fixture.ledger.db.insert(categories).values([
        { id: 'food', name: 'Food', kind: 'expense' },
        { id: 'travel', name: 'Travel', kind: 'expense' },
        { id: 'salary', name: 'Salary', kind: 'income' },
      ]).run();
      const planning = createPlanning(fixture.ledger.db);

      assert.equal(await planning.setBudget({ id: 'food-oct', categoryId: 'food', month: '2026-10', amountPaise: 50000 }), 'food-oct');
      assert.equal(await planning.setBudget({ id: 'ignored-id', categoryId: 'food', month: '2026-10', amountPaise: 60000 }), 'food-oct');
      await planning.setBudget({ id: 'travel-oct', categoryId: 'travel', month: '2026-10', amountPaise: 80000 });
      assert.equal((await planning.listBudgets('2026-10')).length, 2);
      assert.equal((await planning.listBudgets('2026-11')).length, 0);

      assert.equal(await planning.editBudget('food-oct', { amountPaise: 70000 }), true);
      assert.equal((await planning.listBudgets('2026-10'))[0]?.amountPaise, 70000);
      await assert.rejects(planning.editBudget('food-oct', { month: '2026-10', categoryId: 'travel' }));
      await assert.rejects(planning.editBudget('food-oct', { categoryId: 'salary' }), /expense category/);
      await assert.rejects(planning.setBudget({ id: 'income-budget', categoryId: 'salary', month: '2026-10', amountPaise: 1 }), /expense category/);

      assert.equal(await planning.removeBudget('travel-oct'), true);
      assert.equal(await planning.removeBudget('travel-oct'), false);
      assert.equal((await planning.listBudgets('2026-10')).length, 1);

      assert.throws(() => fixture.sqlite.prepare(`
        INSERT INTO budgets (id, category_id, month, amount_paise) VALUES ('sql-income', 'salary', '2026-12', 1)
      `).run(), /expense category/);
      assert.throws(() => fixture.sqlite.prepare(`
        UPDATE categories SET kind = 'income' WHERE id = 'food'
      `).run(), /must remain expenses/);
      assert.throws(() => fixture.sqlite.prepare(`
        INSERT INTO budgets (id, category_id, month, amount_paise) VALUES ('sql-missing', 'absent', '2026-12', 1)
      `).run(), /FOREIGN KEY/);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('validates budget identifiers, categories, months and amounts at runtime', async () => {
    const fixture = openTestLedger();
    try {
      await fixture.ledger.migrateLedger();
      await fixture.ledger.db.insert(categories).values({ id: 'food', name: 'Food', kind: 'expense' }).run();
      const planning = createPlanning(fixture.ledger.db);

      for (const month of ['2026-00', '2026-13', '2026-2', '0000-01', '2026-02-30']) {
        await assert.rejects(planning.setBudget({ id: 'bad-month', categoryId: 'food', month, amountPaise: 1 }));
      }
      for (const amountPaise of [0, -1, 1.25, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '100'] as never[]) {
        await assert.rejects(planning.setBudget({ id: 'bad-amount', categoryId: 'food', month: '2026-10', amountPaise }));
      }
      await assert.rejects(planning.setBudget({ id: '', categoryId: 'food', month: '2026-10', amountPaise: 1 }));
      await assert.rejects(planning.setBudget({ id: 'missing-category', categoryId: 'absent', month: '2026-10', amountPaise: 1 }), /expense category/);
      assert.equal(await planning.setBudget({ id: 'max-safe', categoryId: 'food', month: '2026-10', amountPaise: Number.MAX_SAFE_INTEGER }), 'max-safe');

      assert.throws(() => fixture.sqlite.prepare(`
        INSERT INTO budgets (id, category_id, month, amount_paise) VALUES ('sql-bad-amount', 'food', '2026-10', 1.5)
      `).run());
      assert.throws(() => fixture.sqlite.prepare(`
        INSERT INTO budgets (id, category_id, month, amount_paise) VALUES ('sql-bad-month', 'food', '2026-13', 1)
      `).run());
    } finally {
      fixture.sqlite.close();
    }
  });

  it('lists bills from a supplied date and paid transitions never create transactions', async () => {
    const fixture = openTestLedger();
    try {
      await fixture.ledger.migrateLedger();
      const planning = createPlanning(fixture.ledger.db);
      await fixture.ledger.createTransaction({
        id: 'existing-txn', amountPaise: 100, direction: 'debit', kind: 'expense',
        occurredAt: new Date('2026-10-01T00:00:00.000Z'), source: 'manual',
      });
      await planning.createBill({ id: 'late', label: 'Water', amountPaise: 12000, dueDate: '2026-10-06' });
      await planning.createBill({ id: 'today', label: 'Internet', amountPaise: 90000, dueDate: '2026-10-07' });
      await planning.createBill({ id: 'paid', label: 'Rent', amountPaise: 1500000, dueDate: '2026-10-01' });
      await planning.setBillPaid('paid', true);

      const billsOnOct7 = await planning.listBills('2026-10-07');
      assert.deepEqual(billsOnOct7.map(({ id, status }) => [id, status]), [
        ['paid', 'paid'], ['late', 'overdue'], ['today', 'upcoming'],
      ]);
      assert.deepEqual((await planning.listBills('2026-10-05')).map(({ id, status }) => [id, status]), [
        ['paid', 'paid'], ['late', 'upcoming'], ['today', 'upcoming'],
      ]);

      assert.equal(await planning.setBillPaid('late', true), true);
      assert.equal((await planning.listBills('2026-10-07')).find((bill) => bill.id === 'late')?.status, 'paid');
      assert.equal(await planning.setBillPaid('late', false), true);
      assert.equal((await planning.listBills('2026-10-07')).find((bill) => bill.id === 'late')?.status, 'overdue');
      assert.equal(await planning.editBill('today', { label: 'Internet and phone', amountPaise: 95000, dueDate: '2026-10-08' }), true);
      assert.equal((await planning.listBills('2026-10-07')).find((bill) => bill.id === 'today')?.status, 'upcoming');
      assert.equal(await fixture.ledger.db.select({ id: transactions.id }).from(transactions).all().then((rows) => rows.length), 1);
      assert.equal(await planning.removeBill('paid'), true);
      assert.equal(await planning.removeBill('paid'), false);
    } finally {
      fixture.sqlite.close();
    }
  });

  it('rejects invalid bill labels, dates, amounts and status values', async () => {
    const fixture = openTestLedger();
    try {
      await fixture.ledger.migrateLedger();
      const planning = createPlanning(fixture.ledger.db);
      for (const dueDate of ['2026-02-29', '2024-04-31', '2026-2-01', '2026-00-01', '0000-01-01']) {
        await assert.rejects(planning.createBill({ id: 'bad-date', label: 'Utility', amountPaise: 1, dueDate }));
      }
      for (const amountPaise of [0, -1, 12.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1] as number[]) {
        await assert.rejects(planning.createBill({ id: 'bad-amount', label: 'Utility', amountPaise, dueDate: '2026-10-31' }));
      }
      await assert.rejects(planning.createBill({ id: 'blank', label: '  ', amountPaise: 1, dueDate: '2026-10-31' }));
      await planning.createBill({ id: 'leap', label: 'Leap-day bill', amountPaise: 1, dueDate: '2024-02-29' });
      await assert.rejects(planning.listBills('2026-02-29'), /valid YYYY-MM-DD/);
      await assert.rejects(planning.setBillPaid('leap', 1 as never), /boolean/);
      await planning.createBill({
        id: 'forged-paid', label: 'Future bill', amountPaise: 1, dueDate: '2026-10-31', paid: true,
      } as never);
      assert.equal((await planning.listBills('2026-10-01')).find((bill) => bill.id === 'forged-paid')?.status, 'upcoming');

      assert.throws(() => fixture.sqlite.prepare(`
        INSERT INTO bills (id, label, amount_paise, due_date) VALUES ('sql-bad', 'Water', 1.5, '2026-10-31')
      `).run());
      assert.throws(() => fixture.sqlite.prepare(`
        INSERT INTO bills (id, label, amount_paise, due_date) VALUES ('sql-blank', ' ', 1, '2026-10-31')
      `).run());
    } finally {
      fixture.sqlite.close();
    }
  });
});
