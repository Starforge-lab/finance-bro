# Android SMS format evidence

Track the bounded corpus for [#46](https://github.com/Starforge-lab/finance-bro/issues/46). This document records parser evidence, not automatic-import eligibility or native capture proof.

## Initial priorities

Suvo named HDFC Bank, Paytm, PhonePe and CRED as initial priorities on 2026-10-10. Support must follow verified SMS formats and sender evidence; a payment-app name alone does not identify the bank that sends an alert.

| Priority | Available evidence | Automatic-import status |
| --- | --- | --- |
| HDFC Bank | Two voluntarily supplied body shapes and three reported sender labels; exact header/body pairings unconfirmed | Not verified; no institution-specific high-confidence rule |
| Paytm | No supplied SMS corpus yet | Not verified |
| PhonePe | No supplied SMS corpus yet | Not verified |
| CRED | No supplied SMS corpus yet | Not verified |

## HDFC body shapes

On 2026-10-11, Suvo supplied a multiline card UPI alert beginning with `Txn` and an account credit alert beginning with `Credit Alert!`. The reported sender family was `VM-HDFCBK-S`, `AD-HDFCBK-S` and `JM-HDFCBK-S`. Exact original header/body pairings were not confirmed.

[The fixture file](../packages/sms-parser/fixtures/banks/hdfc/alert-shapes.json) contains fictional replacements for amounts, dates, account/card digits, VPAs, references and contact numbers. It preserves the body shapes and masked-reference syntax without retaining the supplied financial values. Its header/body combinations are test constructions.

- The card shape has no explicit debit/credit verb. It remains in review; the parser does not infer direction from `Txn` or from the merchant.
- The explicit credit shape uses the existing `generic.keyword` version 3 rule at medium confidence. The masked reference remains `null`; it is not converted into a usable UPI identity.
- Six additional cases are synthetic variants: failed credit, future notice, collect request, promotional sender suffix, unknown sender and unsafe integer paise. They are regression checks, not independently observed bank formats.

No parser rule, rule version, automatic-save policy or account-mapping behavior changes with these fixtures. A generic medium-confidence parse does not satisfy the 2.0 requirement for a verified high-confidence rule and a resolved account.

## Remaining gates

Confirm exact anonymised sender/body pairs and bank-format semantics, expand voluntarily supplied positive and negative examples, then implement focused institution rules with versioned fixtures. Measure precision and review reasons on a labelled acceptance corpus separately from synthetic regression tests. Record parser/rule versions in the native ingestion matrix.

Until that evidence exists, keep these formats outside automatic-save eligibility. Keep #46 open; passing this small fixture set is not a zero-false-positive release claim or universal HDFC coverage.
