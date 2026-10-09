import { indiaDate, money } from './display';

/** The transaction fields the pace view reads; screens pass full ledger rows. */
export type PaceRow = {
  amountPaise: number;
  direction: 'debit' | 'credit';
  kind: string;
  status: string;
  excludeFromStats: boolean;
  occurredAt: Date;
  categoryId: string | null;
};

export type PaceCategory = { id: string; name: string; isFixed: boolean };
export type PaceBudget = { categoryId: string; amountPaise: number };
export type CategorySpend = { categoryId: string | null; categoryName: string | null; expensePaise: number };

export type MonthPace = {
  /** Days in the month; the x axis always spans all of them. */
  days: number;
  /** Days with data: up to today for the current month, all days for a past one. */
  elapsed: number;
  /** Running total in paise at the end of each elapsed day. */
  current: number[];
  /** Last month's running total for each of its days. */
  previous: number[];
  /** The largest fixed-cost day this month, to label the step it makes. */
  fixedStep: { day: number; amountPaise: number; label: string } | null;
  totalPaise: number;
  flexiblePaise: number;
  /** Last month's flexible spend by the same day of the month; null without history. */
  previousFlexiblePaise: number | null;
};

export type CategoryBar = {
  key: string;
  categoryId: string | null;
  label: string;
  spentPaise: number;
  budgetPaise: number | null;
  fixed: boolean;
  /** 0..1 of the bar's track: of its budget, or of the largest unbudgeted spend shown. */
  fill: number;
  over: boolean;
};

/** Comparison copy for the flexible-spend sentence above the pace chart. */
export function flexibleSpendSummary({ currentPaise, previousPaise, hasFixed, previousName, day }: {
  currentPaise: number; previousPaise: number | null; hasFixed: boolean; previousName: string; day: number;
}): string {
  const label = hasFixed ? ' flexible' : '';
  if (previousPaise === null) return money(currentPaise) + label + ' spent so far. No ' + previousName + ' history to compare.';
  const difference = currentPaise - previousPaise;
  const comparison = difference > 0 ? money(difference) + ' more than ' + previousName
    : difference < 0 ? money(-difference) + ' less than ' + previousName
      : 'the same amount as ' + previousName;
  return money(currentPaise) + label + ' so far, ' + comparison + ' by day ' + day + '.';
}
/** Signed paise a row adds to spending, matching getMonthlySummary; 0 for rows that don't count. */
export function spendingPaise(row: PaceRow): number {
  if (row.status !== 'posted' || row.excludeFromStats) return 0;
  if (row.direction === 'debit' && row.kind === 'expense') return row.amountPaise;
  if (row.direction === 'credit' && (row.kind === 'refund' || row.kind === 'reversal')) return -row.amountPaise;
  return 0;
}

export function daysInMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

export function shiftMonth(month: string, delta: number): string {
  const [year, value] = month.split('-').map(Number);
  const total = year! * 12 + value! - 1 + delta;
  const shiftedYear = Math.floor(total / 12);
  return `${String(shiftedYear).padStart(4, '0')}-${String(total - shiftedYear * 12 + 1).padStart(2, '0')}`;
}

function cumulative(rows: PaceRow[], month: string, days: number, include: (row: PaceRow) => boolean) {
  const daily = new Array<number>(days).fill(0);
  for (const row of rows) {
    const date = indiaDate(row.occurredAt);
    if (!date.startsWith(month) || !include(row)) continue;
    daily[Number(date.slice(8)) - 1]! += spendingPaise(row);
  }
  let running = 0;
  return daily.map((value) => (running += value));
}

export function buildMonthPace({ month, today, rows, previousRows, categories }: {
  month: string; today: string; rows: PaceRow[]; previousRows: PaceRow[]; categories: PaceCategory[];
}): MonthPace {
  const days = daysInMonth(month);
  const thisMonth = today.slice(0, 7);
  const elapsed = month === thisMonth ? Number(today.slice(8)) : month < thisMonth ? days : 0;
  const fixedIds = new Set(categories.filter((category) => category.isFixed).map((category) => category.id));
  const isFixed = (row: PaceRow) => row.categoryId !== null && fixedIds.has(row.categoryId);
  const previousMonth = shiftMonth(month, -1);
  const previousDays = daysInMonth(previousMonth);

  const current = cumulative(rows, month, days, () => true).slice(0, elapsed);
  const flexible = cumulative(rows, month, days, (row) => !isFixed(row)).slice(0, elapsed);
  const previous = cumulative(previousRows, previousMonth, previousDays, () => true);
  const previousFlexible = cumulative(previousRows, previousMonth, previousDays, (row) => !isFixed(row));
  const hasHistory = previousRows.some((row) => spendingPaise(row) !== 0 && indiaDate(row.occurredAt).startsWith(previousMonth));

  let fixedStep: MonthPace['fixedStep'] = null;
  for (const row of rows) {
    const date = indiaDate(row.occurredAt);
    if (!isFixed(row) || !date.startsWith(month) || Number(date.slice(8)) > elapsed) continue;
    const amountPaise = spendingPaise(row);
    if (amountPaise > (fixedStep?.amountPaise ?? 0)) {
      const name = categories.find((category) => category.id === row.categoryId)?.name ?? 'Fixed';
      fixedStep = { day: Number(date.slice(8)), amountPaise, label: name };
    }
  }

  // Same day of the month; a 31st compares against the last day of a shorter month.
  const sameDay = Math.min(elapsed, previousDays);
  return {
    days, elapsed, current, previous, fixedStep,
    totalPaise: current.at(-1) ?? 0,
    flexiblePaise: flexible.at(-1) ?? 0,
    previousFlexiblePaise: hasHistory && sameDay > 0 ? previousFlexible[sameDay - 1]! : null,
  };
}

/** The `count` biggest spending categories as budget bars, the rest folded into "Other". */
export function topCategoryBars({ spending, budgets, categories, count = 3 }: {
  spending: CategorySpend[]; budgets: PaceBudget[]; categories: PaceCategory[]; count?: number;
}): CategoryBar[] {
  const budgetOf = (id: string | null) => budgets.find((budget) => budget.categoryId === id)?.amountPaise ?? null;
  const ranked = spending.filter((item) => item.expensePaise > 0).sort((left, right) => right.expensePaise - left.expensePaise);
  const shown = ranked.length > count ? ranked.slice(0, count) : ranked;
  const rest = ranked.slice(shown.length);
  const bars = shown.map((item) => ({
    key: item.categoryId ?? 'uncategorized',
    categoryId: item.categoryId,
    label: item.categoryName ?? 'Uncategorized',
    spentPaise: item.expensePaise,
    budgetPaise: budgetOf(item.categoryId),
    fixed: categories.find((category) => category.id === item.categoryId)?.isFixed ?? false,
  }));
  if (rest.length) {
    const budgeted = rest.map((item) => budgetOf(item.categoryId));
    bars.push({
      key: '__other', categoryId: null, label: `Other · ${rest.length}`,
      spentPaise: rest.reduce((sum, item) => sum + item.expensePaise, 0),
      // Only a budget that covers every folded category is comparable.
      budgetPaise: budgeted.every((value) => value !== null) ? budgeted.reduce((sum, value) => sum! + value!, 0) : null,
      fixed: false,
    });
  }
  const largestUnbudgeted = Math.max(1, ...bars.filter((bar) => bar.budgetPaise === null).map((bar) => bar.spentPaise));
  return bars.map((bar) => ({
    ...bar,
    fill: Math.min(1, bar.spentPaise / (bar.budgetPaise ?? largestUnbudgeted)),
    over: bar.budgetPaise !== null && bar.spentPaise > bar.budgetPaise,
  }));
}
