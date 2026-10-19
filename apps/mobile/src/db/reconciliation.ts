import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { createLedger, type LedgerMigrations, type LedgerSQLiteClient, type LedgerSQLiteTransactionRunner } from './ledger';
import { accountBalanceCheckpoints, accounts, transactions } from './schema';
import { getFinanceTransactionRunner } from './finance-transaction';

function assertDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('Expected a valid Date');
}
function assertPaise(value: number): void {
  if (!Number.isSafeInteger(value)) throw new RangeError('Balance must be safe integer paise');
}
function checkedPaise(value: bigint): number {
  const result = Number(value);
  assertPaise(result);
  return result;
}

export function createReconciliation(
  client: LedgerSQLiteClient,
  migrations: LedgerMigrations,
  runTransaction?: LedgerSQLiteTransactionRunner,
) {
  const run = getFinanceTransactionRunner(client, runTransaction);
  async function accountBalances(transaction: LedgerSQLiteClient, asOf: Date, accountId?: string) {
    const { db } = createLedger(transaction, migrations);
    const rows = await db.select().from(accounts).leftJoin(accountBalanceCheckpoints, eq(accounts.id, accountBalanceCheckpoints.accountId)).where(accountId === undefined ? undefined : eq(accounts.id, accountId)).all();
    const result = [];
    for (const { accounts: account, account_balance_checkpoints: checkpoint } of rows) {
      let calculatedPaise: number | null = null;
      if (checkpoint) {
        assertPaise(checkpoint.balancePaise);
        assertDate(checkpoint.asOf);
        assertDate(checkpoint.confirmedAt);
        if (checkpoint.reconciliationDeltaPaise !== null) assertPaise(checkpoint.reconciliationDeltaPaise);
        if (checkpoint.accountType === account.type && checkpoint.asOf <= asOf) {
          const movements = await db.select({ amountPaise: transactions.amountPaise, direction: transactions.direction }).from(transactions).where(and(
            eq(transactions.accountId, account.id), eq(transactions.status, 'posted'), isNull(transactions.deletedAt),
            gt(transactions.occurredAt, checkpoint.asOf), lte(transactions.occurredAt, asOf),
          )).all();
          let balance = BigInt(checkpoint.balancePaise);
          for (const movement of movements) {
            assertPaise(movement.amountPaise);
            if (movement.amountPaise <= 0 || !['debit', 'credit'].includes(movement.direction)) throw new RangeError('Invalid account movement');
            const increases = account.type === 'credit_card' ? movement.direction === 'debit' : movement.direction === 'credit';
            balance += (increases ? 1n : -1n) * BigInt(movement.amountPaise);
          }
          calculatedPaise = checkedPaise(balance);
        }
      }
      result.push({
        accountId: account.id, name: account.name, type: account.type, isOwn: account.isOwn, archived: account.archived,
        lastVerifiedPaise: checkpoint?.balancePaise ?? null,
        lastVerifiedAt: checkpoint?.asOf ?? null,
        calculatedPaise,
        reconciliationDeltaPaise: checkpoint?.reconciliationDeltaPaise ?? null,
      });
    }
    return result;
  }
  return {
    async getAccountBalances(asOf: Date) {
      assertDate(asOf);
      let result: Awaited<ReturnType<typeof accountBalances>> = [];
      await run(async transaction => { result = await accountBalances(transaction, asOf); });
      return result;
    },
    async setAccountBalance(input: { accountId: string; balancePaise: number; asOf: Date }, now: Date): Promise<void> {
      if (!input || typeof input.accountId !== 'string' || !input.accountId.trim()) throw new TypeError('accountId must be non-empty');
      assertPaise(input.balancePaise);
      assertDate(input.asOf);
      assertDate(now);
      if (input.asOf > now) throw new RangeError('Balance date cannot be in the future');
      await run(async transaction => {
        const { db } = createLedger(transaction, migrations);
        const account = await db.select().from(accounts).where(eq(accounts.id, input.accountId)).get();
        if (!account || !account.isOwn || account.archived) throw new RangeError('Balance requires an active own account');
        const previous = await db.select().from(accountBalanceCheckpoints).where(eq(accountBalanceCheckpoints.accountId, input.accountId)).get();
        if (previous && input.asOf < previous.asOf) throw new RangeError('Balance date cannot precede its checkpoint');
        const projected = (await accountBalances(transaction, input.asOf, input.accountId)).find(row => row.accountId === input.accountId)!.calculatedPaise;
        const reconciliationDeltaPaise = projected === null ? null : checkedPaise(BigInt(input.balancePaise) - BigInt(projected));
        const checkpoint = { ...input, accountType: account.type, confirmedAt: now, reconciliationDeltaPaise };
        await db.insert(accountBalanceCheckpoints).values(checkpoint).onConflictDoUpdate({ target: accountBalanceCheckpoints.accountId, set: checkpoint }).run();
      });
    },
  };
}
