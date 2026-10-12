import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { createLedger, type LedgerMigrations, type LedgerSQLiteClient, type LedgerSQLiteTransactionRunner } from './ledger';
import { smsImportRefs, transactions } from './schema';
import { createPlanning } from './planning';
import { createLedgerQueries } from './queries';
import { createLedgerCsvExporter } from '../exports/csv';
import { saveManualEntry, type ManualEntry } from './manual';
import { preparePastedSms, saveReviewedPaste, type PastePreparation, type PasteSaveResult, type ReviewCorrections } from '../imports/paste';
import { DuplicateReviewRequiredError, requiresDuplicateReview } from '../imports/key-state';
import type { Fingerprinter } from '../imports/fingerprint';
import type { RawSms } from '@finance-bro/sms-parser';
import { createSmsIngestion } from '../imports/sms';

async function reconcileSmsReviewReferences(ledger: ReturnType<typeof createLedger>, prepared: PastePreparation) {
  if (prepared.kind !== 'needs-review' || await requiresDuplicateReview(ledger, prepared.fingerprintKeyId)) return;

  const sourceRefs = await ledger.db.select({ bodyHash: smsImportRefs.bodyHash })
    .from(smsImportRefs)
    .where(and(
      eq(smsImportRefs.dedupeKey, prepared.identity.dedupeKey),
      eq(smsImportRefs.keyId, prepared.fingerprintKeyId),
      eq(smsImportRefs.status, 'review'),
      isNull(smsImportRefs.transactionId),
    )).all();
  if (sourceRefs.length === 0) return;

  const referenceFilter = and(
    eq(smsImportRefs.dedupeKey, prepared.identity.dedupeKey),
    eq(smsImportRefs.keyId, prepared.fingerprintKeyId),
    eq(smsImportRefs.status, 'review'),
    isNull(smsImportRefs.transactionId),
  );
  if (prepared.identity.dedupeKey.startsWith('body:')) {
    // Weak identities can collide across real purchases. Keep every platform row in review.
    await ledger.db.update(smsImportRefs).set({ status: 'review', reason: 'weak_overlap', transactionId: null })
      .where(referenceFilter).run();
    return;
  }

  const matchingRefs = sourceRefs.filter((ref) => ref.bodyHash === prepared.identity.bodyHash);
  const ambiguousRefs = sourceRefs.filter((ref) => ref.bodyHash !== prepared.identity.bodyHash);
  const targets = await ledger.db.select({ id: transactions.id }).from(transactions).where(and(
    eq(transactions.dedupeKey, prepared.identity.dedupeKey),
    eq(transactions.bodyHash, prepared.identity.bodyHash),
    eq(transactions.status, 'posted'),
    inArray(transactions.source, ['sms', 'paste']),
  )).all();

  if (matchingRefs.length > 0) {
    if (targets.length === 1) {
      await ledger.db.update(smsImportRefs).set({
        status: 'duplicate',
        reason: null,
        transactionId: targets[0]!.id,
      }).where(and(referenceFilter, eq(smsImportRefs.bodyHash, prepared.identity.bodyHash))).run();
    } else {
      await ledger.db.update(smsImportRefs).set({ status: 'review', reason: 'ambiguous_evidence', transactionId: null })
        .where(and(referenceFilter, eq(smsImportRefs.bodyHash, prepared.identity.bodyHash))).run();
    }
  }
  if (ambiguousRefs.length > 0) {
    await ledger.db.update(smsImportRefs).set({ status: 'review', reason: 'ambiguous_evidence', transactionId: null })
      .where(and(referenceFilter, ne(smsImportRefs.bodyHash, prepared.identity.bodyHash))).run();
  }
}

/** One local business API for screens; no network or UI dependencies. */
export function createDataLayer(
  client: LedgerSQLiteClient,
  migrations: LedgerMigrations,
  fingerprints?: () => Promise<Fingerprinter>,
  runSmsTransaction?: LedgerSQLiteTransactionRunner,
) {
  const ledger = createLedger(client, migrations);
  const {
    db,
    findPasteCollision: _findPasteCollision,
    insertReviewedPaste: _insertReviewedPaste,
    upsertImportedTransaction: _upsertImportedTransaction,
    ...manualLedger
  } = ledger;
  const queries = createLedgerQueries(db);
  const planning = createPlanning(db);
  const smsIngestion = createSmsIngestion(client, migrations, fingerprints, runSmsTransaction);
  async function getPasteCollision(id: string) {
    const match = /^paste:body:([a-f0-9]{64})$/.exec(id);
    if (!match) return null;
    const collision = await ledger.findPasteCollision(id, `body:${match[1]}`);
    return collision ? { occurredAt: collision.occurredAt.getTime(), deleted: collision.deletedAt !== null } : null;
  }
  return {
    ...manualLedger,
    ...queries,
    ...planning,
    ...createLedgerCsvExporter(db),
    ...smsIngestion,
    saveManualEntry: (input: ManualEntry) => saveManualEntry(ledger, input),
    async preparePaste(raw: RawSms) {
      if (!fingerprints) throw new Error('A platform fingerprint provider is required for paste imports');
      const prepared = await preparePastedSms(raw, await fingerprints());
      if (prepared.kind === 'needs-review') {
        prepared.duplicateReviewRequired = await requiresDuplicateReview(ledger, prepared.fingerprintKeyId);
        if (prepared.identity.dedupeKey.startsWith('body:') && !prepared.candidate?.upiRef) {
          prepared.collision = await getPasteCollision(prepared.identity.id);
        }
      }
      return prepared;
    },
    getPasteCollision,
    async saveReviewedPaste(
      prepared: PastePreparation,
      corrections: ReviewCorrections = {},
      options: { acknowledgeDuplicateRisk?: boolean; separatePaymentAt?: Date } = {},
    ) {
      let fingerprinter: Fingerprinter | undefined;
      if (options.separatePaymentAt !== undefined) {
        if (!fingerprints) throw new Error('A platform fingerprint provider is required for paste imports');
        fingerprinter = await fingerprints();
        if (prepared.kind === 'needs-review' && fingerprinter.keyId !== prepared.fingerprintKeyId) {
          throw new DuplicateReviewRequiredError();
        }
      }
      if (!runSmsTransaction) return saveReviewedPaste(ledger, prepared, corrections, options, fingerprinter);

      let result: PasteSaveResult | undefined;
      await runSmsTransaction(async (transaction) => {
        const transactionLedger = createLedger(transaction, migrations);
        result = await saveReviewedPaste(transactionLedger, prepared, corrections, options, fingerprinter);
        await reconcileSmsReviewReferences(transactionLedger, prepared);
      });
      if (result === undefined) throw new Error('Paste transaction completed without a result');
      return result;
    },
    async getBudgetSummary(month: string) {
      const [budgets, summary] = await Promise.all([
        planning.listBudgets(month), queries.getMonthlySummary(month),
      ]);
      return budgets.map((budget) => {
        const spending = summary.categories.find((category) => category.categoryId === budget.categoryId);
        const spentPaise = spending?.expensePaise ?? 0;
        const remaining = BigInt(budget.amountPaise) - BigInt(spentPaise);
        if (remaining > BigInt(Number.MAX_SAFE_INTEGER) || remaining < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw new RangeError('Budget remaining exceeds safe integer paise');
        }
        return { ...budget, spentPaise, remainingPaise: Number(remaining), overBudget: remaining < 0n };
      });
    },
  };
}

export type DataLayer = ReturnType<typeof createDataLayer>;
