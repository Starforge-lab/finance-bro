import { eq, inArray } from 'drizzle-orm';
import type { Ledger } from '../db/ledger';
import { importKeyState, smsImportRefs, transactions } from '../db/schema';

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
