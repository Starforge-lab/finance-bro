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

The existing `banks/hdfc/alert-shapes.json` file remains a 23-case format fixture: it contains the two supplied body shapes, two synthetic valid-date positives and 19 synthetic boundary cases. Across all pre-existing parser fixture files, there are 49 labelled cases plus one rule-coverage assertion (50 tests total).

The independent `acceptance/hdfc-credit-v1.json` corpus has 53 labelled cases: one user-observed credit body shape and 52 synthetic cases. The observed label applies to the message shape only; all financial and contact values are fictional, the masked source reference was replaced with a fictional 12-digit reference, and the `AD-` route pairing is constructed rather than observed. The other five exact-shape positives and all 47 exclusions are synthetic.

The unchanged parser returned these outcomes on that corpus:

| Rule or stage | `hdfc-high` label matches (TP) | `not-hdfc-high` label matches (FP) | Medium transactions | Review | Ignored |
| --- | ---: | ---: | ---: | ---: | ---: |
| `hdfc.upi.credit` | 6 | 0 | 0 | 27 | 0 |
| `generic.keyword` | 0 | 0 | 3 | 2 | 0 |
| No rule candidate | 0 | 0 | 0 | 7 | 0 |
| Classifier before rules | — | — | — | — | 8 |

The eight classifier-ignored cases are one OTP, one promotional sender, two collect requests, three reminders and one non-financial negative-amount message. All 47 `not-hdfc-high` labels avoided a high-confidence HDFC match. The three generic medium transactions remain separately labelled as excluded fallback results. Zero false positives applies only to this bounded corpus and this parser revision; it does not establish general bank precision or automatic-save safety.

Money checks passed for all six `hdfc-high` results: each was posted with a positive safe-integer-paise amount, including the maximum safe integer paise value. Malformed precision, an unsafe amount, zero, negative and ambiguous amounts did not receive high-confidence HDFC output. The valid leap-day and year-rollover cases retained the expected India receipt clock; all five impossible, future or malformed date cases avoided high-confidence output.

Account mapping remains unaccepted: the parser extracts a masked account suffix, but this corpus does not map it to a ledger account. The import whitelist remains empty, and no production eligibility behavior changed. This corpus does not test native capture or real inbox messages. Issue #46 remains open for account mapping, the other priority senders and the remaining ingestion evidence.

The parser test run now passes 134 tests, including the 49 legacy fixture cases, one rule-coverage assertion and all 53 independent acceptance cases. The historical 79-case fictional mutation check was a development probe; it is not part of this labelled corpus or an automatic-save test.
