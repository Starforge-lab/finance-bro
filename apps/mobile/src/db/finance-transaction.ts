import type { LedgerSQLiteClient, LedgerSQLiteTransactionRunner } from './ledger';

const runners = new WeakMap<LedgerSQLiteClient, LedgerSQLiteTransactionRunner>();
type FinanceQueue = <T>(task: () => Promise<T>) => Promise<T>;
const queues = new WeakMap<LedgerSQLiteClient, FinanceQueue>();

/** Every operation on a shared connection must wait for its active transaction. */
export function getFinanceQueue(client: LedgerSQLiteClient): FinanceQueue {
  const existing = queues.get(client);
  if (existing) return existing;
  let tail = Promise.resolve();
  const queue: FinanceQueue = task => {
    const result = tail.then(task);
    tail = result.then(() => {}, () => {});
    return result;
  };
  queues.set(client, queue);
  return queue;
}

export function getFinanceTransactionRunner(client: LedgerSQLiteClient, provided?: LedgerSQLiteTransactionRunner): LedgerSQLiteTransactionRunner {
  if (provided) return provided;
  const existing = runners.get(client);
  if (existing) return existing;
  const queue = getFinanceQueue(client);
  const run: LedgerSQLiteTransactionRunner = task => queue(() => client.withTransactionAsync(() => task(client)));
  runners.set(client, run);
  return run;
}
