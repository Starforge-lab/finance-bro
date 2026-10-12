# Contributing

Thanks for helping. Read [CLAUDE.md](CLAUDE.md) first: it holds the architecture, decisions and hard rules. This file covers the workflow.

## Prerequisites

- Node.js 22 or newer and **pnpm**, pinned in the root `packageManager` field (currently 12.9.1; run `corepack enable`)
- An Android phone and/or iPhone. SMS capture and App Intents need real devices; emulators can't fully test them.
- An Expo account for **EAS Build** (iOS builds don't need a Mac)
- Android Studio (optional, for local Android builds)

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test                # parser tests run with no device needed
```

To run the app on a phone:

```bash
npm install --global eas-cli
eas login
cd apps/mobile
# Already linked to @starforge-lab/finance-bro; your Expo account needs org access.
cd ../..
pnpm build:android:dev       # or build:ios:dev; install the result on your device
pnpm dev                     # start Metro, then open the dev build
```

This project uses a **development build**, not Expo Go. Rebuild the dev client whenever a native module, config plugin or native dependency changes.

EAS profiles pin pnpm to the root `packageManager` version. Keep these pins aligned when changing pnpm. The SDK 58 image's default pnpm 11 launcher failed while switching to pnpm 12 on Linux; an explicit build pin avoids that version-switch path.

### Android APK through GitHub Actions

The `Android development APK` workflow builds an ARM64 debug client (`com.rohangupta.financebro.dev`) on a standard Ubuntu runner, without EAS credentials or its build queue. Native configuration/dependency changes in PRs to `dev` trigger it. Once the workflow is on `dev`, run it manually with `gh workflow run android-development.yml --ref <branch>`.

Download the `finance-bro-dev-arm64` artifact from the successful run within one day, install its APK on an ARM64 Android phone, and start Metro with `pnpm dev`. This development client needs Metro; it is not a store release. Standard runner compute is free for this public repository; artifacts still count toward the organization's storage allowance. The workflow retains one APK for one day and uses no paid runner. Generated `android/` and `ios/` directories remain uncommitted.

## Workflow

1. Open or pick an issue. Follow [the manual-first roadmap](docs/mvp-roadmap.md) and confirm the issue's acceptance criteria. For parser work, use an anonymised SMS sample.
   When a finance workflow decision needs competitor evidence, consult the relevant row in [the benchmark research](docs/research/2026-10-07-personal-finance-benchmarks.md). Carry applicable failure-mode checks into validation; follow agreed issue scope rather than copying a competitor's feature set.
2. Create a short-lived branch from the default `dev` branch: `feat/…`, `fix/…`, `parser/<institution>-…`, or `chore/…`. See the [branching guide](docs/branching.md) for PR targets and release syncs.
3. Write a failing test first for parser and matching logic.
4. Run the checks below before pushing.
5. Open a PR using the checklist below.

```bash
pnpm check
pnpm --dir apps/mobile exec expo install --check
pnpm --dir apps/mobile dlx expo-doctor
pnpm build
```

The workspace intentionally sets `minimumReleaseAge: 0` so newly published SDK beta dependencies are available immediately. Treat that as a bleeding-edge choice, not a stability guarantee. Use `pnpm --dir apps/mobile exec expo install <package>` for Expo or React Native dependencies, review lockfile changes, and run the checks above. Dependabot changes are proposals; review and test them before merging.

GitHub's [Dependabot ecosystem reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) currently lists pnpm support through v10, so compatibility with this repo's pnpm 12 toolchain is unconfirmed. The npm/pnpm entry remains configured; check Dependabot's update logs before relying on JavaScript dependency update PRs. GitHub Actions updates use a separate supported entry.

### Commits

[Conventional Commits](https://www.conventionalcommits.org/) with a scope:

```
feat(parser): add ICICI credit card debit format
fix(android): resume SMS catch-up after reboot
docs: clarify iOS Shortcuts setup
```

Scopes: `parser`, `catalog`, `app`, `db`, `android`, `ios`, `build`, `deps`, `docs`.

Commits must be authored by you, under your own git identity. Don't add AI co-author or attribution trailers.

## Adding a new SMS format

This is the most common contribution.

1. **Anonymise the sample** (by hand for now; a `pnpm parser:anonymise` helper is planned). Replace:
   - names → `RAHUL SHARMA`-style placeholders
   - account and card digits → `XX1234`
   - VPAs → `merchant@okaxis` or `user@ybl`
   - phone numbers, UPI reference numbers and balances → fake values in the same format

   Keep spacing, punctuation, casing and sender ID exactly as received, because the format is what we're testing.
2. **Add a fixture** to a JSON file under `packages/sms-parser/fixtures/<type>/<institution>/` (e.g. `fixtures/banks/hdfc/upi.json`). Each file holds a `cases` array:
   ```json
   {
     "note": "Where these samples came from (e.g. 'HDFC savings, received Oct 2026').",
     "cases": [
       {
         "name": "UPI debit to merchant VPA",
         "sender": "VM-HDFCBK-S",
         "body": "…anonymised text…",
         "receivedAt": "2026-10-06T10:15:00+05:30",
         "expected": {
           "kind": "transaction",
           "ruleId": "hdfc.upi.debit",
           "confidence": "high",
           "txn": { "amountPaise": 45000, "direction": "debit", "accountLast4": "1234", "channel": "upi", "upiRef": "123456789012" }
         }
       }
     ]
   }
   ```
   `txn` is a partial match, so list only the fields you care about. Other expected shapes are `{ "kind": "ignored", "reason": "otp" }` and `{ "kind": "review", "ruleId": null }`. Also add **negative fixtures** for look-alikes from the same sender: OTP, promo, failed, reminder and collect request. Every `*.json` under `fixtures/` is picked up by `test/fixtures.test.ts` automatically.
3. **Run the tests** and confirm the new fixture fails (or passes for the wrong reason).
4. **Write or extend the rule** in `src/rules/<type>/<institution>.ts` and register it in `src/rules/index.ts`. Reuse the extractors in `src/extract/`. If you change an existing rule's behaviour, bump its `version`.
5. **Run all parser tests.** Every fixture must pass, and every rule needs at least one positive fixture.
6. Try it manually: `pnpm parser:try "<sms>" --sender VM-HDFCBK-S`.

**Never commit an un-anonymised SMS**, including in issues, PR descriptions or test names.

## Native modules

- Native code lives only in `apps/mobile/modules/*` (Expo Modules API). Don't edit or commit `android/` or `ios/`; they are generated.
- Manifest, entitlement and Info.plist changes go through the module's config plugin.
- After a native change, run prebuild, rebuild the dev client, and test on a real device. Describe the device and OS version in the PR.

## Database changes

- Change the Drizzle schema, then generate a migration. Don't hand-edit applied migrations.
- Test the migration against a seeded DB that has existing data.
- Amounts are integer paise. Transactions with `userEdited = true` must never be overwritten by automation.

## Pull request checklist

- [ ] `pnpm check` passes (typecheck, lint and tests)
- [ ] `pnpm --dir apps/mobile exec expo install --check`, `pnpm --dir apps/mobile dlx expo-doctor` and `pnpm build` pass
- [ ] Parser changes include positive and negative fixtures; all samples are anonymised
- [ ] No new network calls involving user data (or explicit opt-in consent is in place)
- [ ] The app still works with SMS permission denied
- [ ] Native changes were tested on a real device (device and OS listed)
- [ ] Screenshots and examples use fictional financial data only
- [ ] CLAUDE.md is updated if a decision or convention changed

## Reporting an unrecognised SMS

Open an issue titled `SMS: <institution> <type>` (e.g. `SMS: Kotak UPI credit`) with the **anonymised** text, the sender ID, and what you expected (debit or credit, amount, account).
