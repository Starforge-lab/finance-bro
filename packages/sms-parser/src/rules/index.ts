import type { Rule } from '../types';
import { genericRule } from './generic';
import { hdfcUpiCreditRule } from './banks/hdfc';

/**
 * Institution-specific rules, in priority order. Add one file per institution under
 * rules/banks, rules/upi, rules/cards or rules/wallets, built from real (anonymised)
 * samples with fixtures. See CONTRIBUTING.md → "Adding a new SMS format".
 */
export const institutionRules: readonly Rule[] = [hdfcUpiCreditRule];

/** Fallbacks tried after institution rules. */
export const genericRules: readonly Rule[] = [genericRule];

export const allRules: readonly Rule[] = [...institutionRules, ...genericRules];

export function rulesFor(institution: string | null): readonly Rule[] {
  const specific = institution ? institutionRules.filter((r) => r.institutions?.includes(institution)) : [];
  return [...specific, ...genericRules];
}
