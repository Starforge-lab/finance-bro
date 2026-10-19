/** An SMS as delivered by the platform. `receivedAt` is epoch milliseconds. */
export interface RawSms {
  sender: string;
  body: string;
  receivedAt: number;
}

/** DLT header suffix: Service, Transactional, Promotional, Government. */
export type DltSuffix = 'S' | 'T' | 'P' | 'G';

export interface SenderInfo {
  /** Header with operator prefix and suffix removed, e.g. "HDFCBK". */
  header: string;
  /** Known institution id (e.g. "hdfc"), or null when the header is not in the registry. */
  institution: string | null;
  dltSuffix: DltSuffix | null;
}

export interface NormalisedSms extends RawSms {
  /** Body with whitespace collapsed and every currency marker rewritten to "INR ". */
  text: string;
  senderInfo: SenderInfo;
}

export type Classification =
  | 'transaction'
  | 'otp'
  | 'promo'
  /** Future debits, AutoPay/mandate notices, bill-due reminders. */
  | 'reminder'
  /** UPI collect requests ("has requested money"). */
  | 'request'
  /** Balance or statement info without a money movement. */
  | 'balance_info'
  /** Mentions money but doesn't fit any known shape. Goes to the Review inbox. */
  | 'unknown'
  /** Not financial at all (personal messages, etc.). */
  | 'other';

export type Direction = 'debit' | 'credit';
export type TxnKind = 'expense' | 'income' | 'refund' | 'reversal' | 'cash_withdrawal';
export type TxnStatus = 'posted' | 'failed';
export type Channel = 'upi' | 'card' | 'netbanking' | 'imps' | 'neft' | 'rtgs' | 'atm' | 'wallet' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low';

/**
 * What the parser can tell from one SMS. Transfer pairing and dedupe across
 * messages happen later (see `matching/`), because they need more than one SMS.
 */
export interface ParsedTxn {
  amountPaise: number;
  direction: Direction;
  kind: TxnKind;
  status: TxnStatus;
  channel: Channel;
  institution: string | null;
  accountLast4: string | null;
  counterparty: string | null;
  vpa: string | null;
  upiRef: string | null;
  balancePaise: number | null;
  /** Epoch ms. A validated institutional body date with the receipt's India clock, or the SMS arrival time. */
  occurredAt: number;
}

export type ParseResult =
  | { kind: 'transaction'; txn: ParsedTxn; ruleId: string; ruleVersion: number; confidence: Exclude<Confidence, 'low'> }
  /** Looks financial but we're not sure. `candidate` pre-fills the Review inbox when available. */
  | { kind: 'review'; candidate: ParsedTxn | null; ruleId: string | null; ruleVersion: number | null }
  | { kind: 'ignored'; reason: Exclude<Classification, 'transaction' | 'unknown'> };

export interface RuleMatch {
  txn: ParsedTxn;
  confidence: Confidence;
}

export interface Rule {
  /** Stable id, e.g. "hdfc.upi.debit". Never reuse an id for a different format. */
  id: string;
  /** Bump when the rule's output changes for messages it already matched. */
  version: number;
  /** Institution ids this rule applies to. Omit for generic rules. */
  institutions?: readonly string[];
  match(sms: NormalisedSms): RuleMatch | null;
}
