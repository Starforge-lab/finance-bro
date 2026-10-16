# Android SMS format evidence

Track the bounded parser corpus for [#46](https://github.com/Starforge-lab/finance-bro/issues/46). This records observed message shapes and parser checks; a rule match does not establish automatic-save eligibility, account resolution or native capture proof.

## Initial priorities

Suvo named HDFC Bank, Paytm, PhonePe and CRED as initial priorities on 2026-10-10. A payment-app name alone does not identify the institution that sends an alert.

| Priority | Available evidence | Parser status |
| --- | --- | --- |
| HDFC Bank | Two user-supplied body shapes; HDFCBK-S sender family confirmed on 2026-10-15, with VM-, AD- and JM- labels reported. Individual prefix/body pairings were not asserted. | Version 1 high-confidence rule for the exact posted credit body below. Account mapping and auto-save eligibility remain separate gates. |
| Paytm | No supplied SMS corpus yet | Not verified |
| PhonePe | No supplied SMS corpus yet | Not verified |
| CRED | No supplied SMS corpus yet | Not verified |

## HDFC body shapes

Suvo supplied a multiline card UPI alert beginning with `Txn` and an account credit alert beginning with `Credit Alert!` on 2026-10-11. On 2026-10-15, Suvo confirmed that both came from the HDFCBK-S sender family. The reported VM-, AD- and JM- prefixes are not tied to either individual body.

[The fixture file](../packages/sms-parser/fixtures/banks/hdfc/alert-shapes.json) replaces all financial and contact values with fictional data. Suvo had masked the final four characters of the shared credit UPI reference; no original reference is retained, and the positive fixture uses a wholly fictional 12-digit reference. The credit fixture's AD-prefixed sender is a construction within the confirmed family, not a confirmed original pairing.

- The card shape has no explicit debit or credit verb. It stays in review; the parser does not infer direction from `Txn`, a card name or the merchant.
- The credit rule matches only the anchored posted shape: `Credit Alert!`, a positive safe amount, HDFC account with four visible digits, a valid `DD-MM-YY` date, a VPA and a full 12-digit UPI reference, sent from the resolved HDFCBK-S family. It emits `hdfc.upi.credit` version 1 at high confidence.
- The body date supplies the India calendar day. The parser resolves `YY` in the receipt's India-year century, keeps the India receipt time-of-day, and sends impossible or future body dates to review. The retained clock is the SMS receipt clock, not a bank-reported transaction time.
- Receipt timestamps must be safe integer milliseconds within the supported date range, including the India offset; malformed runtime values stay in review. Telecom route prefixes are normalized by the existing sender resolver; the rule checks the HDFCBK header and service suffix rather than an exhaustive carrier-prefix list.
- Failed or incomplete credit lookalikes from that sender family receive low-confidence review when there is a usable candidate; invalid or unsafe amounts without a candidate remain in review. OTPs, future-tense or AutoPay reminders, collect requests and promotional DLT messages are ignored by the existing classifier. Unknown senders and non-service suffixes never use the HDFC high-confidence rule.

## Bounded fixture results

The labelled file currently has 23 cases: one observed credit shape and one observed card shape, two synthetic valid-date positives, and 19 synthetic boundary cases. All 50 parser fixture tests pass. The three HDFC high-confidence matches consist of the one observed credit body shape plus two constructed date cases; none of the 20 non-rule-positive cases matches the HDFC rule at high confidence. Those cases produce 14 review results, five classifier-ignored results and one generic medium-confidence result for a non-service suffix.

These counts describe only this small fixture set. They do not establish zero false positives, broad HDFC coverage or automatic-save safety. Keep adding independently labelled, anonymised examples before broadening the rule or claiming corpus-level precision. #46 remains open for the other priority senders and the remaining import gates.

The parser suite also passes 30 unit tests, including 13 malformed receipt-timestamp cases. A separate 79-case fictional mutation check found the expected 22 HDFC high-confidence matches and no unexpected matches; it was a development probe, not a retained acceptance corpus or native auto-save test.
