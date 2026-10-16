import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { allRules, parseSms } from '../src';
import type { ParsedTxn } from '../src';

interface FixtureCase {
  name: string;
  sender: string;
  body: string;
  receivedAt: string;
  expectedOccurredAt?: string;
  expected:
    | { kind: 'transaction'; ruleId?: string; confidence?: string; txn?: Partial<ParsedTxn> }
    | { kind: 'review'; ruleId?: string | null; txn?: Partial<ParsedTxn> }
    | { kind: 'ignored'; reason: string };
}

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');

function fixtureFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? fixtureFiles(join(dir, e.name)) : e.name.endsWith('.json') ? [join(dir, e.name)] : [],
  );
}

const suites = fixtureFiles(FIXTURES_DIR).map((file) => ({
  file: relative(FIXTURES_DIR, file),
  cases: (JSON.parse(readFileSync(file, 'utf8')) as { cases: FixtureCase[] }).cases,
}));

const matchedRuleIds = new Set<string>();

for (const { file, cases } of suites) {
  describe(file, () => {
    it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
      const result = parseSms({ sender: c.sender, body: c.body, receivedAt: Date.parse(c.receivedAt) });
      const exp = c.expected;

      expect(result.kind).toBe(exp.kind);

      if (exp.kind === 'ignored' && result.kind === 'ignored') {
        expect(result.reason).toBe(exp.reason);
      }
      if (exp.kind === 'transaction' && result.kind === 'transaction') {
        matchedRuleIds.add(result.ruleId);
        if (exp.ruleId) expect(result.ruleId).toBe(exp.ruleId);
        if (exp.confidence) expect(result.confidence).toBe(exp.confidence);
        if (exp.txn) expect(result.txn).toMatchObject(exp.txn);
        expect(result.txn.occurredAt).toBe(Date.parse(c.expectedOccurredAt ?? c.receivedAt));
      }
      if (exp.kind === 'review' && result.kind === 'review') {
        if (exp.ruleId !== undefined) expect(result.ruleId).toBe(exp.ruleId);
        if (exp.txn) expect(result.candidate).toMatchObject(exp.txn);
      }
    });
  });
}

describe('rule coverage', () => {
  it('every rule has at least one positive fixture', () => {
    const uncovered = allRules.map((r) => r.id).filter((id) => !matchedRuleIds.has(id));
    expect(uncovered).toEqual([]);
  });
});
