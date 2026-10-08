import type { DataLayer } from '../db/service';
import type { LedgerSQLiteClient, NewAccount, NewCategory, NewTransaction } from '../db/ledger';
import type { NewBill, NewBudget } from '../db/planning';
import { indiaDate, parseIndiaDate } from '../utils/display';

/**
 * Development fixture: the last three months plus the current month of a
 * fictional first-job IT fresher in Noida (₹32,000 take-home, PG in Sector 62).
 * Brands are real so screens look like the shipped app; the person, employer,
 * account digits and UPI references are invented. Normal startup never calls this.
 */

const PREFIX = 'demo-v2-';
const MINUTE = 60_000;
const DAY = 86_400_000;
const TABLES = ['transactions', 'bills', 'budgets', 'categories', 'accounts'] as const;

type Txn = Omit<NewTransaction, 'source'>;
export type DemoPlan = {
  accounts: NewAccount[];
  categories: NewCategory[];
  budgets: NewBudget[];
  bills: (NewBill & { paid?: boolean })[];
  transactions: Txn[];
};

export class LedgerNotEmptyError extends Error {
  constructor() { super('Test data only loads into an empty ledger. Remove existing entries and old test data first.'); }
}

const id = (name: string) => `${PREFIX}${name}`;
const acct = { sbi: id('sbi'), kotak: id('kotak'), card: id('card'), lite: id('upi-lite'), cash: id('cash') } as const;
const expenseNames = ['Food', 'Rent', 'Groceries', 'Shopping', 'Travel', 'Bills', 'Health', 'Fun'] as const;
const incomeNames = ['Salary', 'Freelance', 'Interest', 'Cashback'] as const;
type CategoryKey = Lowercase<typeof expenseNames[number] | typeof incomeNames[number]>;

/** Monthly limits in rupees. Total ₹26,700 of ₹32,000 take-home. */
const limits: Partial<Record<CategoryKey, number>> = {
  rent: 9_500, food: 7_000, groceries: 2_500, shopping: 2_500, travel: 2_000, bills: 1_500, health: 800, fun: 1_000,
};
/** The second month plans ahead for a train trip home. */
const TRIP_TRAVEL_LIMIT = 4_500;

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const at = (date: string, hour: number, minute = 0) => new Date(parseIndiaDate(date).getTime() + (hour * 60 + minute) * MINUTE);
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const shiftMonth = (month: string, delta: number) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};

/** Pure: the same `now` always yields the same plan. Earlier months don't depend on today's date. */
export function buildDemoPlan(now: Date): DemoPlan {
  const today = indiaDate(now);
  const current = today.slice(0, 7);
  const months = [-3, -2, -1, 0].map((delta) => shiftMonth(current, delta));
  const transactions: Txn[] = [];
  const plan: DemoPlan = {
    accounts: [
      { id: acct.sbi, name: 'SBI Salary', type: 'bank', institution: 'State Bank of India', last4: '4821' },
      { id: acct.kotak, name: 'Kotak 811 Savings', type: 'bank', institution: 'Kotak Mahindra Bank', last4: '3307' },
      { id: acct.card, name: 'SBI SimplyCLICK', type: 'credit_card', institution: 'SBI Card', last4: '7730' },
      { id: acct.lite, name: 'Paytm UPI Lite', type: 'upi_lite', institution: 'Paytm' },
      { id: acct.cash, name: 'Cash', type: 'cash' },
    ],
    categories: [
      ...expenseNames.map((name, sortOrder) => ({ id: id(name.toLowerCase()), name, kind: 'expense' as const, sortOrder })),
      ...incomeNames.map((name, sortOrder) => ({ id: id(name.toLowerCase()), name, kind: 'income' as const, sortOrder })),
    ],
    budgets: months.flatMap((month, index) => Object.entries(limits).map(([key, rupees]) => ({
      id: id(`budget-${key}-${month}`), categoryId: id(key), month,
      amountPaise: (key === 'travel' && index === 1 ? TRIP_TRAVEL_LIMIT : rupees) * 100,
    }))),
    bills: [],
    transactions,
  };

  let serial = 0;
  let rng = mulberry32(1);
  const between = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
  const chance = (p: number) => rng() < p;
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rng() * items.length)]!;
  const upiRef = () => `${between(100_000, 999_999)}${between(100_000, 999_999)}`;
  const add = (when: Date, rupees: number, fields: Partial<Txn> & Pick<Txn, 'counterparty'>) => {
    if (when.getTime() > now.getTime()) return undefined;
    const txn: Txn = {
      id: id(`t${String(++serial).padStart(4, '0')}`), amountPaise: Math.round(rupees * 100),
      direction: 'debit', kind: 'expense', status: 'posted', accountId: acct.sbi, categoryId: null,
      occurredAt: when, createdAt: when, ...fields,
    };
    transactions.push(txn);
    return txn;
  };
  const spend = (when: Date, rupees: number, category: CategoryKey, counterparty: string, account: string, extra: Partial<Txn> = {}) =>
    add(when, rupees, { categoryId: id(category), counterparty, accountId: account, upiRef: account === acct.sbi ? upiRef() : null, ...extra });
  const income = (when: Date, rupees: number, category: CategoryKey, counterparty: string, account: string = acct.sbi, note: string | null = null) =>
    add(when, rupees, { direction: 'credit', kind: 'income', categoryId: id(category), counterparty, accountId: account, note });
  /** Both legs of a move between own accounts; neither counts as spending or income. */
  const transfer = (when: Date, rupees: number, from: string, to: string, label: string) => {
    if (!add(when, rupees, { kind: 'transfer', accountId: from, counterparty: label, upiRef: upiRef() })) return;
    add(new Date(when.getTime() + MINUTE), rupees, { kind: 'transfer', direction: 'credit', accountId: to, counterparty: label });
  };

  // Each month's card bill pays the previous month's card spend; the first pays an opening statement.
  const statements: number[] = [2_846];
  let jioDue = at(`${months[0]}-05`, 11).getTime();

  months.forEach((month, index) => {
    rng = mulberry32(Number(month.replace('-', '')));
    const isCurrent = month === current;
    const lastDay = isCurrent ? Number(today.slice(8)) : daysIn(month);
    const date = (day: number) => `${month}-${pad(Math.min(day, daysIn(month)))}`;
    const monthStart = transactions.length;

    income(at(date(1), 9, 12), 32_000, 'salary', 'Brightlane Technologies Pvt Ltd', acct.sbi, 'Salary credit');
    spend(at(date(2), 10, 15), 9_500, 'rent', 'Shree Balaji PG, Sector 62', acct.sbi, { note: 'PG rent with meals, twin sharing' });
    transfer(at(date(3), 20, 40), 3_000, acct.sbi, acct.kotak, 'Monthly savings to Kotak 811');
    transfer(at(date(4), 8, 55), 1_000, acct.sbi, acct.lite, 'UPI Lite top-up');
    add(at(date(6), 19, 5), 2_000, { kind: 'cash_withdrawal', counterparty: 'SBI ATM, Sector 62' });
    transfer(at(date(12), 21, 10), statements.at(-1)!, acct.sbi, acct.card, 'SBI Card bill payment');
    spend(at(date(14), 6, 2), 139, 'bills', 'Spotify', acct.card, { note: 'Premium Individual' });
    transfer(at(date(18), 9, 20), 1_000, acct.sbi, acct.lite, 'UPI Lite top-up');
    spend(at(date(21), 6, 4), 149, 'bills', 'Netflix', acct.card, { note: 'Mobile plan' });
    spend(at(date(25), 20, 30), 250, 'bills', 'Dhobi, Sector 62', acct.cash, { note: 'Monthly ironing' });
    const monthEnd = at(date(daysIn(month)), 23, 59).getTime();
    for (; jioDue <= Math.min(monthEnd, now.getTime()); jioDue += 28 * DAY) {
      spend(new Date(jioDue), 349, 'bills', 'Jio', acct.sbi, { note: '2 GB/day, 28 days' });
    }

    for (let day = 1; day <= lastDay; day++) {
      const d = date(day);
      if (d === today) break;
      const dow = weekday(d);
      if (dow >= 1 && dow <= 5) {
        if (chance(0.6)) spend(at(d, 13, between(5, 40)), between(7, 11) * 10, 'food', 'Office cafeteria', acct.lite);
        if (chance(0.35)) spend(at(d, 17, between(0, 50)), pick([15, 20, 20, 25]), 'food', 'Chai stall', acct.cash);
        if (chance(0.22)) spend(at(d, pick([8, 9]), between(5, 50)), between(45, 95), 'travel', pick(['Rapido', 'Rapido', 'Uber Auto']), acct.sbi);
      } else {
        const orders = chance(0.3) ? 2 : 1;
        for (let n = 0; n < orders; n++) {
          spend(at(d, n ? 21 : 13, between(0, 45)), between(179, 429), 'food', pick(['Swiggy', 'Zomato', 'Swiggy']), chance(0.5) ? acct.card : acct.sbi);
        }
        if (chance(0.3)) {
          const fare = pick([50, 54, 60, 64]);
          spend(at(d, 15, 10), fare, 'travel', 'Delhi Metro (DMRC)', acct.sbi);
          spend(at(d, 18, between(0, 50)), between(380, 820), 'food', pick(["Haldiram's, Sector 18", 'Wenger’s, Connaught Place', 'Big Chill, Khan Market']), acct.sbi);
          spend(at(d, 21, 35), fare, 'travel', 'Delhi Metro (DMRC)', acct.sbi);
        }
      }
      if (dow === 3 || (dow === 6 && chance(0.4))) {
        spend(at(d, 19, between(10, 50)), between(168, 524), 'groceries', pick(['Blinkit', 'Zepto', 'Blinkit']), acct.sbi,
          { note: pick(['Snacks and toiletries', 'Fruit, milk, Maggi', 'Detergent and soap']) });
      }
    }

    spend(at(date(9), 20, 15), between(160, 420), 'health', 'Apollo Pharmacy', acct.sbi);
    spend(at(date(16), 11, 30), 150, 'health', 'Haircut, Sector 62', acct.cash);
    spend(at(date(19), 18, 45), between(280, 420), 'fun', 'PVR INOX, Logix Mall', acct.card, { note: 'Movie and popcorn' });
    if (chance(0.7)) income(at(date(22), 12, 3), between(5, 35), 'cashback', 'Google Pay rewards');

    if (index === 0) {
      spend(at(date(13), 18, 20), 1_999, 'shopping', 'Decathlon, Noida', acct.card, { note: 'Running shoes' });
      spend(at(date(27), 22, 10), 299, 'shopping', 'Amazon', acct.card, { note: 'Phone cover' });
      if (spend(at(date(20), 21, 2), 348, 'food', 'Zomato', acct.sbi, { status: 'failed', note: 'UPI timed out' })) {
        spend(at(date(20), 21, 4), 348, 'food', 'Zomato', acct.sbi, { note: 'Retried after the failed payment' });
      }
    }
    if (index === 1) {
      spend(at(date(10), 23, 15), 2_370, 'travel', 'IRCTC', acct.card, { note: 'Train home, 3A both ways' });
      income(at(date(19), 16, 40), 6_000, 'freelance', 'Pixelnest Studio', acct.sbi, 'Landing page for a café');
      transfer(at(date(20), 9, 0), 5_000, acct.sbi, acct.kotak, 'Freelance money to savings');
      spend(at(date(24), 13, 0), 1_099, 'shopping', 'Amazon', acct.card, { note: 'Gift for sister' });
      spend(at(date(27), 17, 35), 486, 'travel', 'Uber', acct.sbi, { note: 'PG to New Delhi station' });
      spend(at(date(31), 7, 10), 431, 'travel', 'Uber', acct.sbi, { note: 'Station back to PG' });
      if (spend(at(date(15), 20, 31), 412, 'food', 'Swiggy', acct.sbi, { status: 'failed', note: 'Bank server down' })) {
        spend(at(date(15), 20, 33), 412, 'food', 'Swiggy', acct.card, { note: 'Paid by card instead' });
      }
    }
    if (index === 2) {
      // A festive sale week pushes Shopping well past its limit; one return comes back as a refund.
      spend(at(date(10), 10, 45), 640, 'travel', 'Uber', acct.sbi, { excludeFromStats: true, note: 'Client visit, Gurugram. Office reimburses.' });
      spend(at(date(23), 0, 12), 1_499, 'shopping', 'Flipkart', acct.card, { note: 'boAt earbuds, sale price' });
      const kurta = spend(at(date(23), 0, 40), 1_299, 'shopping', 'Myntra', acct.card, { note: 'Kurta for the festive season' });
      spend(at(date(24), 19, 5), 1_799, 'shopping', 'Flipkart', acct.card, { note: 'Sneakers' });
      spend(at(date(26), 14, 20), 999, 'shopping', 'Amazon', acct.card, { note: 'Laptop backpack' });
      spend(at(date(27), 22, 0), 1_099, 'shopping', 'Amazon', acct.card, { note: 'Power bank' });
      if (kurta) add(at(date(29), 15, 30), 1_299, { kind: 'refund', direction: 'credit', categoryId: id('shopping'), counterparty: 'Myntra', accountId: acct.card, linkedTxnId: kurta.id, note: 'Returned, size too small' });
      income(at(date(30), 23, 50), 58, 'interest', 'SBI savings interest');
      income(at(date(30), 23, 55), 37, 'interest', 'Kotak 811 interest', acct.kotak);
    }
    if (isCurrent && lastDay > 2) {
      spend(at(date(lastDay - 2), 23, 5), 1_299, 'shopping', 'Amazon', acct.card, { status: 'pending', note: 'Order placed, payment pending' });
    }

    statements.push(transactions.slice(monthStart).reduce((sum, t) => t.accountId !== acct.card || t.status !== 'posted' || t.kind === 'transfer' ? sum
      : sum + (t.direction === 'debit' ? t.amountPaise : -t.amountPaise) / 100, 0));
  });

  // Three entries from earlier today fill Home's fanned cards.
  const dayStart = parseIndiaDate(today).getTime();
  const earlierToday = (minutes: number) => new Date(Math.max(dayStart, now.getTime() - minutes * MINUTE));
  spend(earlierToday(150), 20, 'food', 'Chai stall', acct.cash);
  spend(earlierToday(55), 68, 'travel', 'Rapido', acct.sbi);
  spend(earlierToday(8), 236, 'groceries', 'Blinkit', acct.sbi, { note: 'Milk, bread, eggs' });

  const due = (offset: number) => indiaDate(new Date(dayStart + offset * DAY));
  // Before the 12th the bill for last month is still open; after it, this month's spend so far is next.
  const cardPaid = Number(today.slice(8)) >= 12;
  plan.bills = [
    {
      id: id('bill-card'), label: 'SBI Card bill', amountPaise: Math.round(statements.at(cardPaid ? -1 : -2)! * 100),
      dueDate: `${cardPaid ? shiftMonth(current, 1) : current}-12`,
    },
    { id: id('bill-rent'), label: 'PG rent', amountPaise: 950_000, dueDate: `${shiftMonth(current, 1)}-02` },
    { id: id('bill-jio'), label: 'Jio recharge', amountPaise: 34_900, dueDate: indiaDate(new Date(jioDue)) },
    { id: id('bill-netflix'), label: 'Netflix', amountPaise: 14_900, dueDate: due(13) },
    { id: id('bill-electricity'), label: 'PG electricity share', amountPaise: 64_000, dueDate: due(-3) },
    { id: id('bill-spotify'), label: 'Spotify', amountPaise: 13_900, dueDate: due(-1), paid: true },
  ];
  return plan;
}

/** `demo-v<n>-…` ids in `column`; GLOB keeps `_` and `%` literal. */
const demoIds = (column: string, version = '[0-9]*') => `${column} GLOB 'demo-v${version}-*'`;

/**
 * Loads the fixture atomically into an empty ledger. Returns false when it is
 * already loaded (including edited or deleted demo entries, which stay as they are).
 */
export async function seedDemoLedger(client: LedgerSQLiteClient, ledger: DataLayer, now: Date): Promise<boolean> {
  const plan = buildDemoPlan(now);
  let inserted = false;
  await client.withTransactionAsync(async () => {
    if (await client.getFirstAsync(`SELECT 1 FROM accounts WHERE ${demoIds('id', '2')}`)) return;
    for (const table of TABLES) {
      // Real entries or an older fixture would mix with fake data and duplicate category names.
      if (await client.getFirstAsync(`SELECT 1 FROM ${table} WHERE NOT ${demoIds('id', '2')} LIMIT 1`)) throw new LedgerNotEmptyError();
    }
    for (const account of plan.accounts) await ledger.createAccount(account);
    for (const category of plan.categories) await ledger.createCategory(category);
    for (const budget of plan.budgets) await ledger.setBudget(budget);
    for (const { paid, ...bill } of plan.bills) {
      await ledger.createBill(bill);
      if (paid) await ledger.setBillPaid(bill.id, true);
    }
    for (const txn of plan.transactions) await ledger.createTransaction({ ...txn, source: 'manual' });
    inserted = true;
  });
  return inserted;
}

/** Hard-deletes every demo record of any fixture version, and nothing else. Returns how many rows went. */
export async function removeDemoLedger(client: LedgerSQLiteClient): Promise<number> {
  let removed = 0;
  await client.withTransactionAsync(async () => {
    for (const table of TABLES) {
      const row = await client.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${demoIds('id')}`);
      removed += Number(row?.n ?? 0);
    }
    // Detach real rows that point at demo rows, then delete children before parents.
    await client.execAsync(`
      UPDATE transactions SET category_id = NULL WHERE ${demoIds('category_id')} AND NOT ${demoIds('id')};
      UPDATE transactions SET account_id = NULL WHERE ${demoIds('account_id')} AND NOT ${demoIds('id')};
      UPDATE transactions SET linked_txn_id = NULL WHERE ${demoIds('linked_txn_id')} AND NOT ${demoIds('id')};
      UPDATE categories SET parent_id = NULL WHERE ${demoIds('parent_id')} AND NOT ${demoIds('id')};
      DELETE FROM transactions WHERE ${demoIds('id')};
      DELETE FROM bills WHERE ${demoIds('id')};
      DELETE FROM budgets WHERE ${demoIds('id')} OR ${demoIds('category_id')};
      DELETE FROM categories WHERE ${demoIds('id')};
      DELETE FROM accounts WHERE ${demoIds('id')};
    `);
  });
  return removed;
}
