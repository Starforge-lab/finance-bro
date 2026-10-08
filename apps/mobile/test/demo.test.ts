import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createDataLayer } from '../src/db/service';
import { buildDemoPlan, LedgerNotEmptyError, removeDemoLedger, seedDemoLedger } from '../src/dev/seed-demo';
import { indiaDate } from '../src/utils/display';
import { ledgerMigrations, openTestLedger } from './helpers/ledger';

const NOW = new Date('2026-10-08T13:00:00Z');
const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10'];

async function seeded(now = NOW) {
  const fixture = openTestLedger();
  const ledger = createDataLayer(fixture.client, ledgerMigrations);
  await ledger.migrateLedger();
  assert.equal(await seedDemoLedger(fixture.client, ledger, now), true);
  return { ...fixture, ledger };
}

it('plans the same fixture for the same moment, and earlier months ignore today', () => {
  assert.deepEqual(buildDemoPlan(NOW), buildDemoPlan(NOW));
  const later = buildDemoPlan(new Date('2026-10-20T13:00:00Z'));
  const july = (plan: ReturnType<typeof buildDemoPlan>) => plan.transactions.filter((t) => indiaDate(t.occurredAt).startsWith('2026-07'));
  assert.deepEqual(july(later), july(buildDemoPlan(NOW)));
});

it('covers three full months plus this month, with nothing in the future', () => {
  const plan = buildDemoPlan(NOW);
  for (const month of MONTHS) assert.ok(plan.transactions.some((t) => indiaDate(t.occurredAt).startsWith(month)), month);
  assert.ok(plan.transactions.every((t) => t.occurredAt <= NOW && indiaDate(t.occurredAt) >= '2026-07-01'));
  assert.equal(new Set(plan.transactions.map((t) => t.id)).size, plan.transactions.length);
  assert.equal(plan.transactions.filter((t) => indiaDate(t.occurredAt) === '2026-10-08').length, 3);
});

it('totals match the ledger rules: failed, pending, excluded and transfers never count', async () => {
  const { sqlite, ledger } = await seeded();
  try {
    const plan = buildDemoPlan(NOW);
    for (const month of MONTHS) {
      const rows = plan.transactions.filter((t) => indiaDate(t.occurredAt).startsWith(month) && t.status === 'posted' && !t.excludeFromStats);
      const expense = rows.reduce((sum, t) => sum + (t.kind === 'expense' ? t.amountPaise : t.kind === 'refund' ? -t.amountPaise : 0), 0);
      const income = rows.reduce((sum, t) => sum + (t.kind === 'income' ? t.amountPaise : 0), 0);
      const summary = await ledger.getMonthlySummary(month);
      assert.equal(summary.expensePaise, expense, month);
      assert.equal(summary.incomePaise, income, month);
      assert.ok(summary.incomePaise >= 3_200_000, `${month} has salary`);
    }
    const kinds = new Set(plan.transactions.map((t) => `${t.kind}/${t.status}`));
    for (const kind of ['transfer/posted', 'cash_withdrawal/posted', 'refund/posted', 'expense/failed', 'expense/pending']) {
      assert.ok(kinds.has(kind), kind);
    }
    assert.ok(plan.transactions.some((t) => t.excludeFromStats));
    const incomeCategories = new Set(plan.transactions.filter((t) => t.kind === 'income').map((t) => t.categoryId));
    assert.equal(incomeCategories.size, 4);
  } finally { sqlite.close(); }
});

it('puts only Shopping over budget, and only in the festive-sale month', async () => {
  const { sqlite, ledger } = await seeded();
  try {
    for (const month of MONTHS.slice(0, 3)) {
      const over = (await ledger.getBudgetSummary(month)).filter((b) => b.overBudget).map((b) => b.categoryId);
      assert.deepEqual(over, month === '2026-09' ? ['demo-v2-shopping'] : [], month);
    }
    assert.deepEqual(new Set((await ledger.listBills('2026-10-08')).map((bill) => bill.status)), new Set(['upcoming', 'overdue', 'paid']));
  } finally { sqlite.close(); }
});

it('loads once, keeps edits, refuses to mix with real data, and preserves real budget categories on removal', async () => {
  const { sqlite, client, ledger } = await seeded();
  try {
    const [first] = await ledger.listTransactions();
    await ledger.editTransaction(first!.id, { amountPaise: 12_345 });
    assert.equal(await seedDemoLedger(client, ledger, new Date('2026-11-01T00:00:00Z')), false);
    assert.equal((await ledger.listTransactions()).find((row) => row.id === first!.id)!.amountPaise, 12_345);

    await ledger.createCategory({ id: 'real-food', name: 'Food', kind: 'expense' });
    await ledger.createCategory({ id: 'demo-v2-budget-parent', name: 'Budget parent', kind: 'expense' });
    await ledger.createCategory({ id: 'demo-v2-budget-child', name: 'Budget child', kind: 'expense' });
    await client.execAsync("UPDATE categories SET parent_id = 'demo-v2-budget-parent' WHERE id = 'demo-v2-budget-child'");
    await ledger.setBudget({ id: 'real-budget', categoryId: 'demo-v2-budget-child', month: '2026-12', amountPaise: 100_000 });
    await ledger.createTransaction({
      id: 'real-1', amountPaise: 5_000, direction: 'debit', kind: 'expense', status: 'posted', source: 'manual',
      categoryId: 'real-food', accountId: 'demo-v2-sbi', counterparty: 'Real tea', occurredAt: NOW,
    });
    const plan = buildDemoPlan(NOW);
    const removed = await removeDemoLedger(client);
    const left = await ledger.listTransactions();
    assert.deepEqual(left.map((row) => [row.id, row.accountId]), [['real-1', null]]);
    const categories = await ledger.listCategories();
    assert.deepEqual(categories.map((row) => row.id).sort(), ['demo-v2-budget-child', 'demo-v2-budget-parent', 'real-food']);
    assert.equal(categories.find((row) => row.id === 'demo-v2-budget-child')?.parentId, 'demo-v2-budget-parent');
    assert.deepEqual(await ledger.listBudgets('2026-12'), [{ id: 'real-budget', categoryId: 'demo-v2-budget-child', month: '2026-12', amountPaise: 100_000 }]);
    assert.equal(removed, plan.accounts.length + plan.categories.length + plan.budgets.length + plan.bills.length + plan.transactions.length);
    assert.equal((await ledger.listAccounts(true)).length, 0);
    await assert.rejects(seedDemoLedger(client, ledger, NOW), LedgerNotEmptyError);
  } finally { sqlite.close(); }
});

it('rolls back an interrupted seed so a retry can complete it', async () => {
  const fixture = openTestLedger();
  const ledger = createDataLayer(fixture.client, ledgerMigrations);
  try {
    await ledger.migrateLedger();
    await assert.rejects(seedDemoLedger(fixture.client, {
      ...ledger, createBill: async () => { throw new Error('Simulated storage failure'); },
    }, NOW), /Simulated storage failure/);
    assert.equal((await ledger.listTransactions()).length, 0);
    assert.equal((await ledger.listAccounts(true)).length, 0);
    assert.equal(await seedDemoLedger(fixture.client, ledger, NOW), true);
  } finally { fixture.sqlite.close(); }
});
