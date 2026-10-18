/// <reference types="node" />
import assert from 'node:assert/strict';
import { rmSync, rmdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createPersonalFinance } from '../src/db/personal-finance';
import { createReconciliation } from '../src/db/reconciliation';
import { createPlanning } from '../src/db/planning';
import { ledgerMigrations, openTestLedger, temporaryFile } from './helpers/ledger';

const now = new Date('2026-10-18T10:00:00Z');
const checkpoint = new Date('2026-10-01T00:00:00Z');
const setup = { salaryDay: 28, salaryAmountPaise: 100_000, reservePaise: 1000, commitmentsConfirmed: true };
async function fixture(filename?: string) {
  const f = openTestLedger(filename);
  await f.ledger.migrateLedger();
  await f.ledger.createAccount({ id: 'bank', name: 'Fictional bank', type: 'bank' });
  await f.ledger.createAccount({ id: 'card', name: 'Fictional card', type: 'credit_card' });
  const reconciliation = createReconciliation(f.client, ledgerMigrations);
  await reconciliation.setAccountBalance({ accountId: 'bank', balancePaise: 50_000, asOf: checkpoint }, now);
  await reconciliation.setAccountBalance({ accountId: 'card', balancePaise: 10_000, asOf: checkpoint }, now);
  return { ...f, finance: createPersonalFinance(f.client, ledgerMigrations), planning: createPlanning(f.ledger.db) };
}

describe('personal finance orchestration', () => {
  it('requires explicit setup and confirmed commitments; reserves card outstanding once', async () => {
    const f = await fixture();
    try {
      assert.equal(await f.finance.getFinanceSetup(), null);
      assert.equal((await f.finance.getPersonalFinancePlan(now)).status, 'needs-setup');
      await f.finance.saveFinanceSetup({ ...setup, commitmentsConfirmed: false });
      assert.equal((await f.finance.getPersonalFinancePlan(now)).status, 'needs-setup');
      await f.finance.saveFinanceSetup(setup);
      await f.finance.createRecurringSchedule({ id: 'rent', label: 'Rent', amountPaise: 5000, dayOfMonth: 25, kind: 'bill' }, now);
      await f.finance.createRecurringSchedule({ id: 'card-due', label: 'Card payment', amountPaise: 8000, dayOfMonth: 26, kind: 'card_payment' }, now);
      await f.planning.createBill({ id: 'one-off', label: 'Repair', amountPaise: 2000, dueDate: '2026-10-23' });
      const plan = await f.finance.getPersonalFinancePlan(now);
      assert.equal(plan.status, 'ready');
      assert.equal(plan.cardOutstandingPaise, 10_000);
      assert.equal(plan.billsReservedPaise, 7000);
      assert.equal(plan.safeToSpendPaise, 32_000);
      assert.equal(plan.upcoming.filter(row => row.kind === 'card_payment').length, 2);
      assert.equal(await f.finance.setPlannedObligationPaid('one-off', true), true);
      assert.equal((await f.finance.getPersonalFinancePlan(now)).safeToSpendPaise, 34_000);
    } finally { f.sqlite.close(); }
  });

  it('materializes only current/future months, clamps month ends, and preserves paid, edited and removed occurrences', async () => {
    const f = await fixture();
    try {
      await f.finance.createRecurringSchedule({ id: 'month-end', label: 'Monthly', amountPaise: 1000, dayOfMonth: 31, kind: 'bill' }, now);
      const initial = await f.finance.getPersonalFinancePlan(now);
      assert.deepEqual(initial.upcoming.map(row => row.dueDate), ['2026-10-31', '2026-11-30']);
      const october = initial.upcoming[0]!;
      const november = initial.upcoming[1]!;
      await f.planning.editBill(october.id, { label: 'Corrected', amountPaise: 500 });
      await f.finance.setPlannedObligationPaid(october.id, true);
      await f.planning.removeBill(november.id);
      await f.finance.getPersonalFinancePlan(now);
      assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM bills').get()?.n, 1);
      const december = await f.finance.getPersonalFinancePlan(new Date('2026-12-02T00:00:00Z'));
      assert.deepEqual(december.upcoming.map(row => row.dueDate), ['2026-12-31', '2027-01-31']);
      const saved = f.sqlite.prepare('SELECT label,amount_paise,paid FROM bills WHERE id=?').get(october.id);
      assert.deepEqual({ ...saved }, { label: 'Corrected', amount_paise: 500, paid: 1 });
      await f.finance.createRecurringSchedule({ id: 'past', label: 'Past due day', amountPaise: 200, dayOfMonth: 1, kind: 'bill' }, now);
      assert.equal((await f.finance.getPersonalFinancePlan(now)).upcoming.some(row => row.label === 'Past due day' && row.dueDate === '2026-10-01'), false);
    } finally { f.sqlite.close(); }
  });

  it('pauses only future materialization and resumes without backfilling skipped months', async () => {
    const f = await fixture();
    try {
      await f.finance.createRecurringSchedule({ id: 'monthly', label: 'Monthly', amountPaise: 1000, dayOfMonth: 25, kind: 'bill' }, now);
      assert.equal(await f.finance.setRecurringSchedulePaused('monthly', true, now), true);
      await f.finance.getPersonalFinancePlan(new Date('2027-01-02T00:00:00Z'));
      assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM bills').get()?.n, 2);
      await f.finance.setRecurringSchedulePaused('monthly', false, new Date('2027-02-26T00:00:00Z'));
      const rows = f.sqlite.prepare('SELECT due_date FROM bills ORDER BY due_date').all();
      assert.deepEqual(rows.map(row => row.due_date), ['2026-10-25', '2026-11-25', '2027-03-25']);
      assert.equal((await f.finance.listRecurringSchedules())[0]?.paused, false);
    } finally { f.sqlite.close(); }
  });

  it('catches up missing committed months as overdue and makes unchanged forecast reads write-free', async () => {
    const f = await fixture();
    try {
      await f.finance.createRecurringSchedule({ id: 'monthly', label: 'Monthly', amountPaise: 1000, dayOfMonth: 25, kind: 'bill' }, now);
      const february = new Date('2027-02-26T00:00:00Z');
      const plan = await f.finance.getPersonalFinancePlan(february);
      assert.deepEqual(plan.upcoming.map(row => row.dueDate), ['2026-10-25', '2026-11-25', '2026-12-25', '2027-01-25', '2027-02-25', '2027-03-25']);
      const before = f.sqlite.prepare('SELECT total_changes() AS n').get()!.n;
      await f.finance.getPersonalFinancePlan(february);
      assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get()!.n, before);
      await assert.rejects(f.finance.getPersonalFinancePlan(new Date('2200-01-01T00:00:00Z')), /100 years/);
      assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get()!.n, before);
    } finally { f.sqlite.close(); }
  });

  it('blocks on unresolved activity only after the earliest checkpoint, and ignores archived assets/non-own balances', async () => {
    const f = await fixture();
    try {
      await f.finance.saveFinanceSetup(setup);
      await f.ledger.createAccount({ id: 'other', name: 'Other person', type: 'bank', isOwn: false });
      await f.ledger.createAccount({ id: 'archived', name: 'Archived', type: 'bank' });
      await createReconciliation(f.client, ledgerMigrations).setAccountBalance({ accountId: 'archived', balancePaise: 10_000, asOf: checkpoint }, now);
      await f.ledger.archiveAccount('archived');
      for (const [id, occurredAt] of [['old', checkpoint.getTime() - 1], ['future', now.getTime() + 1]] as const) {
        f.sqlite.prepare("INSERT INTO transactions (id,amount_paise,direction,kind,status,occurred_at,source,created_at,updated_at) VALUES (?,100,'debit','expense','posted',?,'manual',?,?)").run(id, occurredAt, occurredAt, occurredAt);
      }
      assert.equal((await f.finance.getPersonalFinancePlan(now)).status, 'ready');
      f.sqlite.prepare("INSERT INTO transactions (id,amount_paise,direction,kind,status,occurred_at,source,created_at,updated_at) VALUES ('unassigned',100,'debit','expense','posted',?,'manual',?,?)").run(now.getTime(), now.getTime(), now.getTime());
      assert.match((await f.finance.getPersonalFinancePlan(now)).reason!, /assign/);
      f.sqlite.exec("DELETE FROM transactions WHERE id='unassigned'");
      f.sqlite.prepare("INSERT INTO sms_import_refs (reference_id,platform_id,received_at,sender_hash,dedupe_key,body_hash,key_id,status,created_at) VALUES ('pending','1',?,'fake','fake','fake','fake','review',?)").run(now.getTime(), now.getTime());
      assert.match((await f.finance.getPersonalFinancePlan(now)).reason!, /review/);
      f.sqlite.prepare("UPDATE sms_import_refs SET received_at=?").run(checkpoint.getTime());
      assert.equal((await f.finance.getPersonalFinancePlan(now)).status, 'ready');
    } finally { f.sqlite.close(); }
  });

  it('validates setup/schedules and fails closed on corrupt stored configuration', async () => {
    const f = await fixture();
    try {
      for (const patch of [{ salaryDay: 0 }, { salaryDay: 32 }, { salaryAmountPaise: 1.2 }, { reservePaise: -1 }, { commitmentsConfirmed: 'yes' }, { extra: true }]) {
        await assert.rejects(f.finance.saveFinanceSetup({ ...setup, ...patch } as typeof setup));
      }
      await assert.rejects(f.finance.createRecurringSchedule({ id: 'x', label: ' ', amountPaise: 100, dayOfMonth: 1, kind: 'bill' }, now));
      await assert.rejects(f.finance.createRecurringSchedule({ id: 'x', label: 'Bill', amountPaise: 100, dayOfMonth: 32, kind: 'bill' }, now));
      await assert.rejects(f.finance.getPersonalFinancePlan(new Date(NaN)));
      await f.finance.saveFinanceSetup(setup);
      const key = f.sqlite.prepare("SELECT key FROM preferences WHERE value LIKE '%commitmentsConfirmed%'").get()!.key;
      f.sqlite.prepare('UPDATE preferences SET value=? WHERE key=?').run('{"salaryDay":28}', key as string);
      await assert.rejects(f.finance.getFinanceSetup());
      await assert.rejects(f.finance.getPersonalFinancePlan(now));
    } finally { f.sqlite.close(); }
  });

  it('keeps archived own card liabilities reserved and blocks if their checkpoint is missing', async () => {
    const f = await fixture();
    try {
      await f.finance.saveFinanceSetup(setup);
      await f.ledger.archiveAccount('card');
      const plan = await f.finance.getPersonalFinancePlan(now);
      assert.equal(plan.status, 'ready');
      assert.equal(plan.cardOutstandingPaise, 10_000);
      assert.equal(plan.safeToSpendPaise, 39_000);
      f.sqlite.exec("DELETE FROM account_balance_checkpoints WHERE account_id='card'");
      const incomplete = await f.finance.getPersonalFinancePlan(now);
      assert.equal(incomplete.status, 'incomplete');
      assert.equal(incomplete.safeToSpendPaise, null);
      assert.match(incomplete.reason!, /[Uu]narchive.*reconcile/);
    } finally { f.sqlite.close(); }
  });

  it('retains archived overdrafts, excludes archived assets, and blocks unknown archived balances', async () => {
    const f = await fixture();
    try {
      await f.finance.saveFinanceSetup(setup);
      await f.ledger.createAccount({ id: 'closed-bank', name: 'Fictional closed account', type: 'bank' });
      await createReconciliation(f.client, ledgerMigrations).setAccountBalance({ accountId: 'closed-bank', balancePaise: -20_000, asOf: checkpoint }, now);
      await f.ledger.archiveAccount('closed-bank');
      const plan = await f.finance.getPersonalFinancePlan(now);
      assert.equal(plan.liquidPaise, 30_000);
      assert.equal(plan.safeToSpendPaise, 19_000);
      await f.ledger.restoreAccount('closed-bank');
      await createReconciliation(f.client, ledgerMigrations).setAccountBalance({ accountId: 'closed-bank', balancePaise: 20_000, asOf: checkpoint }, now);
      await f.ledger.archiveAccount('closed-bank');
      assert.equal((await f.finance.getPersonalFinancePlan(now)).liquidPaise, 50_000);
      f.sqlite.exec("DELETE FROM account_balance_checkpoints WHERE account_id = 'closed-bank'");
      assert.equal((await f.finance.getPersonalFinancePlan(now)).status, 'incomplete');
    } finally { f.sqlite.close(); }
  });

  it('cannot dismiss card-payment reminders as covered when no own credit card is tracked', async () => {
    const f = await fixture();
    try {
      await f.finance.saveFinanceSetup(setup);
      await f.ledger.updateAccount('card', { isOwn: false });
      await f.finance.createRecurringSchedule({ id: 'card-payment', label: 'Card due', amountPaise: 9000, dayOfMonth: 25, kind: 'card_payment' }, now);
      const plan = await f.finance.getPersonalFinancePlan(now);
      assert.equal(plan.status, 'incomplete');
      assert.equal(plan.safeToSpendPaise, null);
      assert.match(plan.reason!, /card/);
    } finally { f.sqlite.close(); }
  });

  it('persists setup, schedules and occurrence markers across reopening', async () => {
    const { directory, filename } = temporaryFile();
    const f = await fixture(filename);
    try {
      await f.finance.saveFinanceSetup(setup);
      await f.finance.createRecurringSchedule({ id: 'monthly', label: 'Monthly', amountPaise: 1000, dayOfMonth: 25, kind: 'bill' }, now);
      const first = (await f.finance.getPersonalFinancePlan(now)).upcoming[0]!;
      await f.planning.removeBill(first.id);
    } finally { f.sqlite.close(); }
    const reopened = openTestLedger(filename);
    try {
      const finance = createPersonalFinance(reopened.client, ledgerMigrations);
      assert.deepEqual(await finance.getFinanceSetup(), setup);
      assert.equal((await finance.listRecurringSchedules()).length, 1);
      assert.deepEqual((await finance.getPersonalFinancePlan(now)).upcoming.map(row => row.dueDate), ['2026-11-25']);
    } finally { reopened.sqlite.close(); rmSync(filename, { force: true }); rmdirSync(directory); }
  });
});
