import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { createDataLayer, type DataLayer } from './service';
import { ledgerMigrations } from './migrations';
import { getFingerprinter } from '../imports/fingerprint-store';
import { createSmsTransactionRunner } from './sms-transaction';

let opening: Promise<DataLayer> | undefined;

async function openLedger(): Promise<DataLayer> {
  const databaseName = 'finance-bro.db';
  const client = await SQLite.openDatabaseAsync(databaseName, { enableChangeListener: true });
  const runSmsTransaction = Platform.OS === 'android' ? createSmsTransactionRunner(databaseName) : undefined;
  const ledger = createDataLayer(client, ledgerMigrations, getFingerprinter, runSmsTransaction);
  try {
    await ledger.migrateLedger();
    return ledger;
  } catch (error) {
    await client.closeAsync().catch(() => {});
    throw error;
  }
}

export function getLedger(): Promise<DataLayer> {
  opening ??= openLedger().catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

export { createLedger, migrateLedger, assertValidAmountPaise } from './ledger';
export { createDataLayer } from './service';
export type { DataLayer } from './service';
export type { SmsCursor, SmsInboxRow, SmsImportBatchResult } from '../imports/sms';
export { parseInrAmount, saveManualEntry, editManualAmount } from './manual';
export type { ManualEntry } from './manual';
export type { NewBudget, BudgetPatch, NewBill, BillPatch, BillStatus } from './planning';
export type { TransactionFilters } from './queries';
export { DuplicateReviewRequiredError } from '../imports/key-state';
export type {
  NewAccount,
  AccountPatch,
  NewCategory,
  CategoryPatch,
  ImportedTransaction,
  Ledger,
  LedgerMigrations,
  LedgerSQLiteClient,
  NewTransaction,
  TransactionPatch,
} from './ledger';
