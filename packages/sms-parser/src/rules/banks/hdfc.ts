import { genericRule } from '../generic';
import { FAILED } from '../../classify';
import { extractLast4 } from '../../extract/account';
import { toPaise } from '../../extract/amount';
import { extractVpa } from '../../extract/upi';
import type { NormalisedSms, Rule, RuleMatch } from '../../types';

const INDIA_OFFSET_MS = 330 * 60 * 1_000;
const CREDIT_ALERT =
  /^Credit Alert! INR ([\d,.]+) credited to HDFC Bank A\/c XX(\d{4}) on (\d{2})-(\d{2})-(\d{2}) from VPA ([A-Za-z0-9][A-Za-z0-9._-]{1,255}@[A-Za-z][A-Za-z0-9]{1,63}) \(UPI (\d{12})\)$/;

function occurredAtFromBodyDate(dayText: string, monthText: string, yearText: string, receivedAt: number): number | null {
  const receivedIndia = new Date(receivedAt + INDIA_OFFSET_MS);
  if (!Number.isFinite(receivedIndia.getTime())) return null;

  const day = Number(dayText);
  const month = Number(monthText);
  const year = Math.floor(receivedIndia.getUTCFullYear() / 100) * 100 + Number(yearText);
  const bodyDay = new Date(0);
  bodyDay.setUTCFullYear(year, month - 1, day);
  bodyDay.setUTCHours(0, 0, 0, 0);

  if (bodyDay.getUTCFullYear() !== year || bodyDay.getUTCMonth() !== month - 1 || bodyDay.getUTCDate() !== day) return null;

  const receiptDay = Date.UTC(receivedIndia.getUTCFullYear(), receivedIndia.getUTCMonth(), receivedIndia.getUTCDate());
  const bodyDayStart = bodyDay.getTime();
  if (bodyDayStart > receiptDay) return null;

  const indiaClock = receivedIndia.getTime() - receiptDay;
  return bodyDayStart - INDIA_OFFSET_MS + indiaClock;
}

function reviewLookalike(sms: NormalisedSms): RuleMatch | null {
  const candidate = genericRule.match(sms);
  return candidate ? { ...candidate, confidence: 'low' } : null;
}

export const hdfcUpiCreditRule: Rule = {
  id: 'hdfc.upi.credit',
  version: 1,
  institutions: ['hdfc'],
  match(sms) {
    const { senderInfo, text, receivedAt } = sms;
    if (senderInfo.header !== 'HDFCBK' || senderInfo.dltSuffix !== 'S') return null;
    if (!text.startsWith('Credit Alert!')) return null;
    if (FAILED.test(text)) return reviewLookalike(sms);

    const match = CREDIT_ALERT.exec(text);
    if (!match) return reviewLookalike(sms);

    const amountPaise = toPaise(match[1]!);
    const occurredAt = occurredAtFromBodyDate(match[3]!, match[4]!, match[5]!, receivedAt);
    const accountLast4 = extractLast4(text);
    const vpa = extractVpa(text);
    const upiRef = match[7]!;

    if (
      amountPaise === null || amountPaise <= 0 || occurredAt === null ||
      accountLast4 !== match[2] || vpa !== match[6]!.toLowerCase()
    ) {
      return reviewLookalike(sms);
    }

    return {
      confidence: 'high',
      txn: {
        amountPaise,
        direction: 'credit',
        kind: 'income',
        status: 'posted',
        channel: 'upi',
        institution: 'hdfc',
        accountLast4,
        counterparty: null,
        vpa,
        upiRef,
        balancePaise: null,
        occurredAt,
      },
    };
  },
};
