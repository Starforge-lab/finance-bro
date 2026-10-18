import { eq } from 'drizzle-orm';
import { createLedger, type LedgerMigrations, type LedgerSQLiteClient, type LedgerSQLiteTransactionRunner } from '../src/db/ledger';
import { createDataLayer } from '../src/db/service';
import { preferences } from '../src/db/schema';

/** Run only against a separate fictional test database, never the user's ledger. */
export async function runFinanceRuntimeCheck(
  client: LedgerSQLiteClient,
  migrations: LedgerMigrations,
  runner?: LedgerSQLiteTransactionRunner,
): Promise<{ checks: string[]; phase: 'seeded' | 'reopened' }> {
  const checks: string[] = [];
  function check(name: string, condition: unknown): asserts condition {
    if (!condition) throw new Error(`Finance runtime check failed: ${name}`);
    checks.push(name);
  }
  async function rejects(name: string, action: () => Promise<unknown>) {
    let rejected = false;
    try { await action(); } catch { rejected = true; }
    check(name, rejected);
  }
  const now = new Date('2026-10-18T12:00:00.000Z');
  const checkpoint = new Date('2026-10-18T00:00:00.000Z');
  const markerKey = 'runtime.finance.check.v1';
  const hasPreferences = await client.getFirstAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preferences'");
  const marker = hasPreferences ? await client.getFirstAsync<{ value: string }>('SELECT value FROM preferences WHERE key = ?', markerKey) : null;
  const phase = marker === null ? 'seeded' : 'reopened';
  const legacy = { ...migrations, journal: { entries: migrations.journal.entries.slice(0, 9) } };
  if (phase === 'seeded') {
    check('ten migration entries available', migrations.journal.entries.length === 10);
    const oldLedger = createLedger(client, legacy);
    await oldLedger.migrateLedger();
    await oldLedger.createAccount({ id: 'runtime-bank', name: 'Fictional bank', type: 'bank' });
    await oldLedger.createAccount({ id: 'runtime-card', name: 'Fictional card', type: 'credit_card' });
    await oldLedger.createTransaction({ id: 'runtime-legacy', accountId: 'runtime-bank', amountPaise: 123,
      direction: 'debit', kind: 'expense', status: 'posted', source: 'manual', occurredAt: new Date('2026-10-17T00:00:00.000Z') });
  }
  const api = createDataLayer(client, migrations, undefined, runner);
  await api.migrateLedger();
  check('migration preserves legacy transaction', (await api.listTransactions()).some(row => row.id === 'runtime-legacy' && row.amountPaise === 123));
  const setup = { salaryDay: 25, salaryAmountPaise: 9_000_000, reservePaise: 500_000, commitmentsConfirmed: true };
  if (phase === 'seeded') {
    await api.saveFinanceSetup(setup);
    await api.setAccountBalance({ accountId: 'runtime-bank', balancePaise: 5_000_000, asOf: checkpoint }, now);
    await api.setAccountBalance({ accountId: 'runtime-card', balancePaise: 1_000_000, asOf: checkpoint }, now);
    await api.createRecurringSchedule({ id: 'runtime-bill', label: 'Fictional bill', amountPaise: 200_000, dayOfMonth: 25, kind: 'bill' }, now);
    await api.createRecurringSchedule({ id: 'runtime-payment', label: 'Fictional card payment', amountPaise: 1_000_000, dayOfMonth: 26, kind: 'card_payment' }, now);
    const initial = await api.getPersonalFinancePlan(now);
    check('salary excluded and full card outstanding reserved', initial.status === 'ready' && initial.safeToSpendPaise === 3_300_000 && initial.cardOutstandingPaise === 1_000_000);
    await api.saveManualEntry({ id: 'runtime-expense', accountId: 'runtime-bank', amountInr: '100', direction: 'debit', occurredAt: new Date('2026-10-18T01:00:00.000Z') });
    const spent = await api.getPersonalFinancePlan(now);
    check('posted expense reduces balance and headroom', spent.liquidPaise === 4_990_000 && spent.safeToSpendPaise === 3_290_000);
    const occurrence = spent.upcoming.find(item => item.kind === 'bill' && item.dueDate === '2026-10-25');
    check('bill occurrence materialized', occurrence);
    const count = (await api.listTransactions()).length;
    await api.setPlannedObligationPaid(occurrence.id, true);
    const paid = await api.getPersonalFinancePlan(now);
    check('marking paid releases reserve without adding expense', (await api.listTransactions()).length === count && paid.safeToSpendPaise === 3_490_000);
    await api.archiveAccount('runtime-card');
    const archived = await api.getPersonalFinancePlan(now);
    check('archived card retains debt', archived.safeToSpendPaise === paid.safeToSpendPaise && archived.cardOutstandingPaise === 1_000_000);
    check('archived card restores', await api.restoreAccount('runtime-card'));
    await Promise.all([
      api.getPersonalFinancePlan(now),
      api.saveFinanceSetup({ ...setup, reservePaise: 510_000 }),
      api.saveManualEntry({ id: 'runtime-concurrent', accountId: 'runtime-bank', amountInr: '200', direction: 'debit', occurredAt: new Date('2026-10-18T02:00:00.000Z') }),
      api.setThemePreference('dark'),
    ]);
    check('concurrent finance and manual operations complete', (await api.getPersonalFinancePlan(now)).safeToSpendPaise === 3_460_000);
    await rejects('invalid balance paise rejected', () => api.setAccountBalance({ accountId: 'runtime-bank', balancePaise: 0.5, asOf: now }, now));
    await rejects('invalid setup paise rejected', () => api.saveFinanceSetup({ ...setup, reservePaise: Number.MAX_SAFE_INTEGER + 1 }));
    await rejects('invalid manual precision rejected', () => api.saveManualEntry({ id: 'runtime-invalid', accountId: 'runtime-bank', amountInr: '1.001', direction: 'debit', occurredAt: now }));
    await createLedger(client, migrations).db.insert(preferences).values({ key: markerKey, value: 'complete' }).run();
  }
  const final = await api.getPersonalFinancePlan(now);
  check('final headroom and posted balances persist', final.status === 'ready' && final.safeToSpendPaise === 3_460_000 && final.liquidPaise === 4_970_000);
  check('configuration persists', (await api.getFinanceSetup())?.reservePaise === 510_000 && await api.getThemePreference() === 'dark');
  check('all fictional transactions persist without rejected write', (await api.listTransactions()).length === 3);
  check('restored card persists', (await api.listAccounts()).some(account => account.id === 'runtime-card' && !account.archived));
  check('paid occurrence persists', !final.upcoming.some(item => item.kind === 'bill' && item.dueDate === '2026-10-25'));
  check('completion marker persists', (await createLedger(client, migrations).db.select().from(preferences).where(eq(preferences.key, markerKey)).get())?.value === 'complete');
  return { checks, phase };
}
