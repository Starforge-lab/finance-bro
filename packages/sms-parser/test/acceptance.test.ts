import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { classify, normalise, parseSms } from '../src';
import type { Classification, ParsedTxn, RawSms } from '../src';

interface AcceptanceCase {
  name: string;
  source: 'user-observed-shape' | 'synthetic';
  label: 'hdfc-high' | 'not-hdfc-high';
  expectedClassification: Classification;
  sender: string;
  body: string;
  receivedAt: string;
  expectedTxn?: Partial<ParsedTxn>;
  expectedOccurredAt?: string;
}

const corpusPath = join(import.meta.dirname, '..', 'fixtures', 'acceptance', 'hdfc-credit-v1.json');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { ruleId: string; ruleVersion: number; cases: AcceptanceCase[] };
const cases = corpus.cases;

describe('HDFC credit acceptance corpus', () => {
  it('has exactly one user-observed shape and keeps every other case synthetic', () => {
    expect(cases).toHaveLength(53);
    expect(cases.filter((c) => c.source === 'user-observed-shape')).toHaveLength(1);
    expect(cases.filter((c) => c.source === 'synthetic')).toHaveLength(cases.length - 1);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const sms: RawSms = { sender: c.sender, body: c.body, receivedAt: Date.parse(c.receivedAt) };
    expect(Number.isSafeInteger(sms.receivedAt)).toBe(true);
    expect(classify(normalise(sms))).toBe(c.expectedClassification);

    const result = parseSms(sms);
    if (c.label === 'hdfc-high') {
      expect(c.expectedTxn).toBeDefined();
      expect(c.expectedOccurredAt).toBeDefined();
      expect(result.kind).toBe('transaction');
      if (result.kind !== 'transaction') return;
      expect(result).toMatchObject({ ruleId: corpus.ruleId, ruleVersion: corpus.ruleVersion, confidence: 'high' });
      expect(result.txn).toMatchObject({
        direction: 'credit',
        kind: 'income',
        status: 'posted',
        channel: 'upi',
        institution: 'hdfc',
        ...c.expectedTxn,
      });
      expect(Number.isSafeInteger(result.txn.amountPaise)).toBe(true);
      expect(result.txn.amountPaise).toBeGreaterThan(0);
      expect(result.txn.occurredAt).toBe(Date.parse(c.expectedOccurredAt!));
      return;
    }

    expect(result.kind === 'transaction' && result.ruleId === 'hdfc.upi.credit' && result.confidence === 'high').toBe(false);
    if (result.kind === 'transaction') {
      expect(Number.isSafeInteger(result.txn.amountPaise)).toBe(true);
      expect(result.txn.amountPaise).toBeGreaterThan(0);
    } else if (result.kind === 'review' && result.candidate) {
      expect(Number.isSafeInteger(result.candidate.amountPaise)).toBe(true);
      expect(result.candidate.amountPaise).toBeGreaterThan(0);
      expect(Number.isSafeInteger(result.candidate.occurredAt)).toBe(true);
    }
  });
});
