import { and, asc, count, eq, gt, isNull, lte } from 'drizzle-orm';
import { calculateFinancePlan, type FinancePlan, type FinanceSetup, type PlannedObligation } from './finance-plan';
import { createLedger, type Ledger, type LedgerMigrations, type LedgerSQLiteClient, type LedgerSQLiteTransactionRunner } from './ledger';
import { createPlanning } from './planning';
import { getFinanceTransactionRunner } from './finance-transaction';
import { createReconciliation } from './reconciliation';
import { bills, preferences, recurringSchedules, smsImportRefs, transactions } from './schema';

export type PersonalFinanceSetup = FinanceSetup & { commitmentsConfirmed: boolean; accountCoverageConfirmed: boolean };
type PersonalFinanceSetupInput = Omit<PersonalFinanceSetup, 'accountCoverageConfirmed'> & { accountCoverageConfirmed?: boolean };
export type NewRecurringSchedule = Pick<typeof recurringSchedules.$inferInsert, 'id' | 'label' | 'amountPaise' | 'dayOfMonth' | 'kind'>;
type Schedule = typeof recurringSchedules.$inferSelect;
type OccurrenceState = { startMonth: string; lastMaterializedMonth: string | null };
const setupKey = 'finance.setup';
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

function record(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new TypeError('Invalid personal finance configuration');
  }
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError('Expected a safe integer within the supported range');
  }
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected non-empty text');
}
function validateSetup(value: unknown): asserts value is PersonalFinanceSetup {
  record(value, ['salaryDay', 'salaryAmountPaise', 'reservePaise', 'commitmentsConfirmed', 'accountCoverageConfirmed']);
  integer(value.salaryDay, 1, 31);
  integer(value.salaryAmountPaise, 1);
  integer(value.reservePaise, 0);
  if (typeof value.commitmentsConfirmed !== 'boolean') throw new TypeError('Confirm commitments explicitly');
  if (typeof value.accountCoverageConfirmed !== 'boolean') throw new TypeError('Confirm account coverage explicitly');
}
function normalizeSetup(value: unknown): PersonalFinanceSetup {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      !Object.hasOwn(value, 'accountCoverageConfirmed') && Object.keys(value).length === 4) {
    const legacy = { ...value, accountCoverageConfirmed: false };
    validateSetup(legacy);
    return legacy;
  }
  validateSetup(value);
  return value;
}
function todayInIndia(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Expected a valid current date');
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || today.startsWith('0000')) throw new RangeError('Current year must be between 1 and 9999');
  return today;
}
function nextMonth(month: string): string {
  const [year, number] = month.split('-').map(Number);
  if (year === 9999 && number === 12) throw new RangeError('Next month exceeds supported calendar');
  return number === 12 ? `${year + 1}-01`.padStart(7, '0') : `${String(year).padStart(4, '0')}-${String(number + 1).padStart(2, '0')}`;
}
function previousMonth(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return number === 1 ? `${String(year - 1).padStart(4, '0')}-12` : `${String(year).padStart(4, '0')}-${String(number - 1).padStart(2, '0')}`;
}
function dueDate(month: string, day: number): string {
  const [year, number] = month.split('-').map(Number);
  const last = new Date(0);
  last.setUTCFullYear(year, number, 0);
  return `${month}-${String(Math.min(day, last.getUTCDate())).padStart(2, '0')}`;
}
function occurrencePrefix(id: string): string { return `finance-recurring:${encodeURIComponent(id)}:`; }
function stateKey(id: string): string { return `finance.recurring.${encodeURIComponent(id)}`; }

async function readSetup(db: Ledger['db']): Promise<PersonalFinanceSetup | null> {
  const row = await db.select().from(preferences).where(eq(preferences.key, setupKey)).get();
  if (!row) return null;
  return normalizeSetup(JSON.parse(row.value));
}
async function storePreference(db: Ledger['db'], key: string, value: unknown) {
  await db.insert(preferences).values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: preferences.key, set: { value: JSON.stringify(value) } }).run();
}
async function occurrenceState(db: Ledger['db'], id: string): Promise<OccurrenceState> {
  const row = await db.select().from(preferences).where(eq(preferences.key, stateKey(id))).get();
  if (!row) throw new Error('Recurring schedule is missing its occurrence checkpoint');
  const state: unknown = JSON.parse(row.value);
  record(state, ['startMonth', 'lastMaterializedMonth']);
  if (typeof state.startMonth !== 'string' || !monthPattern.test(state.startMonth) || state.startMonth.startsWith('0000') ||
      !(state.lastMaterializedMonth === null || (typeof state.lastMaterializedMonth === 'string' &&
        monthPattern.test(state.lastMaterializedMonth) && state.lastMaterializedMonth >= state.startMonth))) {
    throw new Error('Invalid recurring occurrence checkpoint');
  }
  return state as OccurrenceState;
}
async function materialize(db: Ledger['db'], schedules: Schedule[], today: string) {
  const month = today.slice(0, 7);
  const end = nextMonth(month);
  for (const schedule of schedules) {
    if (schedule.paused) continue;
    const checkpoint = await occurrenceState(db, schedule.id);
    if (checkpoint.lastMaterializedMonth !== null && checkpoint.lastMaterializedMonth >= end) continue;
    const initial = checkpoint.lastMaterializedMonth === null;
    let target = initial ? checkpoint.startMonth : nextMonth(checkpoint.lastMaterializedMonth!);
    const [targetYear, targetMonth] = target.split('-').map(Number);
    const [endYear, endMonth] = end.split('-').map(Number);
    if ((endYear - targetYear) * 12 + endMonth - targetMonth >= 1200) throw new RangeError('Recurring schedule gap exceeds 100 years; review commitments before continuing');
    let advanced = false;
    for (; target <= end; target = nextMonth(target)) {
      const date = dueDate(target, schedule.dayOfMonth);
      if (!initial || date >= today) {
        await db.insert(bills).values({
          id: `${occurrencePrefix(schedule.id)}${target}`, label: schedule.label,
          amountPaise: schedule.amountPaise, dueDate: date,
        }).onConflictDoNothing().run();
      }
      // Mark skipped/deleted months too: opening the app must never resurrect an occurrence.
      checkpoint.lastMaterializedMonth = target;
      advanced = true;
      if (target === end) break;
    }
    if (advanced) await storePreference(db, stateKey(schedule.id), checkpoint);
  }
}

export function createPersonalFinance(client: LedgerSQLiteClient, migrations: LedgerMigrations, runner?: LedgerSQLiteTransactionRunner) {
  const run = getFinanceTransactionRunner(client, runner);
  async function inTransaction<T>(task: (db: Ledger['db'], transaction: LedgerSQLiteClient) => Promise<T>): Promise<T> {
    let value!: T;
    await run(async transaction => { value = await task(createLedger(transaction, migrations).db, transaction); });
    return value;
  }
  return {
    getFinanceSetup: () => inTransaction(db => readSetup(db)),
    async saveFinanceSetup(input: PersonalFinanceSetupInput): Promise<void> {
      const value = normalizeSetup(input);
      await inTransaction(db => storePreference(db, setupKey, value));
    },
    async createRecurringSchedule(input: NewRecurringSchedule, now = new Date()): Promise<void> {
      record(input, ['id', 'label', 'amountPaise', 'dayOfMonth', 'kind']);
      text(input.id); text(input.label);
      integer(input.amountPaise, 1); integer(input.dayOfMonth, 1, 31);
      if (!['bill', 'card_payment'].includes(input.kind)) throw new TypeError('Unknown recurring schedule kind');
      const today = todayInIndia(now);
      const value = { ...input, label: input.label.trim(), paused: false };
      await inTransaction(async db => {
        await db.insert(recurringSchedules).values(value).run();
        await storePreference(db, stateKey(value.id), { startMonth: today.slice(0, 7), lastMaterializedMonth: null });
        await materialize(db, [value], today);
      });
    },
    listRecurringSchedules: () => inTransaction(db => db.select().from(recurringSchedules).orderBy(asc(recurringSchedules.label), asc(recurringSchedules.id)).all()),
    async setRecurringSchedulePaused(id: string, paused: boolean, now = new Date()): Promise<boolean> {
      text(id);
      if (typeof paused !== 'boolean') throw new TypeError('paused must be a boolean');
      const today = todayInIndia(now);
      return inTransaction(async db => {
        const previous = await db.select().from(recurringSchedules).where(eq(recurringSchedules.id, id)).get();
        const rows = await db.update(recurringSchedules).set({ paused }).where(eq(recurringSchedules.id, id)).returning().all();
        if (!paused) {
          if (previous?.paused) {
            const checkpoint = await occurrenceState(db, id);
            const month = today.slice(0, 7);
            const skippedThrough = dueDate(month, previous.dayOfMonth) < today ? month : previousMonth(month);
            if (checkpoint.lastMaterializedMonth === null || checkpoint.lastMaterializedMonth < skippedThrough) {
              checkpoint.lastMaterializedMonth = skippedThrough;
              await storePreference(db, stateKey(id), checkpoint);
            }
          }
          await materialize(db, rows, today);
        }
        return rows.length > 0;
      });
    },
    async getPersonalFinancePlan(now: Date): Promise<FinancePlan> {
      const today = todayInIndia(now);
      const asOf = new Date(now.getTime());
      return inTransaction(async (db, transaction) => {
        const setup = await readSetup(db);
        const schedules = await db.select().from(recurringSchedules).all();
        await materialize(db, schedules, today);
        const occurrences = await db.select().from(bills).all();
        const obligations: PlannedObligation[] = occurrences.map(bill => ({
          ...bill, kind: schedules.find(schedule => bill.id.startsWith(occurrencePrefix(schedule.id)))?.kind ?? 'bill',
        }));
        const reconciliation = createReconciliation(transaction, migrations, task => task(transaction));
        const balances = (await reconciliation.getAccountBalances(asOf)).filter(balance => balance.isOwn).map(balance => ({
          ...balance,
          // Archived assets are unavailable; archiving must never hide a debt or unknown balance.
          calculatedPaise: balance.archived && balance.type !== 'credit_card' && balance.calculatedPaise !== null
            ? Math.min(balance.calculatedPaise, 0) : balance.calculatedPaise,
        }));
        const verified = balances.flatMap(balance => balance.lastVerifiedAt !== null && balance.lastVerifiedAt <= asOf && balance.calculatedPaise !== null ? [balance.lastVerifiedAt.getTime()] : []);
        const cutoff = verified.length > 0 ? new Date(Math.min(...verified)) : null;
        const unassigned = cutoff === null ? null : await db.select({ total: count() }).from(transactions).where(and(
          isNull(transactions.accountId), eq(transactions.status, 'posted'), isNull(transactions.deletedAt),
          gt(transactions.occurredAt, cutoff), lte(transactions.occurredAt, asOf),
        )).get();
        const pending = cutoff === null ? null : await db.select({ total: count() }).from(smsImportRefs).where(and(
          eq(smsImportRefs.status, 'review'), gt(smsImportRefs.receivedAt, cutoff.getTime()), lte(smsImportRefs.receivedAt, asOf.getTime()),
        )).get();
        const plan = calculateFinancePlan({
          now: asOf, setup: setup?.commitmentsConfirmed && setup.accountCoverageConfirmed ? setup : null, balances, obligations,
          unassignedCount: unassigned?.total ?? 0, pendingReviewCount: pending?.total ?? 0,
        });
        if (setup && (!setup.commitmentsConfirmed || !setup.accountCoverageConfirmed)) {
          const missing = [
            !setup.commitmentsConfirmed ? 'all regular bills, card obligations and other commitments' : null,
            !setup.accountCoverageConfirmed ? 'all accounts and cards that affect this estimate' : null,
          ].filter((item): item is string => item !== null);
          plan.reason = `Confirm ${missing.join(' and ')} before estimating safe to spend.`;
        }
        if (plan.status === 'incomplete' && balances.some(balance => balance.archived && balance.calculatedPaise === null)) {
          plan.reason = `${plan.reason} Unarchive and reconcile every archived account with an unknown balance; archiving cannot remove a liability.`;
        }
        return plan;
      });
    },
    async setPlannedObligationPaid(id: string, paid: boolean): Promise<boolean> {
      text(id);
      if (typeof paid !== 'boolean') throw new TypeError('paid must be a boolean');
      return inTransaction(db => createPlanning(db).setBillPaid(id, paid));
    },
  };
}
