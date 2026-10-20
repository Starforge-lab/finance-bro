# Android SMS format evidence

Track the bounded parser corpus for [#46](https://github.com/Starforge-lab/finance-bro/issues/46). This records observed message shapes and parser checks; a rule match does not establish automatic-save eligibility, account resolution or native capture proof.

## Current preview coverage — 19 October 2026

Only `hdfc.upi.credit@2` is eligible for automatic saving. It still requires the exact posted HDFCBK-S credit format, safe money, a strong UPI identity and exactly one matching active HDFC bank account. The strict HDFC card-UPI `Txn` format now has a separate medium-confidence debit candidate (`hdfc.upi.card.debit@1`) requiring explicit review; it is not on the automatic-save allowlist. Its body omits the year, so the candidate retains SMS arrival time for date review. Masked and malformed variants are not promoted to this rule.

Other bank/app messages may receive a generic review candidate when amount and direction can be extracted; sender recognition alone does not establish format support. There are no provider-specific rules for the other [popular-provider priorities](friends-preview.md#coverage-priorities). Unsupported transaction-looking messages can remain in review without a prefilled candidate. Known non-transaction categories are intentionally ignored.

The current suite passes 155 parser tests and 323 mobile tests. The new [card corpus](../packages/sms-parser/fixtures/banks/hdfc/card-upi-review.json) contains 13 fictional positive/negative cases; an ingestion regression proves the card stays in review with zero automatic transactions. The frozen 53-case credit corpus remains unchanged. The dated v1 results below are historical evidence, not the current allowlist version or proof of live/background delivery.

## Initial priorities

Suvo named HDFC Bank, Paytm, PhonePe and CRED as initial priorities on 2026-10-10. A payment-app name alone does not identify the institution that sends an alert.

| Priority | Available evidence | Parser status |
| --- | --- | --- |
| HDFC Bank | Two user-supplied body shapes; HDFCBK-S sender family confirmed on 2026-10-15, with VM-, AD- and JM- labels reported. Individual prefix/body pairings were not asserted. | Current credit rule v2 can qualify for auto-save with one matching active bank account. The strict unmasked card-UPI rule supplies a review-only candidate. Live/background acceptance remains open. |
| Paytm | No supplied SMS corpus yet | Not verified |
| PhonePe | No supplied SMS corpus yet | Not verified |
| CRED | No supplied SMS corpus yet | Not verified |

## HDFC body shapes

Suvo supplied a multiline card UPI alert beginning with `Txn` and an account credit alert beginning with `Credit Alert!` on 2026-10-11. On 2026-10-15, Suvo confirmed that both came from the HDFCBK-S sender family. The reported VM-, AD- and JM- prefixes are not tied to either individual body.

[The fixture file](../packages/sms-parser/fixtures/banks/hdfc/alert-shapes.json) replaces all financial and contact values with fictional data. Suvo had masked the final four characters of the shared credit UPI reference; no original reference is retained, and the positive fixture uses a wholly fictional 12-digit reference. The credit fixture's AD-prefixed sender is a construction within the confirmed family, not a confirmed original pairing.

- The original masked card shape has no explicit debit or credit verb and remains outside the card rule. The separately verified strict unmasked `Txn ... by UPI ... Not You? ... SMS BLOCK CC` shape now prefills a debit/expense at medium confidence; explicit review is required. A bare `Txn`, card name or merchant is insufficient.
- The credit rule matches only the anchored posted shape: `Credit Alert!`, a positive safe amount, HDFC account with four visible digits, a valid `DD-MM-YY` date, a VPA and a full 12-digit UPI reference, sent from the resolved HDFCBK-S family. It currently emits `hdfc.upi.credit` version 2 at high confidence.
- The body date supplies the India calendar day. The parser resolves `YY` in the receipt's India-year century, keeps the India receipt time-of-day, and sends impossible or future body dates to review. The retained clock is the SMS receipt clock, not a bank-reported transaction time.
- Receipt timestamps must be safe integer milliseconds within the supported date range, including the India offset; malformed runtime values stay in review. Telecom route prefixes are normalized by the existing sender resolver; the rule checks the HDFCBK header and service suffix rather than an exhaustive carrier-prefix list.
- Failed or incomplete credit lookalikes from that sender family receive low-confidence review when there is a usable candidate; invalid or unsafe amounts without a candidate remain in review. OTPs, future-tense or AutoPay reminders, collect requests and promotional DLT messages are ignored by the existing classifier. Unknown senders and non-service suffixes never use the HDFC high-confidence rule.

## Historical bounded fixture results — 16 October 2026

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

The parser corpus alone does not establish account-to-ledger behavior. Separate ingestion regressions at `3c47508` enable exactly `hdfc.upi.credit@1` in the draft Android implementation: canonical HDFC and normal `HDFC Bank` names resolve only to one active bank account with the matching suffix. Multiple matching banks, archived accounts, unknown institutions and card-only matches stay in review. Nine focused tests cover exact persisted transaction fields, replay, protected edits, tombstones, paste overlap and inconsistent or ambiguous evidence; all 200 mobile tests passed at that integration stage. No persisted account names are rewritten. These are source/SQLite tests, not matching-device automatic-import proof. Issue #46 stays open for native acceptance and the other priority senders; Paytm, PhonePe and CRED are not enabled.

That parser test run passed 134 tests, including the 49 legacy fixture cases, one rule-coverage assertion and all 53 independent acceptance cases. The historical 79-case fictional mutation check was a development probe; it is not part of this labelled corpus or an automatic-save test.

### Node SQLite corpus ingestion run

The 53 independently labelled acceptance cases also ran through `createDataLayer.importSmsBatch`, each against a fresh in-memory Node `node:sqlite` ledger with a fictional HDFC Bank account seeded from the body suffix (and any distinct parser-extracted suffix). The frozen outcomes are six saves, 39 reviews and eight ignored messages: all six positives saved one transaction with the expected paise amount, credit direction, India occurrence time, `hdfc.upi.credit@1`, UPI reference and account mapping; each negative saved no transaction and matched its review/ignored disposition. Each review has a valid nonempty reason, but the corpus does not freeze individual reason codes because those depend on the candidate and identity successfully extracted; targeted tests cover specific reason behavior. Replaying every source left transaction and reference counts unchanged, and persisted SMS references contained no raw body or sender. A separate regression confirms identical credit economics with distinct UPI references and platform IDs create two transactions. These are Node SQLite tests; they do not exercise Expo SQLite, Android SMS access, background capture or a matching device. Native acceptance remains open.

### Android Expo SQLite corpus ingestion run

On 2026-10-16, the matching isolated Android build at `5e0986f` passed the same
53 fictional cases through production ingestion, Expo SQLite and platform-backed
fingerprinting: six saved, 39 reviewed and eight ignored. Replay preserved six
transactions and 45 references, reporting 45 duplicates and eight ignored.
Saved field/provenance assertions, unchanged key checks, no raw body/sender
columns and temporary database cleanup all passed. Native import consent
remained off and no real inbox was read. See the [APK and run evidence](android-sms-flow.md).
Native provider access, receiver delivery and background lifecycle remain open;
this pass covers foreground fictional import/storage only.
