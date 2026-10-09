import { createLedger, type LedgerMigrations, type LedgerSQLiteClient } from './ledger';
import { createPlanning } from './planning';
import { createPreferences } from './preferences';
import { createLedgerQueries } from './queries';
import { createLedgerCsvExporter } from '../exports/csv';
import { saveManualEntry, type ManualEntry } from './manual';
import { preparePastedSms, saveReviewedPaste, type PastePreparation, type ReviewCorrections } from '../imports/paste';
import { DuplicateReviewRequiredError, requiresDuplicateReview } from '../imports/key-state';
import type { Fingerprinter } from '../imports/fingerprint';
import type { RawSms } from '@finance-bro/sms-parser';

/** One local business API for screens; no network or UI dependencies. */
export function createDataLayer(client: LedgerSQLiteClient, migrations: LedgerMigrations, fingerprints?: () => Promise<Fingerprinter>) {
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
  async function getPasteCollision(id: string) {
    if (!/^paste:body:[a-f0-9]{64}$/.test(id)) return null;
    const collision = await ledger.findPasteCollision(id);
    return collision ? { occurredAt: collision.occurredAt.getTime(), deleted: collision.deletedAt !== null } : null;
  }
  return {
    ...manualLedger,
    ...queries,
    ...planning,
    ...createPreferences(db),
    ...createLedgerCsvExporter(db),
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
      return saveReviewedPaste(ledger, prepared, corrections, options, fingerprinter);
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
