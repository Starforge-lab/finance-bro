# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. Product context is in [README.md](README.md); workflow is in [CONTRIBUTING.md](CONTRIBUTING.md). This file records **decisions and conventions** — keep it current when a decision changes.

> **Status:** Expo app shell and generic SMS parser, plus the local manual-first data layer: validated entry, account/category management, transaction queries/corrections, India-month totals, budgets, bills, CSV content and keyed paste review/save. See [the v1 data contract](docs/v1-data-layer.md) for scope, rules and verification gates. Connected manual-first screens and Android/web CSV destinations are in implementation and verification. Android SMS import is the sole planned 2.0 addition and is gated on issue #16 runtime/device proof. Follow the exact Ink and Stamps references in DESIGN.md and docs/design/screens; the scrapped Quicksave name is not current branding. Rohan reviews shared work and owns all later iOS implementation and device verification.

## What we're building

A mobile-first personal expense tracker for India. USP: it reads bank / UPI / card / wallet transaction SMS on-device and logs debits and credits automatically. Users can still add, edit, delete and re-categorise anything manually. Effortless, minimal taps, no setup friction. Finance Bro is the working product name; a final name is not selected.

## Stack

- **Expo SDK 58 (beta)**, React Native 0.88 RC, TypeScript (strict), New Architecture only.
- **Development build** via `expo-dev-client` — never Expo Go (we ship custom native code).
- **Expo Router** (tabs: Home, Insights, Budgets, Settings; add/edit as modal sheets).
- **expo-sqlite + Drizzle ORM** for the local ledger, with generated migrations. The DB is the source of truth; `useLiveQuery` integration remains planned.
- Planned **Zustand** for small UI-only state. No React Query (there is no server).
- **@expo/ui** native components where mature, Reanimated + haptics for motion.
- **pnpm workspaces + Turborepo**, `node-linker=hoisted` (try isolated installs later). Turbo's auto-written `AGENTS.md` is disabled (`agentGuidance: false`); before changing Turbo config, read the docs bundled in `node_modules/turbo/docs/`, since Turbo changes between versions.
- **Vitest** for packages and **node:test + node:sqlite** for ledger persistence/migration checks. Jest + React Native Testing Library are planned for screen tests. **EAS Build** for binaries.

### Expo skills — use them, don't rely on memory

SDK 58 is newer than most training data. The official Expo plugin is enabled for this project (`.claude/settings.json` → `expo@claude-plugins-official`). Before touching Expo/RN APIs, load the relevant skill:

| Task | Skill |
|---|---|
| Local Kotlin/Swift modules, config plugins | `expo-module` |
| Dev client setup/rebuilds | `expo-dev-client` |
| SDK beta → stable, dependency bumps | `expo-upgrade` |
| Routing, stacks, modals, sheets | `expo-router` |
| Native components, styling, icons | `expo-ui`, `expo-native-ui`, `expo-design-system` |
| Gestures, animation, haptics | `expo-animation` |
| Store builds, versioning, TestFlight | `eas-app-stores`, `eas-workflows` |

We deliberately have **no project-specific skills**. Add one only when a workflow has actually repeated enough to justify it.

## Repo layout

```
apps/mobile/                     Expo app (layout per the expo-project-structure skill)
  app.config.ts, eas.json
  src/app/                       Expo Router routes ONLY; each file renders a screen
  src/screens/<name>/            Screen bodies + their private components
  src/components/                Shared UI
  src/constants/theme.ts         Design tokens: every colour/spacing value comes from here
  src/hooks/
  modules/sms-reader/            (planned) Kotlin local Expo module + config plugin
  modules/transaction-intent/    (planned) Swift App Intent + JavaScriptCore parser bundle
packages/sms-parser/             Pure TS parser, consumed as source (no build step)
  src/normalise.ts, sender.ts    Canonical text; DLT header → institution
  src/classify.ts                transaction | otp | promo | reminder | request | balance_info | unknown | other
  src/extract/                   amount, account last4, UPI ref/VPA, direction/channel/payee
  src/rules/                     generic.ts + per-institution files (rules/index.ts registry)
  src/matching/                  smsDedupeKey, isSameTransaction, isTransferPair
  fixtures/<type>/<institution>/ Anonymised samples ({ note, cases: [...] } JSON)
  test/                          fixtures.test.ts (table-driven + rule coverage), units.test.ts
packages/config/                 Shared tsconfig.base.json
packages/merchant-catalog/       (planned) merchant / UPI VPA → default category data
```

## Commands

```bash
pnpm install --frozen-lockfile
pnpm dev                       # Metro for the dev client
pnpm test                      # all tests via Turborepo
pnpm check                     # typecheck, lint and parser tests
pnpm --filter @finance-bro/sms-parser test
pnpm parser:try "<sms text>" --sender VM-HDFCBK-S   # print classification + parse result
pnpm build:android:dev         # EAS development build (APK); needs `eas login` + `eas init` once
pnpm build:ios:dev             # EAS development build (internal distribution)
pnpm --dir apps/mobile dlx expo-doctor   # dependency/config health
```

Planned: `pnpm parser:anonymise <file>`, which scrubs names, digits and VPAs from raw samples.

Dev builds use `APP_VARIANT=development` (set in `eas.json`), giving the id `com.rohangupta.financebro.dev` so a dev build and production build can be installed side by side. `com.rohangupta.financebro` is a working id and must be settled before the first F-Droid release. A shared application id across future channels is a goal; verify signing and version compatibility before promising cross-channel updates.

## Hard rules

1. **Parser is pure.** `packages/sms-parser` has no React Native, Expo, DB or `Date.now()` imports. Time and locale are passed in. Same input → same output.
2. **Money is safe integer paise** (`amountPaise: number`). Never floats. Format only at the UI edge. The parser rejects unsafe values and malformed precision/grouping; invalid transaction money stays in review without a candidate rather than falling through to a later fee. Invalid optional balances are omitted.
3. **Never hand-edit `android/` or `ios/`.** They are generated (CNG). All native config goes through config plugins in `modules/*` or `app.config.ts`.
4. **Source imports are read-only.** Never send, delete, mark-read or modify source messages. Never durably store raw SMS or notification text, including review and failure records (see Privacy). There is no notification-listener import fallback in 2.0.
5. **No network calls with user data** without explicit, opt-in consent. No analytics/ads SDKs. Crash reporting, if added, is opt-in.
6. **Every parser rule has at least one positive fixture**; CI fails otherwise. Every bug fix in parsing starts with a failing fixture.
7. **Fixtures are anonymised** before commit — no real names, account digits, VPAs, phone numbers or reference numbers.
8. **The app must be fully usable without SMS permission** (manual entry + paste). This is a store-compliance requirement, not a nice-to-have.
9. Pin exact versions while on the beta. Use `pnpm --dir apps/mobile exec expo install` for Expo-managed packages.

## Architecture decisions

### SMS parsing pipeline (`packages/sms-parser`)

```
{sender, body, receivedAt}
 → normalise       whitespace, ₹ / Rs. / INR → one token, Indian digit grouping (1,23,456.00)
 → resolveSender   "VM-HDFCBK-S" → { institution: 'hdfc', dltSuffix: 'S' }
 → classify        transaction | otp | promo | reminder | request | balance_info | unknown | other
 → institution rules for that sender, in priority order (first match wins)
 → generic.keyword rule (extractors + direction keywords)
 → ParseResult:
     { kind: 'transaction', txn, ruleId, ruleVersion, confidence: 'high' | 'medium' }
     { kind: 'review', candidate: txn | null, ruleId | null, ruleVersion | null }   → privacy-safe Review state
     { kind: 'ignored', reason }
```

- One file per institution: `rules/banks/<bank>.ts`, `rules/upi/<app>.ts`, `rules/cards/<issuer>.ts`, `rules/wallets/<wallet>.ts`, registered in `rules/index.ts`.
- A rule = `{ id, version, institutions?, match(sms) → { txn, confidence } | null }`. Reuse the extractors in `src/extract/`; don't re-implement them per rule. Institution rules built from real samples should return `high`.
- The generic rule returns `medium` only when the sender is a known institution (or the SMS has a UPI ref) **and** there is an anchor (last4 / VPA / ref). Otherwise it returns `low`, which becomes `review`.
- `occurredAt` is the SMS arrival time; dates in the message body are not parsed yet.
- Deterministic rules/regex only. **No AI/ML.** Avoid regex lookbehind; the same bundle must run in Hermes and in iOS JavaScriptCore.
- Unknown financial-looking SMS may retain extracted review fields, never the body; Android re-reads by platform id, with manual/paste recovery if the original is gone. The iOS import path is later work and must retain no raw text or durable failed-message payload.
- `fixtures/synthetic/` holds made-up messages that exercise the classifier and generic rule. They are not real bank formats; real anonymised samples go under `fixtures/<type>/<institution>/`.

### Edge cases (owned by the parser / `matching/`)

| Case | Handling |
|---|---|
| OTP, promo, "pre-approved", limit offers | `classify` → ignored. `-P` DLT suffix treated as promo (verify against real samples). |
| "Will be debited", AutoPay/mandate notices, bill due | `reminder` → ignored for now (upcoming-bills feature uses them later) |
| UPI collect requests ("has requested money") | `request` → ignored |
| Money mentioned by a person, not a bank | Low confidence → `review` |
| Failed / declined | `status: 'failed'`, excluded from totals |
| Refunds, reversals | `kind: 'refund' \| 'reversal'`, linked to the original via `linkedTxnId` (merchant + amount + window) |
| Same SMS seen twice | The current pure-parser demo helper uses cyrb53 plus a 60 s bucket; persisted import fingerprints must instead be cryptographically keyed at the import/storage boundary (see Privacy). |
| Same txn from bank + UPI app + card | `isSameTransaction`: equal UPI ref; else different institutions, same amount + direction + status, compatible last4, within ±10 min. Same-institution alerts are never merged. |
| Own-account transfers, card bill payments | `isTransferPair`: debit and credit of the same amount between two of the user's own last4s within 2 h → `kind: 'transfer'`, excluded from spend. Wallet top-ups (often no last4) still need a rule. |
| ATM withdrawal | `kind: 'cash_withdrawal'` |

### Android SMS (`modules/sms-reader`, Kotlin)

- Request READ_SMS and RECEIVE_SMS only after clear, revocable user consent. Do not add notification-listener access as an import fallback.
- Candidate native SMS_RECEIVED receiver needs device proof under #16 for process-death delivery and a safe handoff to the shared TypeScript parser/SQLite ledger; no background runtime is assumed.
- Background TypeScript parser execution and SQLite writes are unproven on this New Architecture. Issue #16 must prove the actual bounded Kotlin-to-JavaScript-to-SQLite path on device before choosing or claiming a headless runtime. Do not assume a Headless JS or WorkManager implementation. If the proof fails, keep imports unavailable and report the blocker.
- On app open, catch up from the last committed cursor in bounded batches. Explain permission before requesting it; after access is granted, preview up to 90 days and require confirmation before writing history to the ledger. Cancellation performs no import. Test process death, force-stop/reopen, installer allowlisting and OEM restrictions under #16. Advance the cursor atomically with ingestion; never queue message bodies to disk.
- The JavaScript boundary exposes permission state and bounded inbox queries by source reference. Final event/catch-up methods depend on the #16 device proof and shared ledger contract; never queue a body or persist a body-bearing event.
- Keep only the platform reference and minimal metadata. If Android can no longer reopen the original message, recover through manual entry or paste.

### iOS imports (later work; not a 2.0 gate)

- Any App Intent or Shortcuts import remains a proposal pending Rohan's real-device proof under #17.
- Rohan owns all iOS implementation and device verification. Prove message-text input, trigger coverage, shared SQLite access, concurrency and locked/background execution before treating a path as viable.
- iOS has no general SMS inbox access or historical backfill. Keep input text transient and provide manual/paste recovery. Share extension work is also later.

### Distribution (goal: main F-Droid)

Main F-Droid is the current distribution goal ([issue #27](https://github.com/Starforge-lab/finance-bro/issues/27)); its permission and clean source-build audit is a release gate separate from Android SMS runtime proof in [#16](https://github.com/Starforge-lab/finance-bro/issues/16). Later iOS feasibility is tracked in [#17](https://github.com/Starforge-lab/finance-bro/issues/17). The F-Droid target is not an existing build or authorization to sign or publish.

- F-Droid prerequisites: build from clean source without relying on EAS binaries, and audit the complete runtime and build dependency graph for free/open-source compatibility. Expo SDK 58's [`expo-notifications` Android build file](https://github.com/expo/expo/blob/main/packages/expo-notifications/android/build.gradle) includes Firebase Messaging; assess that dependency before adding the package.
- Standard F-Droid signing is the initial target. Reproducibility and verified upstream signing are only needed if shared signatures across channels become a later requirement.
- GitHub Releases and IzzyOnDroid are optional companion channels later. Google Play and the App Store are deferred; if Play is considered, assess its SMS permission policy before offering SMS import.
- Keep privacy disclosures consistent with the Privacy section and [PRODUCT.md](PRODUCT.md).

### Privacy

- All parsing on-device. No backend, no accounts, no bank linking.
- Never durably store raw SMS text, including unparsed, review, or failed messages. The parser may hold it transiently in memory. Keep message text out of queues, logs, telemetry, and crash reports.
- Android may retain a platform message reference and minimal metadata (sender, platformId, receivedAt, rule, outcome) so review can re-read the original inbox message. If it is missing, the user recovers by manual entry or paste. Any later iOS path must likewise avoid durable source text and provide manual/paste recovery.
- Persisted Android SMS fingerprints must be cryptographically keyed at the import/storage boundary using a random device secret in platform-protected storage. If the key is unavailable or lost, stop automatic matching and route affected records to explicit review; never silently generate a replacement key or auto-merge. Test this fail-safe before 2.0 imports ship. Full encrypted backup/restore is later work, not an import prerequisite. Keep secret handling out of packages/sms-parser; its current smsDedupeKey uses non-cryptographic cyrb53 and is demo logic, not a persisted security fingerprint.
- Email/receipt imports are later work; if implemented, source text stays transient and never enters durable review, logs or backups.
- Biometric app lock, hide-amounts, and user-initiated encrypted backup are later work. Nothing is uploaded by the app.
- Future backup is a user-initiated encrypted file export to a location the user picks. Nothing is uploaded by the app.

### Data model (Drizzle / SQLite)

- `accounts`: id, name, institution, type (`bank|credit_card|wallet|upi_lite|cash`), last4, isOwn, archived
- `transactions`: id, amountPaise, direction (`debit|credit`), kind (`expense|income|transfer|refund|reversal|cash_withdrawal`), status (`posted|failed|pending`), accountId, counterparty, merchantId, categoryId, occurredAt, note, source (`sms|manual|ios_intent|paste`), smsRefId, upiRef, dedupeKey, linkedTxnId, excludeFromStats, userEdited, createdAt, updatedAt, deletedAt
  - `userEdited = true` → never overwritten by re-parsing. `deletedAt` = soft delete (undo, and blocks re-import).
- Planned sms_refs: id, platformId, sender, keyed body fingerprint, receivedAt, parseStatus (parsed|ignored|unknown|failed), ruleId, ruleVersion. Store no raw body; prove the runtime in #16 and coordinate the Android import schema in #43.
- `categories`: id, name, icon, color, parentId, kind (`expense|income`), isSystem, sortOrder
- `merchants`: id, displayName, aliases, vpaPatterns, defaultCategoryId
- `category_overrides`: matchType (`merchant|vpa|counterparty`), value, categoryId — learned from user re-categorisation
- Later: recurring_series

Every schema change ships a Drizzle migration, tested against a seeded DB.

## UX direction

The visual system is **"Ink and Stamps"** (C2 light, C3 dark), documented in [DESIGN.md](DESIGN.md) with tokens in `apps/mobile/src/constants/theme.ts`. Read DESIGN.md before building any screen. In short: ink outlines on paper, money in Space Mono, colour only in small category stamps plus one rationed highlighter yellow, ink-only charts, and red only for over-budget or destructive actions (not for ordinary debits).

Behaviour was originally inspired by [Sushi](https://github.com/jerameel/sushi) (inspiration, not a template):
- A date-grouped transaction feed, one primary "new transaction" action, light + dark themes.
- Where we go further: auto-logged entries with one-tap category fix, number-pad-first manual add (~3 s), a Review inbox, and insights that state facts ("Food is 32% higher than last month") rather than chart walls.

## Scope

Follow [the manual-first roadmap](docs/mvp-roadmap.md) for delivery order and [PRODUCT.md](PRODUCT.md) for confirmed scope. Native import experiments do not block the usable manual-first MVP.

Version 2.0 is limited to opt-in automatic Android SMS import. Follow [the 2.0 roadmap](docs/v2-roadmap.md) and issue #16 for its device-proven runtime and shared-ledger contract. Preserve the manual-first app, bounded catch-up, cancellable 90-day history preview, correction protection, keyed deduplication, fail-safe key-loss review and no durable message bodies. Do not add a notification-listener fallback. Suvo owns Android/shared integration; Rohan independently reviews shared work and owns design and all later iOS work. The F-Droid permission/source-build gate stays separate under #27; this scope grants no signing or publication authorization.

The core finance workflows include expenses/income, budgets and bills; see PRODUCT.md. Manual entry and paste review are current. Receipt OCR, connected email and iOS imports remain later entry paths, outside 2.0. The shared local business layer exists; connected screens are under verification. PRODUCT.md and roadmap issue #7 define the manual-first v1.

- **v1 (manual-first core):** validated manual expenses/income; local accounts/categories; month feed, recorded cash-flow totals and category breakdown; protected edits and soft deletion; transient paste-to-review import with keyed deduplication and fail-safe key-loss review; monthly category budgets; due/paid bill records; user-initiated CSV export. Shared Expo SQLite contract on Android/iOS/web.
- **2.0:** automatic Android SMS capture and bounded catch-up/backfill under #16. This is the only 2.0 capability; opt-in permissions, cancellable 90-day preview, atomic cursor/ingestion, protected edits/tombstones, keyed deduplication and no durable source text are required. Prove the actual background TypeScript parser/SQLite path before selecting an implementation.
- **Later backlog:** iOS imports (#17), receipt OCR, connected Gmail, encrypted backup/recovery, reconciliation/opening balances, recurring planning, explainable insights and forecasts, widgets, merchant learning, search/filters, tags, split entries, custom category trees, and distribution variants.

- **Out of scope:** user accounts, backend sync, Account Aggregator / bank linking, AI/ML, investments, bill-splitting with friends, multi-currency, ads.
## Known risks

- SDK 58 beta / RN 0.88 RC: third-party lag (Drizzle expo-sqlite driver, Reanimated, @expo/ui), EAS image changes. Android background TypeScript/SQLite execution under #16 and the later iOS App Intent flow remain unverified.
- Bank SMS formats change without notice → Review inbox + fixture-driven rules.
- iOS: verify the complete Shortcuts-to-ledger flow on a real device in #17.

## Git

- Commits are authored by the repo owner's git identity. **Do not add `Co-Authored-By` or any AI attribution lines** to commits or PRs.
- Conventional Commits (`feat(parser): …`, `fix(android): …`). See CONTRIBUTING.md.
