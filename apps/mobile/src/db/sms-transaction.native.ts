import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import type { LedgerSQLiteTransactionRunner } from './ledger';

export function createSmsTransactionRunner(databaseName: string): LedgerSQLiteTransactionRunner {
  return async (task) => {
    if (Platform.OS !== 'android') throw new Error('Android SMS import transactions are unavailable on this platform');
    const transaction = await SQLite.openDatabaseAsync(databaseName, { useNewConnection: true, enableChangeListener: true });
    let active = false;
    try {
      await transaction.execAsync('PRAGMA busy_timeout = 5000');
      await transaction.execAsync('PRAGMA foreign_keys = ON');
      const foreignKeys = await transaction.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
      if (foreignKeys?.foreign_keys !== 1) throw new Error('SMS import transaction cannot enforce ledger references');

      await transaction.execAsync('BEGIN IMMEDIATE');
      active = true;
      try {
        await task(transaction);
        await transaction.execAsync('COMMIT');
        active = false;
      } catch (error) {
        if (active) await transaction.execAsync('ROLLBACK').catch(() => {});
        active = false;
        throw error;
      }
    } finally {
      await transaction.closeAsync().catch(() => {});
    }
  };
}
