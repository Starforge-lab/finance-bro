import { eq, inArray, ne } from 'drizzle-orm';
import type { Ledger } from '../db/ledger';
import { importKeyState, smsImportRefs, smsImportState, transactions } from '../db/schema';
import type { FingerprintKeyPolicy } from './fingerprint';

/** A missing key may be generated only before any fingerprinted import state exists. */
export async function getFingerprintKeyPolicy(ledger: Ledger): Promise<FingerprintKeyPolicy> {
  const savedKey = await ledger.db.select({ id: importKeyState.id }).from(importKeyState).limit(1).get();
  if (savedKey) return { allowCreate: false };

  const smsState = await ledger.db.select({ id: smsImportState.id }).from(smsImportState).limit(1).get();
  if (smsState) return { allowCreate: false };

  const smsReference = await ledger.db.select({ platformId: smsImportRefs.platformId }).from(smsImportRefs).limit(1).get();
  if (smsReference) return { allowCreate: false };

  const importedTransaction = await ledger.db.select({ id: transactions.id }).from(transactions)
    .where(ne(transactions.source, 'manual')).limit(1).get();
  return { allowCreate: importedTransaction === undefined };
}

export async function requiresDuplicateReview(ledger: Ledger, keyId: string): Promise<boolean> {
  if (typeof keyId !== 'string' || !/^[a-f0-9]{64}$/.test(keyId)) throw new TypeError('Invalid fingerprint key identifier');
  let state = await ledger.db.select().from(importKeyState).where(eq(importKeyState.id, 1)).get();
  if (!state) {
    // Legacy imports cannot be re-fingerprinted without their original messages.
    const legacy = await ledger.db.select({ id: transactions.id }).from(transactions)
      .where(inArray(transactions.source, ['paste', 'sms'])).limit(1).get();
    const legacySmsRef = await ledger.db.select({ platformId: smsImportRefs.platformId }).from(smsImportRefs).limit(1).get();
    await ledger.db.insert(importKeyState).values({ id: 1, keyId: legacy || legacySmsRef ? 'legacy' : keyId }).onConflictDoNothing().run();
    state = await ledger.db.select().from(importKeyState).where(eq(importKeyState.id, 1)).get();
  }
  if (!state) throw new Error('Import key state could not be saved');
  return state.keyId !== keyId;
}

export class DuplicateReviewRequiredError extends Error {
  constructor() {
    super('Import key changed or legacy imports exist. Review existing transactions before confirming this paste.');
    this.name = 'DuplicateReviewRequiredError';
  }
}
