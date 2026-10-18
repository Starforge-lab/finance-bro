import { hasFailureWording } from '../classify';
import { extractLast4 } from '../extract/account';
import { extractBalance, extractTxnAmount } from '../extract/amount';
import { detectChannel, detectDirection, extractCounterparty } from '../extract/details';
import { extractUpiRef, extractVpa } from '../extract/upi';
import type { Rule, TxnKind } from '../types';

const REFUND = /\brefund(?:ed)?\b/i;
const REVERSAL = /\brevers(?:ed|al)\b/i;

/**
 * Keyword + extractor fallback for any sender. Institution rules run first and
 * should be preferred; this exists so an unseen format still lands somewhere useful.
 *
 * Confidence is "medium" only when the sender is a known institution (or the SMS
 * carries a UPI ref) AND there's an account/VPA/ref anchor. Anything less goes to review.
 */
export const genericRule: Rule = {
  id: 'generic.keyword',
  version: 4,
  match(sms) {
    const { text, senderInfo, receivedAt } = sms;
    const amountPaise = extractTxnAmount(text);
    const direction = detectDirection(text);
    if (amountPaise === null || direction === null) return null;

    const failed = hasFailureWording(text);
    const channel = detectChannel(text);
    const accountLast4 = extractLast4(text);
    const vpa = extractVpa(text);
    const upiRef = extractUpiRef(text);

    let kind: TxnKind = direction === 'debit' ? 'expense' : 'income';
    // A failed txn often says "will be reversed"; that's not a reversal of an earlier txn.
    if (!failed && direction === 'credit' && REFUND.test(text)) kind = 'refund';
    else if (!failed && direction === 'credit' && REVERSAL.test(text)) kind = 'reversal';
    else if (direction === 'debit' && channel === 'atm') kind = 'cash_withdrawal';

    const trustedSource = senderInfo.institution !== null || upiRef !== null;
    const anchored = accountLast4 !== null || vpa !== null || upiRef !== null;

    return {
      confidence: trustedSource && anchored ? 'medium' : 'low',
      txn: {
        amountPaise,
        direction,
        kind,
        status: failed ? 'failed' : 'posted',
        channel,
        institution: senderInfo.institution,
        accountLast4,
        counterparty: extractCounterparty(text, direction),
        vpa,
        upiRef,
        balancePaise: extractBalance(text),
        occurredAt: receivedAt,
      },
    };
  },
};
