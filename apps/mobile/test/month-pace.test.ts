import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildMonthPace, flexibleSpendSummary, spendingPaise, topCategoryBars, type PaceRow } from '../src/utils/month-pace';

const at = (date: string, hour = 12) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+05:30`);
const spend = (date: string, rupees: number, categoryId: string | null = 'food', extra: Partial<PaceRow> = {}): PaceRow => ({
  amountPaise: rupees * 100, direction: 'debit', kind: 'expense', status: 'posted', excludeFromStats: false,
  occurredAt: at(date), categoryId, ...extra,
});
const categories = [
  { id: 'rent', name: 'Rent', isFixed: true },
  { id: 'food', name: 'Food', isFixed: false },
  { id: 'travel', name: 'Travel', isFixed: false },
];

it('counts rows exactly like the monthly summary', () => {
  assert.equal(spendingPaise(spend('2026-10-01', 100)), 10_000);
  assert.equal(spendingPaise(spend('2026-10-01', 100, 'food', { kind: 'refund', direction: 'credit' })), -10_000);
  for (const extra of [{ status: 'failed' }, { status: 'pending' }, { excludeFromStats: true }, { kind: 'transfer' },
    { kind: 'cash_withdrawal' }, { kind: 'income', direction: 'credit' as const }]) {
    assert.equal(spendingPaise(spend('2026-10-01', 100, 'food', extra)), 0, JSON.stringify(extra));
  }
});

it('builds running totals to today and compares flexible spend with the same day last month', () => {
  const pace = buildMonthPace({
    month: '2026-10', today: '2026-10-04', categories,
    rows: [spend('2026-10-02', 9_500, 'rent'), spend('2026-10-01', 110), spend('2026-10-03', 400),
      spend('2026-10-03', 50, 'travel', { status: 'failed' })],
    previousRows: [spend('2026-09-02', 9_500, 'rent'), spend('2026-09-01', 70), spend('2026-09-04', 300), spend('2026-09-20', 5_000)],
  });
  assert.equal(pace.days, 31);
  assert.equal(pace.elapsed, 4);
  assert.deepEqual(pace.current, [11_000, 961_000, 1_001_000, 1_001_000]);
  assert.equal(pace.previous.length, 30);
  assert.equal(pace.previous.at(-1), 1_487_000);
  assert.equal(pace.totalPaise, 1_001_000);
  assert.equal(pace.flexiblePaise, 51_000);
  assert.equal(pace.previousFlexiblePaise, 37_000);
  assert.deepEqual(pace.fixedStep, { day: 2, amountPaise: 950_000, label: 'Rent' });
});

it('describes more, less, equal, and missing-baseline comparisons clearly', () => {
  const details = { hasFixed: true, previousName: 'September', day: 8 };
  assert.equal(flexibleSpendSummary({ ...details, currentPaise: 9_075, previousPaise: 7_050 }), '₹90.75 flexible so far, ₹20.25 more than September by day 8.');
  assert.equal(flexibleSpendSummary({ ...details, currentPaise: 5_005, previousPaise: 7_075 }), '₹50.05 flexible so far, ₹20.70 less than September by day 8.');
  assert.equal(flexibleSpendSummary({ ...details, currentPaise: 7_075, previousPaise: 7_075 }), '₹70.75 flexible so far, the same amount as September by day 8.');
  assert.equal(flexibleSpendSummary({ ...details, currentPaise: 5_050, previousPaise: null }), '₹50.50 flexible spent so far. No September history to compare.');
});
it('uses India dates, so a late-night UTC entry lands on the right day', () => {
  const pace = buildMonthPace({
    month: '2026-10', today: '2026-10-02', categories, previousRows: [],
    rows: [{ ...spend('2026-10-01', 100), occurredAt: new Date('2026-10-01T19:00:00Z') }],
  });
  assert.deepEqual(pace.current, [0, 10_000]);
  assert.equal(pace.previousFlexiblePaise, null);
});

it('covers a whole past month, nothing for a future one, and clamps day 31 to a shorter last month', () => {
  const rows = [spend('2026-08-31', 200)];
  const past = buildMonthPace({ month: '2026-08', today: '2026-10-08', categories, rows, previousRows: [spend('2026-07-31', 50)] });
  assert.equal(past.elapsed, 31);
  assert.equal(past.current.length, 31);
  const future = buildMonthPace({ month: '2026-11', today: '2026-10-08', categories, rows: [], previousRows: [] });
  assert.equal(future.elapsed, 0);
  assert.equal(future.totalPaise, 0);
  const october = buildMonthPace({ month: '2026-10', today: '2026-10-31', categories, rows: [], previousRows: [spend('2026-09-30', 70)] });
  assert.equal(october.previousFlexiblePaise, 7_000);
});

it('shows the top three categories against their budgets and folds the rest into Other', () => {
  const bars = topCategoryBars({
    categories,
    budgets: [{ categoryId: 'rent', amountPaise: 950_000 }, { categoryId: 'food', amountPaise: 700_000 },
      { categoryId: 'travel', amountPaise: 200_000 }, { categoryId: 'fun', amountPaise: 100_000 }],
    spending: [
      { categoryId: 'food', categoryName: 'Food', expensePaise: 84_100 },
      { categoryId: 'rent', categoryName: 'Rent', expensePaise: 950_000 },
      { categoryId: 'travel', categoryName: 'Travel', expensePaise: 250_000 },
      { categoryId: 'fun', categoryName: 'Fun', expensePaise: 30_000 },
      { categoryId: 'gifts', categoryName: 'Gifts', expensePaise: 20_000 },
      { categoryId: 'empty', categoryName: 'Empty', expensePaise: 0 },
    ],
  });
  assert.deepEqual(bars.map((bar) => bar.label), ['Rent', 'Travel', 'Food', 'Other · 2']);
  assert.deepEqual(bars.map((bar) => bar.over), [false, true, false, false]);
  assert.equal(bars[0]!.fixed, true);
  assert.equal(bars[1]!.fill, 1);
  assert.equal(bars[2]!.fill, 84_100 / 700_000);
  // Gifts has no budget, so Other can't be judged against one.
  assert.equal(bars[3]!.budgetPaise, null);
  assert.equal(bars[3]!.fill, 1);
});

it('shows the top three categories and folds the fourth into informational Other', () => {
  const spending = ['a', 'b', 'c', 'd'].map((id, index) => ({ categoryId: id, categoryName: id, expensePaise: (4 - index) * 100 }));
  const bars = topCategoryBars({ spending, budgets: [], categories: [] });
  assert.deepEqual(bars.map((bar) => bar.label), ['a', 'b', 'c', 'Other · 1']);
  assert.deepEqual(bars.map((bar) => bar.fill), [1, 0.75, 0.5, 0.25]);
  assert.equal(bars[3]!.spentPaise, 100);
  assert.equal(bars[3]!.categoryId, null);
});
