export type FinanceSetup = {
  salaryDay: number;
  salaryAmountPaise: number;
  reservePaise: number;
};

export type PlannedObligation = {
  id: string;
  label: string;
  amountPaise: number;
  dueDate: string;
  paid: boolean;
  kind: 'bill' | 'card_payment';
};

export type FinanceBalance = {
  accountId: string;
  name: string;
  type: string;
  lastVerifiedAt: Date | null;
  calculatedPaise: number | null;
};

export type ForecastInput = {
  now: Date;
  setup: FinanceSetup | null;
  balances: FinanceBalance[];
  obligations: PlannedObligation[];
  unassignedCount: number;
  pendingReviewCount: number;
};

export type FinancePlan = {
  status: 'ready' | 'needs-setup' | 'incomplete';
  reason: string | null;
  nextSalaryDate: string | null;
  liquidPaise: number | null;
  cardOutstandingPaise: number | null;
  billsReservedPaise: number | null;
  reservePaise: number | null;
  safeToSpendPaise: number | null;
  dailyAllowancePaise: number | null;
  daysUntilSalary: number | null;
  oldestBalanceCheckpointAt: Date | null;
  upcoming: PlannedObligation[];
  equation: string;
};

const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
const dayMilliseconds = 86_400_000;
const equation = 'Tracked liquid balances minus full credit-card outstanding minus unpaid bills due on or before salary minus your cash reserve. Expected salary is not included. Card payments are already covered by outstanding.';

function integer(value: number, minimum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be a safe integer of at least ${minimum}`);
}

function safe(value: bigint): number {
  if (value > maxSafe || value < -maxSafe) throw new Error('Finance plan aggregate exceeds safe integer paise');
  return Number(value);
}

function validDate(value: Date, label: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid Date`);
}

function text(value: string, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must not be empty`);
}

function dateValue(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function calendarDate(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Due date must be YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number);
  const date = dateValue(year, month, day);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error('Due date must be a real calendar date');
  }
  return date;
}

function salaryDate(year: number, month: number, salaryDay: number): string {
  const lastDay = dateValue(year, month + 1, 0).getUTCDate();
  return dateValue(year, month, Math.min(salaryDay, lastDay)).toISOString().slice(0, 10);
}

export function calculateFinancePlan(input: ForecastInput): FinancePlan {
  validDate(input.now, 'Current time');
  integer(input.unassignedCount, 0, 'Unassigned transaction count');
  integer(input.pendingReviewCount, 0, 'Pending review count');
  if (!Array.isArray(input.balances) || !Array.isArray(input.obligations)) throw new Error('Balances and obligations must be arrays');
  if (input.setup !== null) {
    integer(input.setup.salaryDay, 1, 'Salary day');
    if (input.setup.salaryDay > 31) throw new Error('Salary day must be between 1 and 31');
    integer(input.setup.salaryAmountPaise, 1, 'Salary amount');
    integer(input.setup.reservePaise, 0, 'Cash reserve');
  }
  const accountIds = new Set<string>();
  for (const balance of input.balances) {
    text(balance.accountId, 'Account ID');
    text(balance.name, 'Account name');
    if (accountIds.has(balance.accountId)) throw new Error('Duplicate account balance');
    accountIds.add(balance.accountId);
    if (!['bank', 'credit_card', 'wallet', 'upi_lite', 'cash'].includes(balance.type)) throw new Error('Unknown account type');
    if (balance.lastVerifiedAt !== null) {
      validDate(balance.lastVerifiedAt, 'Balance checkpoint');
      if (balance.lastVerifiedAt.getTime() > input.now.getTime()) throw new Error('Balance checkpoint must not be in the future');
    }
    if (balance.calculatedPaise !== null) integer(balance.calculatedPaise, -Number.MAX_SAFE_INTEGER, 'Account balance');
  }
  const obligationIds = new Set<string>();
  for (const obligation of input.obligations) {
    text(obligation.id, 'Obligation ID');
    text(obligation.label, 'Obligation label');
    if (obligationIds.has(obligation.id)) throw new Error('Duplicate obligation');
    obligationIds.add(obligation.id);
    integer(obligation.amountPaise, 1, 'Obligation amount');
    calendarDate(obligation.dueDate);
    if (typeof obligation.paid !== 'boolean' || !['bill', 'card_payment'].includes(obligation.kind)) throw new Error('Invalid obligation state');
  }
  const upcoming = input.obligations.filter((item) => !item.paid).sort((a, b) => {
    const left = `${a.dueDate}:${a.id}`;
    const right = `${b.dueDate}:${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const checkpointTimes = input.balances.flatMap((balance) => balance.lastVerifiedAt === null ? [] : [balance.lastVerifiedAt.getTime()]);
  const result: FinancePlan = {
    status: 'needs-setup', reason: 'Set your salary day, expected salary and cash reserve.',
    nextSalaryDate: null, liquidPaise: null, cardOutstandingPaise: null, billsReservedPaise: null,
    reservePaise: input.setup?.reservePaise ?? null, safeToSpendPaise: null, dailyAllowancePaise: null,
    daysUntilSalary: null,
    oldestBalanceCheckpointAt: checkpointTimes.length === 0 ? null : new Date(Math.min(...checkpointTimes)),
    upcoming, equation,
  };
  if (input.setup === null) return result;
  const today = new Date(input.now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const todayDate = calendarDate(today);
  const year = todayDate.getUTCFullYear();
  const month = todayDate.getUTCMonth() + 1;
  let nextSalaryDate = salaryDate(year, month, input.setup.salaryDay);
  if (nextSalaryDate < today) nextSalaryDate = salaryDate(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, input.setup.salaryDay);
  const daysUntilSalary = (calendarDate(nextSalaryDate).getTime() - todayDate.getTime()) / dayMilliseconds;
  result.nextSalaryDate = nextSalaryDate;
  result.daysUntilSalary = daysUntilSalary;
  const missing = [];
  if (input.balances.length === 0) missing.push('add your accounts');
  if (input.balances.some((balance) => balance.lastVerifiedAt === null || balance.calculatedPaise === null)) missing.push('verify every account balance');
  if (upcoming.some((obligation) => obligation.kind === 'card_payment') && !input.balances.some((balance) => balance.type === 'credit_card')) {
    missing.push('add and verify the relevant credit-card account');
  }
  if (input.unassignedCount > 0) missing.push('assign all transactions to accounts');
  if (input.pendingReviewCount > 0) missing.push('resolve pending transaction reviews');
  if (missing.length > 0) return { ...result, status: 'incomplete', reason: `Before estimating safe to spend: ${missing.join('; ')}.` };

  let liquid = 0n;
  let outstanding = 0n;
  let bills = 0n;
  for (const balance of input.balances) {
    const amount = BigInt(balance.calculatedPaise!);
    if (balance.type === 'credit_card') outstanding += amount > 0n ? amount : 0n;
    else liquid += amount;
    safe(liquid);
    safe(outstanding);
  }
  for (const obligation of upcoming) {
    if (obligation.kind === 'bill' && obligation.dueDate <= nextSalaryDate) {
      bills += BigInt(obligation.amountPaise);
      safe(bills);
    }
  }
  const headroom = liquid - outstanding - bills - BigInt(input.setup.reservePaise);
  const safeToSpendPaise = safe(headroom);
  const days = BigInt(daysUntilSalary);
  // Negative daily amounts round down too, so a shortfall never rounds away to zero.
  const daily = days === 0n ? null : safe(headroom >= 0n ? headroom / days : -((-headroom + days - 1n) / days));
  return {
    ...result, status: 'ready',
    reason: daysUntilSalary === 0 ? 'Salary is due today. Only money already in your tracked balances is included.' : null,
    liquidPaise: safe(liquid), cardOutstandingPaise: safe(outstanding), billsReservedPaise: safe(bills),
    safeToSpendPaise, dailyAllowancePaise: daily,
  };
}
