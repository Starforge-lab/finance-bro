import journal from '../../drizzle/meta/_journal.json';
import initialLedger from '../../drizzle/0000_initial_ledger.sql';
import reviewedPaste from '../../drizzle/0001_furry_the_stranger.sql';
import planning from '../../drizzle/0002_loose_moondragon.sql';
import importKey from '../../drizzle/0003_dry_darkhawk.sql';
import transactionIntegrity from '../../drizzle/0004_transaction_integrity.sql';
import categoryFixed from '../../drizzle/0005_category_fixed.sql';
import preferences from '../../drizzle/0006_preferences.sql';
import type { LedgerMigrations } from './ledger';

export const ledgerMigrations: LedgerMigrations = {
  journal,
  migrations: { m0000: initialLedger, m0001: reviewedPaste, m0002: planning, m0003: importKey, m0004: transactionIntegrity, m0005: categoryFixed, m0006: preferences },
};
