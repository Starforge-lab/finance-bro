import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateFinancePlan, type ForecastInput, type PlannedObligation } from '../src/db/finance-plan';

const now = new Date('2026-10-18T08:00:00Z');
function input(patch: Partial<ForecastInput> = {}): ForecastInput {
  return {
    now,
    setup: { salaryDay: 25, salaryAmountPaise: 500_000, reservePaise: 10_000 },
    balances: [{ accountId: 'bank', name: 'Bank', type: 'bank', lastVerifiedAt: now, calculatedPaise: 100_000 }],
    obligations: [], unassignedCount: 0, pendingReviewCount: 0, ...patch,
  };
}
function bill(patch: Partial<PlannedObligation> = {}): PlannedObligation {
  return { id: 'bill', label: 'Bill', amountPaise: 1_000, dueDate: '2026-10-20', paid: false, kind: 'bill', ...patch };
}

test('reserves full outstanding and bills without adding salary or double-counting card payments', () => {
  const base = input();
  const result = calculateFinancePlan(input({
    balances: [...base.balances,
      { ...base.balances[0], accountId: 'card', type: 'credit_card', calculatedPaise: 30_000 },
      { ...base.balances[0], accountId: 'overpaid', type: 'credit_card', calculatedPaise: -5_000 }],
    obligations: [bill({ id: 'card-due', kind: 'card_payment', amountPaise: 20_000 }),
      bill({ id: 'old', dueDate: '2026-10-01' }), bill({ id: 'paid', paid: true }),
      bill({ id: 'salary-day', dueDate: '2026-10-25' }), bill({ id: 'later', dueDate: '2026-11-01' })],
  }));
  assert.equal(result.status, 'ready');
  assert.equal(result.liquidPaise, 100_000);
  assert.equal(result.cardOutstandingPaise, 30_000);
  assert.equal(result.billsReservedPaise, 2_000);
  assert.equal(result.safeToSpendPaise, 58_000);
  assert.equal(result.daysUntilSalary, 7);
  assert.equal(result.dailyAllowancePaise, 8_285);
  assert.deepEqual(result.upcoming.map((item) => item.id), ['old', 'card-due', 'salary-day', 'later']);
});

test('salary horizon clamps to month end, handles leap years and uses the India calendar', () => {
  const setup = { salaryDay: 31, salaryAmountPaise: 1, reservePaise: 0 };
  const balances = [{ ...input().balances[0], lastVerifiedAt: new Date('2026-01-01T00:00:00Z') }];
  assert.equal(calculateFinancePlan(input({ now: new Date('2028-02-01T00:00:00Z'), setup, balances })).nextSalaryDate, '2028-02-29');
  assert.equal(calculateFinancePlan(input({ now: new Date('2027-02-01T00:00:00Z'), setup, balances })).nextSalaryDate, '2027-02-28');
  assert.equal(calculateFinancePlan(input({ now: new Date('2028-02-29T00:00:00Z'), setup, balances })).daysUntilSalary, 0);
  assert.equal(calculateFinancePlan(input({ now: new Date('2026-12-26T00:00:00Z') })).nextSalaryDate, '2027-01-25');
  assert.equal(calculateFinancePlan(input({ now: new Date('2026-10-24T18:29:59Z') })).daysUntilSalary, 1);
  const today = calculateFinancePlan(input({ now: new Date('2026-10-24T18:30:00Z') }));
  assert.equal(today.nextSalaryDate, '2026-10-25');
  assert.equal(today.daysUntilSalary, 0);
  assert.equal(today.dailyAllowancePaise, null);
  assert.match(today.reason ?? '', /salary.*today/i);
  assert.equal(today.safeToSpendPaise, 90_000);
  const paydayBill = calculateFinancePlan(input({
    now: new Date('2026-10-24T18:30:00Z'),
    obligations: [bill({ dueDate: '2026-10-25' })],
  }));
  assert.equal(paydayBill.billsReservedPaise, 1_000);
  assert.equal(paydayBill.safeToSpendPaise, 89_000);
  assert.match(paydayBill.equation, /on or before salary/);
});

test('negative headroom remains a shortfall and daily allowance rounds down conservatively', () => {
  const result = calculateFinancePlan(input({ setup: { salaryDay: 25, salaryAmountPaise: 1, reservePaise: 100_001 } }));
  assert.equal(result.safeToSpendPaise, -1);
  assert.equal(result.dailyAllowancePaise, -1);
});

test('setup and complete dated account balances are required', () => {
  assert.equal(calculateFinancePlan(input({ setup: null })).status, 'needs-setup');
  for (const patch of [
    { balances: [] }, { balances: [{ ...input().balances[0], lastVerifiedAt: null }] },
    { balances: [{ ...input().balances[0], calculatedPaise: null }] },
    { unassignedCount: 1 }, { pendingReviewCount: 1 },
  ]) {
    const result = calculateFinancePlan(input(patch));
    assert.equal(result.status, 'incomplete');
    assert.equal(result.safeToSpendPaise, null);
    assert.ok(result.reason);
  }
});

test('card-payment reminders require a tracked credit-card liability', () => {
  const result = calculateFinancePlan(input({ obligations: [bill({ kind: 'card_payment' })] }));
  assert.equal(result.status, 'incomplete');
  assert.equal(result.safeToSpendPaise, null);
  assert.match(result.reason ?? '', /credit.card account/i);
});

test('rejects invalid runtime money, counts, account types and calendar dates', () => {
  const invalid: Partial<ForecastInput>[] = [
    { now: new Date('invalid') },
    { setup: { salaryDay: 0, salaryAmountPaise: 1, reservePaise: 0 } },
    { setup: { salaryDay: 32, salaryAmountPaise: 1, reservePaise: 0 } },
    { setup: { salaryDay: 1, salaryAmountPaise: 0, reservePaise: 0 } },
    { setup: { salaryDay: 1, salaryAmountPaise: 1, reservePaise: -1 } },
    { unassignedCount: -1 }, { pendingReviewCount: 0.5 },
    { balances: [{ ...input().balances[0], type: 'unknown' }] },
    { balances: [{ ...input().balances[0], calculatedPaise: Number.NaN }] },
    { balances: [{ ...input().balances[0], lastVerifiedAt: new Date('invalid') }] },
    { balances: [{ ...input().balances[0], lastVerifiedAt: new Date(now.getTime() + 1) }] },
    { obligations: [bill({ amountPaise: 0 })] },
    { obligations: [bill({ amountPaise: 1.5 })] },
    { obligations: [bill({ amountPaise: Number.MAX_SAFE_INTEGER + 1 })] },
    ...['2026-02-29', '2026-04-31', '2026-1-01', '2026-01-00', '0000-01-01'].map((dueDate) => ({ obligations: [bill({ dueDate })] })),
  ];
  for (const patch of invalid) assert.throws(() => calculateFinancePlan(input(patch)));
});

test('rejects unsafe aggregate totals and safe-to-spend overflow', () => {
  const balance = input().balances[0];
  assert.throws(() => calculateFinancePlan(input({ balances: [
    { ...balance, calculatedPaise: Number.MAX_SAFE_INTEGER }, { ...balance, accountId: 'other', calculatedPaise: 1 },
  ] })), /safe|overflow/i);
  assert.throws(() => calculateFinancePlan(input({ balances: [
    { ...balance, calculatedPaise: -Number.MAX_SAFE_INTEGER },
  ] })), /safe|overflow/i);
  assert.throws(() => calculateFinancePlan(input({ balances: [
    { ...balance, type: 'credit_card', calculatedPaise: Number.MAX_SAFE_INTEGER },
    { ...balance, accountId: 'other', type: 'credit_card', calculatedPaise: 1 },
  ] })), /safe|overflow/i);
  assert.throws(() => calculateFinancePlan(input({ obligations: [
    bill({ amountPaise: Number.MAX_SAFE_INTEGER }), bill({ id: 'other' }),
  ] })), /safe|overflow/i);
});

test('orders unpaid obligations by date then ID without mutating caller order', () => {
  const obligations = [bill({ id: 'z' }), bill({ id: 'a' }), bill({ id: 'paid', paid: true })];
  const result = calculateFinancePlan(input({ obligations }));
  assert.deepEqual(result.upcoming.map((item) => item.id), ['a', 'z']);
  assert.deepEqual(obligations.map((item) => item.id), ['z', 'a', 'paid']);
});
