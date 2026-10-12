import { eq } from 'drizzle-orm';
import { createDataLayer } from '../src/db/service';
import { createLedger, migrateLedger, type LedgerMigrations, type LedgerSQLiteClient } from '../src/db/ledger';
import { transactions } from '../src/db/schema';
import type { Fingerprinter } from '../src/imports/fingerprint';

function createRuntimeLayer(...args: Parameters<typeof createDataLayer>) {
  return { ...createDataLayer(...args), db: createLedger(args[0], args[1]).db };
}
const keyId = 'a'.repeat(64);
const rawPaste = {
  sender: 'PASTE',
  receivedAt: Date.parse('2026-10-07T12:00:00.000Z'),
  body: 'Your A/c XX1234 INR 750 txn 612345678901',
};
const longNote = `\t=SUM(1,2), "fictional"\r\n${'Long synthetic note. '.repeat(28)}`;
const checks = [
  'migration-preserves-existing-ledger',
  'account-category-crud',
  'manual-entry-validation-and-edit',
  'india-month-boundaries-and-budget-recompute',
  'paid-bill-does-not-create-expense',
  'keyed-paste-deduplicates-concurrent-replays',
  'csv-escapes-special-and-long-notes',
] as const;

const fingerprinter: Fingerprinter = {
  keyId,
  async fingerprint(value) {
    // Fixture-only deterministic hash; the device HMAC implementation is verified separately.
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
  },
};

function expect(condition: unknown, check: string): asserts condition {
  if (!condition) throw new Error(`Runtime check failed: ${check}`);
}

async function expectReject(action: () => Promise<unknown>, check: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`Runtime check failed: ${check}`);
}

function migrationsThrough(migrations: LedgerMigrations, count: number): LedgerMigrations {
  const entries = migrations.journal.entries.slice(0, count);
  const scripts: Record<string, string> = {};
  for (const entry of entries) {
    const key = `m${String(entry.idx).padStart(4, '0')}`;
    const script = migrations.migrations[key];
    if (!script) throw new Error('Runtime check failed: migration script missing');
    scripts[key] = script;
  }
  return { journal: { entries }, migrations: scripts };
}

async function hasTransaction(layer: ReturnType<typeof createRuntimeLayer>, id: string): Promise<boolean> {
  return Boolean(await layer.db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, id)).get());
}

async function seedPreviousSchema(client: LedgerSQLiteClient, migrations: LedgerMigrations): Promise<void> {
  const previous = migrationsThrough(migrations, Math.min(2, migrations.journal.entries.length));
  if (previous.journal.entries.length === 0) throw new Error('Runtime check failed: no previous schema');
  await migrateLedger(client, previous);
  const layer = createRuntimeLayer(client, previous);

  if (!(await layer.listAccounts(true)).some((account) => account.id === 'runtime-cash')) {
    await layer.createAccount({ id: 'runtime-cash', name: 'Fictional cash', type: 'cash' });
  }
  // Raw SQL: the current ORM schema has columns this older ledger doesn't.
  await client.execAsync("INSERT OR IGNORE INTO categories (id, name, kind) VALUES ('runtime-food', 'Fictional food', 'expense'), ('runtime-income', 'Fictional income', 'income')");

  const entries = [
    { id: 'runtime-old-expense', amountInr: '100.00', direction: 'debit' as const, occurredAt: '2026-09-30T18:30:00.000Z', categoryId: 'runtime-food' },
    { id: 'runtime-tombstone', amountInr: '900.00', direction: 'debit' as const, occurredAt: '2026-10-15T12:00:00.000Z', categoryId: 'runtime-food' },
    { id: 'runtime-before-month', amountInr: '200.00', direction: 'debit' as const, occurredAt: '2026-09-30T18:29:59.999Z', categoryId: 'runtime-food' },
    { id: 'runtime-month-end', amountInr: '20.00', direction: 'debit' as const, occurredAt: '2026-10-31T18:29:59.999Z', categoryId: 'runtime-food' },
    { id: 'runtime-next-month', amountInr: '30.00', direction: 'debit' as const, occurredAt: '2026-10-31T18:30:00.000Z', categoryId: 'runtime-food' },
    { id: 'runtime-income', amountInr: '500.00', direction: 'credit' as const, occurredAt: '2026-10-15T12:00:00.000Z', categoryId: 'runtime-income' },
  ];
  for (const entry of entries) {
    if (await hasTransaction(layer, entry.id)) continue;
    await layer.saveManualEntry({
      ...entry,
      occurredAt: new Date(entry.occurredAt),
      accountId: 'runtime-cash',
    });
  }
  const tombstone = await layer.db.select().from(transactions)
    .where(eq(transactions.id, 'runtime-tombstone')).get();
  if (tombstone && tombstone.deletedAt === null) {
    await layer.softDeleteTransaction('runtime-tombstone', new Date('2026-10-16T00:00:00.000Z'));
  }
}

async function seedCurrentData(layer: ReturnType<typeof createRuntimeLayer>): Promise<void> {
  const accounts = await layer.listAccounts(true);
  if (!(await layer.updateAccount('runtime-cash', { name: 'Fictional cash, "daily"' }))) {
    if (!accounts.some((account) => account.id === 'runtime-cash')) throw new Error('Runtime check failed: account setup');
  }
  expect(await layer.archiveAccount('runtime-cash'), 'account archive operation');
  expect(!(await layer.listAccounts()).some((account) => account.id === 'runtime-cash'), 'account archive');
  expect((await layer.listAccounts(true)).some((account) => account.id === 'runtime-cash' && account.archived), 'archived account listing');

  expect(await layer.updateCategory('runtime-food', { name: 'Fictional food, "daily"' }), 'category update');
  const disposable = (await layer.listCategories()).find((category) => category.id === 'runtime-disposable');
  if (!disposable) await layer.createCategory({ id: 'runtime-disposable', name: 'Temporary', kind: 'expense' });
  expect(await layer.deleteCategory('runtime-disposable'), 'category deletion');

  const manual = await layer.getTransaction('runtime-manual');
  if (!manual) {
    await layer.saveManualEntry({
      id: 'runtime-manual',
      amountInr: '12.34',
      direction: 'debit',
      occurredAt: new Date('2026-10-07T12:00:00.000Z'),
      accountId: 'runtime-cash',
      categoryId: 'runtime-food',
      note: longNote,
    });
  }
  await expectReject(() => layer.saveManualEntry({
    id: 'runtime-invalid-amount',
    amountInr: '1.001',
    direction: 'debit',
    occurredAt: new Date('2026-10-07T12:00:00.000Z'),
  }), 'manual amount validation');
  await layer.editTransaction('runtime-manual', { amountPaise: 1234, note: longNote });

  await layer.setBudget({ id: 'runtime-food-oct', categoryId: 'runtime-food', month: '2026-10', amountPaise: 36000 });
  const beforeEdit = (await layer.getBudgetSummary('2026-10')).find((budget) => budget.categoryId === 'runtime-food');
  expect(beforeEdit?.spentPaise === 13234 && !beforeEdit.overBudget, 'initial budget total');
  await layer.editTransaction('runtime-manual', { amountPaise: 25000 });
  const afterEdit = (await layer.getBudgetSummary('2026-10')).find((budget) => budget.categoryId === 'runtime-food');
  expect(afterEdit?.spentPaise === 37000 && afterEdit.remainingPaise === -1000 && afterEdit.overBudget, 'recomputed budget total');
  await expectReject(() => layer.updateCategory('runtime-food', { kind: 'income' }), 'budget category kind protection');
  await expectReject(() => layer.deleteCategory('runtime-food'), 'referenced category protection');

  const billRows = await layer.listBills('2026-10-07');
  if (!billRows.some((bill) => bill.id === 'runtime-bill')) {
    await layer.createBill({ id: 'runtime-bill', label: 'Fictional utility', amountPaise: 45000, dueDate: '2026-10-01' });
  }
  await layer.setBillPaid('runtime-bill', false);
  expect((await layer.listBills('2026-10-07')).find((bill) => bill.id === 'runtime-bill')?.status === 'overdue', 'overdue bill status');
  const transactionCount = (await layer.db.select({ id: transactions.id }).from(transactions).all()).length;
  const expensesBeforePayment = (await layer.getMonthlySummary('2026-10')).expensePaise;
  await layer.setBillPaid('runtime-bill', true);
  expect((await layer.listBills('2026-10-07')).find((bill) => bill.id === 'runtime-bill')?.status === 'paid', 'paid bill status');
  expect((await layer.db.select({ id: transactions.id }).from(transactions).all()).length === transactionCount, 'bill payment transaction count');
  expect((await layer.getMonthlySummary('2026-10')).expensePaise === expensesBeforePayment, 'bill payment does not alter spend');
}

async function verifyTransactions(layer: ReturnType<typeof createRuntimeLayer>): Promise<void> {
  const oldExpense = await layer.getTransaction('runtime-old-expense');
  expect(oldExpense?.amountPaise === 10000 && oldExpense.userEdited, 'preserved pre-migration expense');
  expect(await layer.getTransaction('runtime-tombstone') === undefined, 'deleted transaction stays hidden');
  const tombstone = await layer.db.select().from(transactions).where(eq(transactions.id, 'runtime-tombstone')).get();
  expect(tombstone?.deletedAt instanceof Date, 'deleted transaction tombstone survives');
  expect(await layer.getTransaction('runtime-before-month') !== undefined, 'pre-month row persists');
  expect(await layer.getTransaction('runtime-month-end') !== undefined, 'month-end row persists');
  expect(await layer.getTransaction('runtime-next-month') !== undefined, 'next-month row persists');
  const manual = await layer.getTransaction('runtime-manual');
  expect(manual?.amountPaise === 25000 && manual.note === longNote && longNote.length > 255, 'manual edit and long note persist');

  const summary = await layer.getMonthlySummary('2026-10');
  expect(summary.expensePaise === 37100 && summary.incomePaise === 50000 && summary.netPaise === 12900, 'India month totals');
  const food = summary.categories.find((category) => category.categoryId === 'runtime-food');
  expect(food?.expensePaise === 37000 && food.categoryName === 'Fictional food, "daily"', 'India month boundaries and category totals');
  const budget = (await layer.getBudgetSummary('2026-10')).find((row) => row.categoryId === 'runtime-food');
  expect(budget?.spentPaise === 37000 && budget.remainingPaise === -1000 && budget.overBudget, 'budget summary after edit');
  expect((await layer.listBills('2026-10-07')).find((bill) => bill.id === 'runtime-bill')?.status === 'paid', 'bill payment survives reopen');
}

async function verifyPasteAndCsv(
  layer: ReturnType<typeof createRuntimeLayer>,
  phase: 'seed' | 'reopen',
  previouslySeeded: boolean,
): Promise<void> {
  const prepared = await layer.preparePaste(rawPaste);
  expect(prepared.kind === 'needs-review' && prepared.candidate === null, 'paste review preparation');
  if (prepared.kind !== 'needs-review') throw new Error('Runtime check failed: paste review preparation');
  expect(prepared.fingerprintKeyId === keyId && !prepared.duplicateReviewRequired, 'stable import key state');
  expect(!JSON.stringify(prepared).includes(rawPaste.body), 'paste text is not retained');
  const corrections = {
    amountPaise: 100,
    direction: 'debit' as const,
    kind: 'expense' as const,
    status: 'posted' as const,
    occurredAt: new Date(rawPaste.receivedAt),
  };
  const before = (await layer.db.select({ id: transactions.id }).from(transactions).all()).length;
  const outcomes = await Promise.all([
    layer.saveReviewedPaste(prepared, corrections),
    layer.saveReviewedPaste(prepared, corrections),
  ]);
  const insertedCount = outcomes.filter((result) => result === 'inserted').length;
  const expectedInsertedCount = phase === 'seed' && !previouslySeeded ? 1 : 0;
  expect(insertedCount === expectedInsertedCount, 'concurrent keyed paste outcomes');
  const after = (await layer.db.select({ id: transactions.id }).from(transactions).all()).length;
  expect(after === before + expectedInsertedCount, 'paste replay transaction count');
  const summary = await layer.getMonthlySummary('2026-10');
  expect(summary.expensePaise === 37100, 'paste preserves India month totals');

  const csv = await layer.exportTransactionsCsv();
  expect(csv.includes(`"'\t=SUM(1,2), ""fictional""\r\n`), 'CSV formula escaping and quoted multiline note');
  expect(csv.includes(longNote.slice(longNote.indexOf('Long synthetic'), longNote.indexOf('Long synthetic') + 18)), 'CSV long note content');
  expect(!csv.includes(rawPaste.body), 'CSV omits raw pasted message');
}

/** Runs against an isolated app database, once before and once after process restart. */
export async function runDataLayerRuntimeCheck(
  client: LedgerSQLiteClient,
  migrations: LedgerMigrations,
  phase: 'seed' | 'reopen',
): Promise<{ phase: 'seed' | 'reopen'; passed: true; checks: readonly string[] }> {
  const versionRow = await client.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const initialVersion = versionRow?.user_version ?? 0;
  const hasSeed = initialVersion > 0 && Boolean(await client.getFirstAsync<{ id: string }>(
    'SELECT id FROM transactions WHERE id = ?', 'runtime-old-expense',
  ));
  if (phase === 'reopen' && initialVersion !== migrations.journal.entries.length) {
    throw new Error('Runtime check failed: reopen requires the latest schema');
  }
  if (phase === 'reopen' && !hasSeed) throw new Error('Runtime check failed: seeded records are missing');
  if (phase === 'seed' && initialVersion > 0 && !hasSeed) {
    throw new Error('Runtime check failed: seed phase requires an empty or previously seeded database');
  }

  if (phase === 'seed' && initialVersion === 0) await seedPreviousSchema(client, migrations);
  const layer = createRuntimeLayer(client, migrations, async () => fingerprinter);
  await layer.migrateLedger();
  const seededBefore = Boolean(await layer.getTransaction('runtime-manual'));
  if (phase === 'seed') await seedCurrentData(layer);
  await verifyPasteAndCsv(layer, phase, seededBefore);
  await verifyTransactions(layer);

  return { phase, passed: true, checks };
}
