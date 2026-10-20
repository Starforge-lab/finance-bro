import { hasFailureWording } from '../../classify';
import { toPaise } from '../../extract/amount';
import { extractVpa } from '../../extract/upi';
import { matchHdfcUpiCardAlert } from '../../extract/hdfc-card';
import type { Rule } from '../../types';

export const hdfcUpiCardDebitRule: Rule = {
  id: 'hdfc.upi.card.debit',
  version: 1,
  institutions: ['hdfc'],
  match(sms) {
    if (hasFailureWording(sms.text)) return null;
    const match = matchHdfcUpiCardAlert(sms);
    if (!match) return null;
    const amountPaise = toPaise(match[1]!);
    const day = Number(match[5]);
    const month = Number(match[6]);
    const date = new Date(Date.UTC(2000, month - 1, day));
    if (amountPaise === null || amountPaise <= 0 || date.getUTCDate() !== day || date.getUTCMonth() !== month - 1 ||
        !Number.isSafeInteger(sms.receivedAt) || !Number.isFinite(new Date(sms.receivedAt).getTime())) return null;
    const vpa = extractVpa(match[3]!);
    return {
      confidence: 'medium',
      txn: {
        amountPaise,
        direction: 'debit',
        kind: 'expense',
        status: 'posted',
        channel: 'upi',
        institution: 'hdfc',
        accountLast4: match[2]!,
        counterparty: vpa === null ? match[3]!.trim() : null,
        vpa,
        upiRef: match[4]!,
        balancePaise: null,
        // The alert omits its year; keep arrival time and require review rather than inventing a date.
        occurredAt: sms.receivedAt,
      },
    };
  },
};
