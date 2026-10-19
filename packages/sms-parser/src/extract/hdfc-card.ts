import type { NormalisedSms } from '../types';

const CARD_UPI = /^Txn INR ([\d,.]+) On HDFC Bank Card (\d{4}) At (.{1,256}?) by UPI (\d{12}) On (\d{2})-(\d{2}) Not You\? Call \d{10,11}\/SMS BLOCK CC \2 to \d{10}$/;

export function matchHdfcUpiCardAlert(sms: NormalisedSms): RegExpExecArray | null {
  if (sms.senderInfo.header !== 'HDFCBK' || sms.senderInfo.dltSuffix !== 'S') return null;
  return CARD_UPI.exec(sms.text);
}
