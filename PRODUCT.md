# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

A pnpm 12.9.1 and Turborepo monorepo with Expo SDK 58.0.8, React Native 0.88.0-rc.4, TypeScript 6.0.3, and an Expo Router app for Android, iOS, and web. The mobile app is in `apps/mobile/`; the pure TypeScript SMS parser is in `packages/sms-parser/`. ESLint 9.39.5 is the current Expo-tooling-compatible major.

## Users

Primarily for Suvo's personal finances, with friends as additional users. Suvo and Rohan maintain the repository together. Version 2.0 keeps records private to each local ledger. Open-source distribution uses [Apache-2.0](LICENSE), and main F-Droid is the confirmed target; source-build eligibility and publication remain unproven. Distribution and privacy decisions are tracked in [issue #25](https://github.com/Starforge-lab/finance-bro/issues/25).

## Product Purpose

Help people in India track personal expenses and income, manage budgets and bills, and reduce manual transaction entry. English is the initial language. INR is the maintainer-selected default based on the region; multi-currency support is undecided.

A core goal is to help users who are tired after a day's work and feeling lazy open the app without feeling overwhelmed, understand their finances, see where they are overspending, and get an idea of how much they will have at the end of the month. Everyday understanding should require little effort or financial analysis from the user.

## Operating Context

Mobile use is primary, with Android, iOS, and web support. Suvo can test on a Motorola Edge 60 Pro; Rohan has an iPhone. The user asked to settle visual directions before implementing custom finance screens. Connected manual-first screens are under verification; iOS implementation and physical-device verification belong to Rohan.

## Capabilities and Constraints

On 2026-10-19, Suvo requested a standalone Android APK for friends by 20 October, 23:00 IST, with SMS integration as the hero feature. This preview keeps imports experimental and opt-in, puts setup/review first, and targets popular Indian bank/card/UPI alert formats without claiming universal coverage. It uses a separate preview app identity and ledger. The stable 2.0 device and release gates remain open; see [friends preview](docs/friends-preview.md).

Delivery follows [the approved manual-first roadmap](docs/mvp-roadmap.md): ledger and everyday finance workflows first, with native imports validated separately.

On 2026-10-17, Suvo confirmed the broader personal-use outcome: automatic tracking with one-time setup and occasional review, answering safe-to-spend until salary, spending/overspending, and upcoming payments with money reserved. The [personal automation acceptance contract](docs/personal-automation-plan.md) maps this outcome to existing capture, reconciliation, planning, insights, categorisation and recovery work. On 2026-10-18, full current credit-card outstanding was confirmed as the reserve policy. The draft implementation adds dated balance reconciliation, monthly payment schedules, private salary/reserve setup and an explained allowance; expected salary is excluded and incomplete inputs withhold the estimate. Android SMS-only 2.0 remains the immediate milestone. The broader outcome, native acceptance, transfer matching and encrypted recovery remain incomplete; private setup amounts are still needed.

On 2026-10-14, Suvo chose to freeze the tested Expo SDK/native dependency graph for 2.0 at Expo 58.0.8 and React Native 0.88.0-rc.4 until Android SMS 2.0 acceptance. Security fixes and necessary bug fixes are explicit, separately reviewed exceptions; routine SDK/native patch updates are deferred. This preserves the current tested baseline and does not establish new native or device acceptance evidence.

On 2026-10-10, Suvo narrowed Version 2.0 to one capability: opt-in automatic Android SMS import. It must use the shared parser and local ledger, preserve corrections and keyed deduplication, process inbox history in bounded batches, and never persist message bodies. Any 90-day history import starts with a cancellable preview. Background TypeScript parsing and SQLite writes must be proven on Android under [issue #16](https://github.com/Starforge-lab/finance-bro/issues/16). iOS imports, Gmail, receipt OCR, encrypted backup/recovery, reconciliation, planning/forecasts, and widgets are later work, not 2.0 gates. Suvo owns Android/shared integration; Rohan independently reviews shared work and owns design and all later iOS work. See [the 2.0 roadmap](docs/v2-roadmap.md).

- Confirmed finance workflows are expenses and income, budgets, and bills. Manual entry and paste review are current entry paths; automatic Android SMS import is the only new input source selected for 2.0. Receipt scanning/OCR, connected email, and iOS imports are later work.
- Confirmed desired outcomes, not yet implemented: an easy-to-understand financial overview, identification of overspending, and month-end money estimates. The current direction is to show both projected total available account balance and money left from this month's income, clearly distinguished. The overspending baseline, calculation rules and required inputs remain to be agreed; do not assume complete account balances or income/bill schedules are available.
- Current implementation: connected Home, manual-entry/edit/delete, paste review/save, Budgets/Bills, Insights and Settings screens use the shared local data API. Account/category management and CSV destinations are connected. New entries require only an amount; date defaults to today and category/account/note stay behind Add details. More controls, the full entry list, deeper insights and calculation explanations are collapsed by default. Android SMS foreground consent, preview, catch-up and review are implemented in source but remain pending matching native/UI verification; receiver processing and background delivery are incomplete (see docs/android-sms-flow.md); iOS import, receipt OCR, email and encrypted backup are later work. A connected screen is not evidence that every platform flow passes; see [UI validation](docs/v1-ui.md) and [the v1 data contract](docs/v1-data-layer.md).
- Current architecture direction: local-only financial data with no app accounts or hosted backend. The shared ledger and Android/web CSV destinations are implemented. Version 2.0 adds only Android SMS import; Gmail and other providers are later work. Import-specific key-loss handling must fail safely into explicit review: never silently create a replacement fingerprint key or auto-merge records. Full encrypted backup/restore is later work and is not a prerequisite for SMS ingestion.
- One upstream Worklets peer-range warning remains under review, tracked in [issue #3](https://github.com/Starforge-lab/finance-bro/issues/3), despite the Expo install check and Expo Doctor passing.
- Android SMS access requires explicit, revocable consent for READ_SMS and RECEIVE_SMS, a cancellable preview before any 90-day history import, bounded catch-up, and installer/real-device proof. The background TypeScript parser-to-SQLite path is unproven and must pass issue #16; do not assume a headless runtime. iOS imports are later work and require Rohan's real-device proof before implementation claims; they are not a 2.0 gate. See [the platform research](docs/research/2026-10-09-v2-platform-feasibility.md).
- There is no notification-listener fallback for SMS import. F-Droid permission and source-build eligibility remain a separate release gate under [issue #27](https://github.com/Starforge-lab/finance-bro/issues/27); that gate does not authorize signing or publication.
- Receipt OCR and connected email are later work. If pursued, keep source content transient and review extracted money before save. SMS and future provider content must never enter durable review records or logs; financial examples remain fictional/anonymized.
- Finance Bro remains the working product name. Open-source distribution uses [Apache-2.0](LICENSE).
- Never persist raw SMS text, including unreadable messages. Android review re-reads the original inbox message; if it is missing, require manual entry or paste. Persisted fingerprints must use a cryptographic key in platform-protected storage. If that key is lost, stop automatic matching and send affected imports to explicit review; never silently regenerate the key or auto-merge records. This import-specific fail-safe must be tested for 2.0; full encrypted backup/restore is later work. These are requirements, not existing capabilities.
- Main F-Droid is the current distribution goal. It requires a clean source build and compatible free/open-source dependencies, including transitive dependencies. GitHub Releases/IzzyOnDroid are optional later companion channels; Google Play/App Store and a full/play build split are deferred. Standard F-Droid signing is sufficient for the current goal; reproducibility and verified upstream signing become gates if shared signatures across channels are required later. Publication, signing setup and paid services require explicit authorization; this target does not authorize release. See [F-Droid inclusion](https://f-droid.org/en/docs/Inclusion_Policy/) and [upstream signing](https://f-droid.org/en/docs/Reproducible_Builds/).

## Evidence on Hand

The [personal-finance benchmark research](docs/research/2026-10-07-personal-finance-benchmarks.md) compares commercial and open-source apps, separates documented capabilities from anecdotal shortcomings, and maps lessons to existing development issues. Use it when a feature decision needs this evidence; proposals do not change confirmed scope and competitor popularity does not prove Finance Bro outcomes.

Backend migration, persistence, validation and protected paste-save evidence is recorded separately in [Android ledger validation](docs/android-ledger-validation.md) and [the v1 data contract](docs/v1-data-layer.md). Those results do not prove the connected screens.

On 2026-10-08, the connected Motorola Edge 60 Pro running Android 17 rendered the simplified Home, Budgets, Insights and Settings with an isolated fictional ledger. Add opened with the decimal keyboard; a ₹12.34 expense saved without optional details and increased monthly spending from ₹7,598.00 to ₹7,610.34. Save remained above the keyboard after the Android layout fix. More insights revealed the six-month chart. Further UI flows and iOS remain pending; see [UI validation](docs/v1-ui.md). Current CI belongs to the exact PR revision.

## Product Principles

- Deliver 2.0 as reliable, opt-in Android SMS imports. Preserve the manual-first core, exact money, protected corrections, safe deduplication, clear failure states and local privacy. Verify platform behavior before capability claims.
- Approved visual baseline: Rohan's Ink and Stamps system in [PR #33](https://github.com/Starforge-lab/finance-bro/pull/33). Follow Rohan's exact screen compositions, components, typography, colors and spacing. The 2026-10-07 correction rejects an independent reinterpretation; changes must preserve the reference design, with truthful manual-first data and the retired Quicksave branding removed. Build the future-tech feel through polished motion, purposeful haptics and fast feedback; respect reduced-motion preferences. Mockups guide the connected screens; fictional mockup numbers and unsupported projections must never become product claims.
- Design for low energy and limited attention: the user explicitly requests minimal text, minimal overwhelm and minimal friction. First glance must explain the purpose. Prioritize open, understand spending, Add, amount, Save. Optional details and management controls stay behind a tap; retain validation and recoverable errors.
- Explain overspending and estimates in plain language. Distinguish recorded facts from projections and make missing data or assumptions clear.
- Keep everyday expense, income, budget, and bill workflows in the initial product scope.
- Preserve manual entry alongside automated imports so users can record transactions without granting message access.
- Build the local ledger and approved manual workflows first, then paste review/save, budgets, bills and export; validate automatic imports separately.
- Keep financial records local and avoid app accounts or a hosted backend in the current architecture.
- Treat SMS, email, and receipt contents as sensitive and obtain clear consent for imports.
- Describe implemented behavior and platform limits plainly.
