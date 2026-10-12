import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Ledger } from './ledger';
import { accounts, categories, transactions } from './schema';

const indiaOffsetMs = 5.5 * 60 * 60 * 1000;

type TransactionDirection = typeof transactions.$inferSelect.direction;
type TransactionFilters = {
  month?: string;
  categoryId?: string;
  accountId?: string;
  direction?: TransactionDirection;
};

function monthRange(month: string): { start: Date; end: Date } {
  if (typeof month !== 'string') throw new TypeError('month must be YYYY-MM');
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match || Number(match[1]) === 0) throw new TypeError('month must be YYYY-MM');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const utcMonth = (yearValue: number, monthValue: number) => {
    const date = new Date(0);
    date.setUTCFullYear(yearValue, monthValue, 1);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime() - indiaOffsetMs;
  };
  return {
    start: new Date(utcMonth(year, monthIndex)),
    end: new Date(utcMonth(year, monthIndex + 1)),
  };
}

function checkedPaise(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('monthly total exceeds safe integer paise');
  }
  return Number(value);
}

export function createLedgerQueries(db: Ledger['db']) {
  const projection = {
    id: transactions.id,
    amountPaise: transactions.amountPaise,
    direction: transactions.direction,
    kind: transactions.kind,
    status: transactions.status,
    accountId: transactions.accountId,
    accountName: sql<string | null>`${accounts.name}`.as('account_name'),
    counterparty: transactions.counterparty,
    merchantId: transactions.merchantId,
    categoryId: transactions.categoryId,
    categoryName: sql<string | null>`${categories.name}`.as('category_name'),
    occurredAt: transactions.occurredAt,
    note: transactions.note,
    source: transactions.source,
    userEdited: transactions.userEdited,
    excludeFromStats: transactions.excludeFromStats,
  };

  function conditions(filters: TransactionFilters = {}) {
    const where = [isNull(transactions.deletedAt)];
    if (filters.month !== undefined) {
      const { start, end } = monthRange(filters.month);
      where.push(gte(transactions.occurredAt, start), lt(transactions.occurredAt, end));
    }
    if (filters.categoryId !== undefined) where.push(eq(transactions.categoryId, filters.categoryId));
    if (filters.accountId !== undefined) where.push(eq(transactions.accountId, filters.accountId));
    if (filters.direction !== undefined) where.push(eq(transactions.direction, filters.direction));
    return and(...where);
  }

  function joinedSelect() {
    return db.select(projection)
      .from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id));
  }

  return {
    async getTransaction(id: string) {
      return joinedSelect().where(and(eq(transactions.id, id), isNull(transactions.deletedAt))).get();
    },

    async listTransactions(filters: TransactionFilters = {}) {
      return joinedSelect()
        .where(conditions(filters))
        .orderBy(desc(transactions.occurredAt), desc(transactions.id))
        .all();
    },

    async getMonthlySummary(month: string) {
      const rows = await db.select({
        amountPaise: transactions.amountPaise,
        direction: transactions.direction,
        kind: transactions.kind,
        status: transactions.status,
        categoryId: transactions.categoryId,
        categoryName: projection.categoryName,
        excludeFromStats: transactions.excludeFromStats,
      }).from(transactions)
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(conditions({ month })).all();
      let expenses = 0n;
      let income = 0n;
      const byCategory = new Map<string | null, {
        categoryId: string | null;
        categoryName: string | null;
        expense: bigint;
        income: bigint;
      }>();

      for (const row of rows) {
        if (row.status !== 'posted' || row.excludeFromStats) continue;
        const amount = BigInt(row.amountPaise);
        let expenseDelta = 0n;
        let incomeDelta = 0n;
        if (row.direction === 'debit' && row.kind === 'expense') expenseDelta = amount;
        else if (row.direction === 'credit' && (row.kind === 'refund' || row.kind === 'reversal')) expenseDelta = -amount;
        else if (row.direction === 'credit' && row.kind === 'income') incomeDelta = amount;
        else continue;

        expenses += expenseDelta;
        income += incomeDelta;
        const category = byCategory.get(row.categoryId) ?? {
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          expense: 0n,
          income: 0n,
        };
        category.expense += expenseDelta;
        category.income += incomeDelta;
        byCategory.set(row.categoryId, category);
      }

      const { start, end } = monthRange(month);
      return {
        month,
        start,
        end,
        expensePaise: checkedPaise(expenses),
        incomePaise: checkedPaise(income),
        netPaise: checkedPaise(income - expenses),
        categories: [...byCategory.values()]
          .sort((a, b) => {
            if (a.categoryId === null) return b.categoryId === null ? 0 : -1;
            if (b.categoryId === null) return 1;
            return a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0;
          })
          .map(({ categoryId, categoryName, expense, income: categoryIncome }) => ({
            categoryId,
            categoryName,
            expensePaise: checkedPaise(expense),
            incomePaise: checkedPaise(categoryIncome),
          })),
      };
    },
  };
}

export type { TransactionFilters };
