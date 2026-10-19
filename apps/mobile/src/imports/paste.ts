import { parseSms } from '@finance-bro/sms-parser';
import type { ParsedTxn, RawSms } from '@finance-bro/sms-parser';
import type { Ledger, ReviewedPasteTransaction, TransactionPatch } from '../db/ledger';
import type { Fingerprinter } from './fingerprint';
import { DuplicateReviewRequiredError, requiresDuplicateReview } from './key-state';

export type PastePreparation =
  | { kind: 'ignored'; reason: string }
  | {
      kind: 'needs-review';
      candidate: ParsedTxn | null;
      ruleId: string | null;
      ruleVersion: number | null;
      identity: { id: string; dedupeKey: string; bodyHash: string; weakDedupeKey: string };
      fingerprintKeyId: string;
      duplicateReviewRequired: boolean;
      collision: { occurredAt: number; deleted: boolean } | null;
    };

export type ReviewCorrections = TransactionPatch;

export type PasteSaveResult = 'inserted' | 'duplicate';

async function keyedFingerprint(value: unknown[], fingerprinter: Fingerprinter): Promise<string> {
  const result = await fingerprinter.fingerprint(JSON.stringify(value));
  if (!/^[a-f0-9]{64}$/.test(result)) throw new TypeError('Invalid keyed fingerprint');
  return result;
}

export async function preparePastedSms(raw: RawSms, fingerprinter: Fingerprinter): Promise<PastePreparation> {
  const result = parseSms(raw);
  if (result.kind === 'ignored') return { kind: 'ignored', reason: result.reason };

  const candidate = result.kind === 'transaction' ? result.txn : result.candidate;
  const [bodyHash, weakDedupeKey] = await Promise.all([
    keyedFingerprint(['body', raw.body], fingerprinter),
    keyedFingerprint(['sms', raw.sender.trim().toUpperCase(), raw.body], fingerprinter),
  ]);
  const identityKey = candidate?.upiRef
    ? `upi:${await keyedFingerprint(['upi', candidate.upiRef, candidate.direction, candidate.status, candidate.kind], fingerprinter)}`
    : `body:${weakDedupeKey}`;

  return {
    kind: 'needs-review',
    candidate,
    ruleId: result.ruleId,
    ruleVersion: result.ruleVersion,
    identity: { id: `paste:${identityKey}`, dedupeKey: identityKey, bodyHash, weakDedupeKey: `body:${weakDedupeKey}` },
    fingerprintKeyId: fingerprinter.keyId,
    duplicateReviewRequired: false,
    collision: null,
  };
}

export async function saveReviewedPaste(
  ledger: Ledger,
  prepared: PastePreparation,
  corrections: ReviewCorrections = {},
  options: { acknowledgeDuplicateRisk?: boolean; separatePaymentAt?: Date } = {},
  fingerprinter?: Fingerprinter,
): Promise<PasteSaveResult> {
  if (prepared.kind !== 'needs-review') throw new TypeError('Ignored SMS cannot be saved');
  if (!/^[a-f0-9]{64}$/.test(prepared.identity.bodyHash) ||
      !/^(upi|body):[a-f0-9]{64}$/.test(prepared.identity.dedupeKey) ||
      !/^body:[a-f0-9]{64}$/.test(prepared.identity.weakDedupeKey) ||
      (prepared.identity.dedupeKey.startsWith('body:') && prepared.identity.dedupeKey !== prepared.identity.weakDedupeKey) ||
      prepared.identity.id !== `paste:${prepared.identity.dedupeKey}`) {
    throw new TypeError('Invalid keyed paste identity');
  }
  if (await requiresDuplicateReview(ledger, prepared.fingerprintKeyId) && options.acknowledgeDuplicateRisk !== true) {
    throw new DuplicateReviewRequiredError();
  }
  let identity = prepared.identity;
  const separatePaymentAt = options.separatePaymentAt;
  if (separatePaymentAt !== undefined) {
    if (!prepared.identity.dedupeKey.startsWith('body:') || prepared.candidate?.upiRef || corrections.upiRef?.trim()) {
      throw new TypeError('Only a no-reference paste collision can be separated by time');
    }
    if (!(separatePaymentAt instanceof Date) || !Number.isFinite(separatePaymentAt.getTime()) || separatePaymentAt.getTime() % 1_000 !== 0) {
      throw new TypeError('Separate payment time must be a valid whole second');
    }
    const existing = await ledger.findPasteCollision(prepared.identity.id, prepared.identity.dedupeKey);
    if (!existing) throw new TypeError('A separate payment requires a matching paste collision');
    if (Math.floor(existing.occurredAt.getTime() / 1_000) === Math.floor(separatePaymentAt.getTime() / 1_000)) {
      throw new RangeError('Choose a different actual time; payments in the same second must be entered manually');
    }
    if (corrections.occurredAt !== undefined && corrections.occurredAt.getTime() !== separatePaymentAt.getTime()) {
      throw new TypeError('The saved occurrence time must match the selected separate payment time');
    }
    if (!fingerprinter || fingerprinter.keyId !== prepared.fingerprintKeyId) {
      throw new DuplicateReviewRequiredError();
    }
    const disambiguator = await keyedFingerprint(
      ['body-occurrence-v1', prepared.identity.dedupeKey, Math.floor(separatePaymentAt.getTime() / 1_000)],
      fingerprinter,
    );
    identity = {
      id: `paste:body:${disambiguator}`,
      dedupeKey: `body:${disambiguator}`,
      bodyHash: prepared.identity.bodyHash,
      weakDedupeKey: prepared.identity.weakDedupeKey,
    };
  }
  const candidate = prepared.candidate;
  if (!candidate) {
    for (const key of ['amountPaise', 'direction', 'kind', 'status', 'occurredAt'] as const) {
      if (corrections[key] === undefined) throw new TypeError(`${key} is required for an unparsed SMS`);
    }
  }

  const value = <K extends keyof ReviewCorrections>(key: K, fallback: ReviewCorrections[K]) =>
    corrections[key] === undefined ? fallback : corrections[key] as ReviewCorrections[K];
  const amountPaise = value('amountPaise', candidate?.amountPaise);
  const direction = value('direction', candidate?.direction);
  const kind = value('kind', candidate?.kind);
  const status = value('status', candidate?.status);
  const occurredAt = value('occurredAt', separatePaymentAt ?? (candidate ? new Date(candidate.occurredAt) : undefined));
  if (amountPaise === undefined || direction === undefined || kind === undefined || status === undefined || occurredAt === undefined) {
    throw new TypeError('A complete reviewed transaction is required');
  }

  const insert: ReviewedPasteTransaction = {
    id: identity.id,
    amountPaise,
    direction,
    kind,
    status,
    occurredAt,
    dedupeKey: identity.dedupeKey,
    bodyHash: identity.bodyHash,
    weakDedupeKey: identity.weakDedupeKey,
    ruleId: prepared.ruleId,
    ruleVersion: prepared.ruleVersion,
    accountId: value('accountId', null),
    counterparty: value('counterparty', candidate?.counterparty ?? null),
    merchantId: value('merchantId', null),
    categoryId: value('categoryId', null),
    note: value('note', null),
    upiRef: value('upiRef', candidate?.upiRef ?? null),
    linkedTxnId: value('linkedTxnId', null),
    excludeFromStats: value('excludeFromStats', false),
  };
  return await ledger.insertReviewedPaste(insert) ? 'inserted' : 'duplicate';
}
