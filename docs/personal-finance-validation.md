# Personal finance planning validation — 2026-10-18

This is evidence for the draft reconciliation/planning slice, not complete
Android SMS acceptance or release readiness. The branch includes draft #89;
the planning schema follows its migrations 0007/0008.

## Automated checks

- Frozen install passed without dependency or lockfile changes.
- `pnpm check`: typecheck, lint, 306 mobile tests and 142 parser tests passed.
- Frozen SDK compatibility check passed with `EXPO_OFFLINE=1`.
- Expo Doctor against the frozen SDK: 20/20 passed with `EXPO_OFFLINE=1`.
- Online Doctor: 19/20, with 20 newer package recommendations from Expo's
  current remote version map. The documented 2.0 dependency freeze remains;
  no checks were suppressed and no package versions changed.
- Android, iOS and web exports passed. Exports are not signed applications.
- SMS reader contract self-check and all five unsigned-release plugin tests
  passed.
- Independent review found and verified fixes for archived debts disappearing,
  card reminders without card coverage, transaction overlap/rollback, and an
  automatic merge applying a paste-only guard inside SMS insertion.
- Regression tests cover migration preservation/reopen, invalid and overflowing
  paise, card double reservation, India-calendar boundaries, payday bills,
  missed monthly reminders, protected paid/edited/deleted occurrences, and
  concurrent forecast/manual/bill writes. A temporary mutation reintroducing
  unchanged preference writes failed the write-free regression as expected.

## Browser flow

Ran a fresh isolated Microsoft Edge context through Playwright with fictional
data, at 390 × 844 and 1280 × 900, including light/dark and reduced motion.
The in-app browser previously blocked localhost; a separate isolated browser
allowed real interaction without using a personal browser profile.

Created a bank and card through Settings; saved salary day/amount, reserve,
balances and regular bill/card-payment reminders. Verified:

- INR 50,000 liquid − 10,000 full card debt − 2,000 bill − 5,000 reserve
  equals INR 33,000 available. Future salary is excluded; the card reminder is
  not deducted again.
- Calculation details expand/collapse; confirming paid requires an explicit
  recorded-payment acknowledgement. Cancelling preserves the reserve.
- Reload retains setup, checkpoints, reminders and the result.
- Archiving the card keeps its debt reserved; restoring it works.
- No page errors, console errors or horizontal page overflow were observed.

## Physical Android storage check

Motorola Edge 60 Pro, Android 17/API 37. Used the already installed
`com.rohangupta.financebro.smsqa.dev` development client (version 0.1.0,
last updated 2026-10-17); its native build commit was not independently
identified. No new APK was installed. Current JavaScript ran through a temporary
entry point which imported no SMS reader or background capture initialization.

The reusable `apps/mobile/test/finance-runtime-check.ts` harness ran only against
`fictional-finance-plan-check-20261018.db`, separate from the app's main ledger.
It passed 18 initial checks: seeded schema upgrade, exact reserves, salary
exclusion, spending/balance projection, paid-reminder behavior, archived card
debt, restore, concurrent writes, invalid money, and persistence assertions.

A full force-stop and cold relaunch created a different process and passed all
seven reopen assertions. Native markers reported `phase: seeded`, then
`phase: reopened`, then `fictional-ledger-deleted`. Expo SQLite deleted the
isolated file; a targeted filesystem existence check confirmed it was absent.
The temporary entry point/screen and USB reverse mapping were removed; the
original entry point was restored and the probe app stopped.

No inbox was read, SMS access enabled, financial record uploaded, or main ledger
modified during this check. This validates the new storage/business API on the
phone, not native screen navigation, TalkBack, iOS, natural background delivery,
reboot/unlock, OEM behavior, capture completeness or production performance.

## Remaining gates

Private balances, salary details and commitments must be entered locally.
Card reminders still rely on explicit complete-card setup rather than a
per-reminder account link. Automatic transfer/payment matching, merchant rules
and encrypted backup remain open under the existing issues. Draft #89's device
and distribution gates still apply. Do not recommend the app as a sole record
until recovery and the applicable native acceptance gates pass.
