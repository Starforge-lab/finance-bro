import * as SQLite from 'expo-sqlite';
import { createDataLayer, type DataLayer } from './service';
import { ledgerMigrations } from './migrations';
import { getFingerprinter } from '../imports/fingerprint-store';

let opening: Promise<DataLayer> | undefined;
let openClient: SQLite.SQLiteDatabase | undefined;

async function openLedger(): Promise<DataLayer> {
  const client = await SQLite.openDatabaseAsync('finance-bro.db', { enableChangeListener: true });
  const ledger = createDataLayer(client, ledgerMigrations, getFingerprinter);
  try {
    await ledger.migrateLedger();
    openClient = client;
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

/** The open database, for development fixtures that need a transaction around many calls. */
export async function getLedgerClient(): Promise<SQLite.SQLiteDatabase> {
  await getLedger();
  return openClient!;
}

export { createLedger, migrateLedger, assertValidAmountPaise } from './ledger';
export { createDataLayer } from './service';
export type { DataLayer } from './service';
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
