import { hasAmount } from './extract/amount';
import { VPA } from './extract/upi';
import { matchHdfcUpiCardAlert } from './extract/hdfc-card';
import type { Classification, NormalisedSms } from './types';

const TXN_VERB =
  /\b(?:debited|credited|spent|sent|paid|received|withdrawn|deducted|charged|deposited|refunded|reversed|purchased?|added to|failed|declined)\b/i;
/** Verbs that only appear when money actually moved. Used to tell real alerts from OTPs/promos that mention a txn. */
const MONEY_MOVED = /\b(?:debited|credited|spent|withdrawn|deducted|refunded|reversed)\b/i;
export const FAILED = /\b(?:failed|declined|unsuccessful|could not be processed|not processed)\b/i;
const ALL_VPAS = new RegExp(VPA.source, 'gi');

export function hasFailureWording(text: string): boolean {
  return FAILED.test(text.replace(ALL_VPAS, ' '));
}

const FUTURE_VERB = /\bwill be (?:auto[- ]?)?(?:debited|deducted|charged|credited|reversed|refunded)\b/i;
const FUTURE_VERB_ALL = new RegExp(FUTURE_VERB.source, 'gi');
const REMINDER =
  /\bis due\b|\bdue (?:on|by|date)\b|\bamt due\b|\bamount due\b|\b(?:auto ?pay|e-?mandate|standing instruction|si)\b.{0,40}\b(?:scheduled|registered|set up|created)\b|\bupcoming\b/i;
const OTP = /\b(?:otp|one[- ]time password|verification code|passcode)\b/i;
const PROMO =
  /\b(?:pre-?approved|offers?|apply now|click here|exclusive|congratulations|limit (?:has been )?(?:increased|enhanced)|(?:cashback|loan) (?:of )?up ?to)\b/i;
const REQUEST = /\bhas requested (?:money|INR)\b|\brequested INR\b|\bcollect request\b|\bpayment request\b/i;
const BALANCE = /\b(?:bal|balance|statement)\b/i;

/**
 * Decides what kind of message this is before any rule runs.
 * Order matters: each check guards against a false positive in the next.
 */
export function classify(sms: NormalisedSms): Classification {
  const { text, senderInfo } = sms;
  const amount = hasAmount(text);
  // "will be debited" mentions a debit that hasn't happened.
  const presentTense = text.replace(FUTURE_VERB_ALL, '');
  const moneyMoved = MONEY_MOVED.test(presentTense);

  if (OTP.test(text) && !moneyMoved) return 'otp';
  if (senderInfo.dltSuffix === 'P') return 'promo';
  if (REQUEST.test(text)) return 'request';
  if (amount && hasFailureWording(text)) return 'transaction';
  if ((FUTURE_VERB.test(text) || REMINDER.test(text)) && !moneyMoved) return 'reminder';
  if (PROMO.test(text) && !moneyMoved) return 'promo';
  if (amount && (TXN_VERB.test(presentTense) || matchHdfcUpiCardAlert(sms))) return 'transaction';
  if (amount && BALANCE.test(text)) return 'balance_info';
  if (amount) return 'unknown';
  return 'other';
}
