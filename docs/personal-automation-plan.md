# Personal automation: outcome and acceptance contract

Confirmed direction: 2026-10-17. This document records the next product outcome,
not implemented capability or release readiness. The existing Android SMS-only
[2.0 milestone](v2-roadmap.md) remains the immediate delivery milestone. This
contract prioritises subsequent work already tracked in the backlog; it does
not silently add that work to 2.0.

## Outcome

After one-time setup, the app captures supported financial activity locally and
answers three everyday questions with minimal upkeep:

1. How much can I spend until my next salary?
2. Where did my money go, and where am I overspending?
3. What payments are coming up, and is money reserved for them?

Occasional review of uncertain transactions is acceptable. Automatic capture,
categorisation and payment matching must preserve explicit user corrections.
Raw personal messages, account identifiers, balances and salary details belong
in the consenting user's local setup, never in repository examples or issues.

## Capability map and delivery order

These are responsibilities within the existing app, not new packages/services.

| Capability | Responsibility | Depends on | Existing tracker |
| --- | --- | --- | --- |
| sms-capture | Consent, bounded history, verified parsing, review, capture health | Existing ledger | #16, #43, #44, #46, #56, #58 |
| reconciled-ledger | Dated balances, liabilities, own transfers and card repayments | sms-capture integration contract | #47 |
| merchant-rules | Explicit local rules for future categorisation | sms-capture correction contract | #76 |
| payment-planning | Confirmed salary/bill schedules and actual-payment matching | reconciled-ledger | #48 |
| spending-answers | Explainable overspending and spend-until-salary estimates | reconciled-ledger, payment-planning | #49, #50 |
| recovery | Encrypted full backup and atomic restore | Existing ledger and protected import-key contract | #42 |

Finish Android import acceptance first. Then establish balances, liabilities and
payment planning before enabling spend-until-salary claims. Merchant rules can
follow the stable correction contract. Recovery is required before recommending
the app as a sole financial record; CSV does not satisfy recovery acceptance.
Reuse these issues and existing modules rather than creating a parallel roadmap.

## Acceptance gates

### Capture and low-effort review

- Verify the actual supported bank debit/credit, salary, card purchase,
  repayment, refund and UPI alert formats with anonymised positive/negative
  fixtures. An alert arriving does not establish parser coverage.
- Enable automatic saves only for verified formats, exact safe-integer paise
  and an unambiguous account. Keep unsupported/ambiguous activity in review.
- Treat a UPI app as a payment channel; do not invent a separate funded account
  or require its own import when the linked bank alert describes the payment.
- Replaying alerts preserves one accepted transaction, protected edits and
  deletion markers. Two genuine identical purchases both remain.
- Capture health exposes last successful catch-up, pending reviews, denied
  permissions and recovery actions. Missing source access cannot look complete.
- Exercise single/multipart delivery, background scheduling, reopen after
  force-stop, reboot/unlock, permission revocation and unavailable keys on the
  exact supported Android build. Document platform limits rather than promising
  always-on delivery. Manual/paste entry remains usable without SMS access.

### Correct money and card obligations

- Use dated, user-confirmed balances and checkpoints. Separate liquid assets,
  credit limits and credit-card liabilities; available credit is not spendable
  cash. Incomplete alert history cannot establish a bank balance.
- A card purchase counts as spending once. Its later repayment settles a
  liability rather than becoming a second expense. Own-account transfers do not
  become income/expense. Fees remain separately attributable expenses.
- Account for partial repayments, refunds/reversals, overlapping card cycles,
  cross-month settlement, delayed alerts and missing transfer counterparts.
  Uncertain links require confirmation rather than amount-only matching.
- Distinguish current outstanding, statement due and minimum due. Never assume
  a billing cycle, shared card limit, full-payment habit or paid status.
- Preserve exact integer-paise arithmetic, including aggregate overflow checks,
  and test seeded migrations against existing data.

### Useful answers

- The first view prioritises the three confirmed questions. Keep calculation
  details accessible on demand and preserve the approved Ink and Stamps design.
- Upcoming payments distinguish expected obligations from posted transactions.
  Matching a payment cannot create another expense or reserve money twice.
- Safe-to-spend has an explicit horizon ending at the confirmed next salary
  date. Show its inputs, reserves, obligations and balance freshness. If a
  required input or material account coverage is missing, request it and show
  the limitation instead of a trustworthy-looking spendable amount.
- Agree the exact equation before implementation, including which card
  liabilities and flexible spending are reserved. The same obligation must not
  be subtracted both as a liability and as a scheduled payment.
- Keep projected total assets, remaining income and safe-to-spend distinct.
  Label negative headroom as a shortfall, not zero or an available allowance.
- Overspending names its baseline, period and supporting transactions. Compare
  equivalent periods; incomplete current months must not be compared naively
  with complete months. Without sufficient history/budgets, say what is missing.
- Category corrections remain local. Saving a reusable merchant rule requires
  an explicit action and visible scope; it cannot override protected entries.

### Reliability, privacy and recovery

- Never durably retain raw message text, including review/failed inputs, and
  never send personal financial data to a service without explicit opt-in.
- Exercise interruption/retry, concurrent manual writes/imports, source
  disappearance and key loss. No partial writes, silent skips or replacement
  fingerprint keys that bypass duplicate review.
- Verify light/dark mode, large text, reduced motion, TalkBack, keyboard access
  and recoverable errors in affected flows using fictional data.
- Measure first import, replay and foreground responsiveness with 10k/50k-row
  ledgers and record device, build mode, timings and limitations. Set numerical
  performance budgets before claiming that acceptance passes.
- Encrypted backup/restore must preserve records, corrections, schedules and
  protected matching identity safely. Wrong password, corruption or interrupted
  restore must not replace the working ledger. Reuse #42's crypto feasibility
  work; do not invent a cryptographic format or call CSV a backup.
- No release-readiness claim until the applicable gates pass at the actual
  revision. Independent review and the separate F-Droid distribution gates remain.

## Inputs still needed before dependent implementation

The user accepted one-time setup. Collect these privately when their feature
needs them; do not block independent fictional-data verification on them:

- Account/card mapping and dated opening balances or checkpoints.
- Salary amount, expected date, irregularity and desired reserve.
- Regular bills, amounts, due dates and already-paid status.
- Each card's statement/due dates, payment practice, current statement due and
  outstanding balance; whether cards share a limit or statement.
- Any material cash, savings or obligations outside the captured accounts.
- The agreed overspending baseline and forecast/reservation policy.
- Anonymised format evidence before enabling additional automatic-save rules.

## Verification and boundaries

Follow [CONTRIBUTING.md](../CONTRIBUTING.md), [AGENTS.md](../AGENTS.md) and the
scripts in package.json. For implementation, run frozen install, `pnpm check`,
the frozen Expo compatibility check, Expo Doctor and `pnpm build`, plus affected
browser/device flows. Tests must cover failure cases and money invariants; do
not weaken checks, skip failures or infer native acceptance from bundle export.
Documentation-only work needs link/scope review and whitespace validation.

Keep the shared Expo SQLite contract and deterministic parser. Prefer existing
helpers and modules; freeze routine SDK/native dependency updates through 2.0
acceptance. No backend, accounts, cloud AI, Gmail, receipt OCR, iOS implementation,
investments or bank linking is added by this contract. Account connections,
real-message access, signing, paid services and publication still require their
own specific consent. Broad implementation discretion is not data-access consent.

## Evidence status

This is a requirements record only. No additional parser format, ledger behavior,
forecast, recovery path or device acceptance was implemented or verified while
writing it. Track observed evidence in the existing owning issues and PRs.
