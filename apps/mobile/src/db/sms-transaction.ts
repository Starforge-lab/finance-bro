import type { LedgerSQLiteTransactionRunner } from './ledger';

export function createSmsTransactionRunner(_databaseName: string): LedgerSQLiteTransactionRunner {
  return async () => {
    throw new Error('Android SMS import transactions are unavailable on this platform');
  };
}
