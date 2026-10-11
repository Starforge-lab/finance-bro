# Android safety validation — 2026-10-09

## Build and isolation

- Device: Motorola Edge 60 Pro, Android 17; development package `com.rohangupta.financebro.dev`.
- APK source: QA integration commit `007771e804a5473d649eee179fc11c81f2aeede0`, built by [run 37937360770](https://github.com/Starforge-lab/finance-bro/actions/runs/37937360770).
- APK SHA-256: `F44898B48338D7EB3EE86B9079BCB0BCE17E66DAE900AB4315E0E1A11BB17F9A`.
- `adb install -r` succeeded with the existing signing identity. Neither installed app was uninstalled or cleared.
- Metro served that source plus a temporary assertion harness. The harness used `finance-bro-native-qa-20261009.db` and `finance-bro.native-qa.20261009.fingerprint-key.v1`, rather than the app ledger or fingerprint key. All fixtures were fictional; reports contained only assertion labels.

The graph combined #39 at `43579a2`, #41 at `dcaf049` (including #40), #62 at `be5f13f`, #65 at `3931e17`, #68 at `fcc4d3f`, and #66 at `1af69f8`. Later rebases and merges must be checked separately. A subsequent web-only fade-helper fix was present in the served source; its native keyframe path was unchanged.

## Observed checks

All 26 fresh-run assertions passed on native Expo SQLite, Crypto and SecureStore:

- One-paisa and maximum-safe-paise conversion, native SQLite round trip, and rejection of overflow/excess precision without an inserted invalid row.
- India-calendar October/November boundaries.
- An identical no-reference paste remains a replay by default.
- A deliberately different selected second creates a second purchase; retries retain the same identity.
- User corrections survive replay. A soft-deleted second purchase stays hidden, retains its collision metadata and cannot be resurrected by replay.
- A restart marker was persisted in the isolated database.

After `am force-stop`, the app process changed from PID 25784 to 26097. All 16 restart assertions passed:

- A new JavaScript runtime was observed and the QA SecureStore key persisted.
- Maximum-safe-paise and India-month records persisted.
- Base identity, correction and selected-second replay protection persisted.
- The deletion tombstone remained present and hidden; replay did not restore it.

Cleanup then reported `PASS qa-only-database-and-key-deleted`. The temporary harness and namespace changes were removed from the QA worktree; no QA code is committed.

## Separate evidence and remaining gates

The clean combined graph passed frozen installation, `pnpm check` (59 mobile checks and 44 parser tests), Expo dependency check, Expo Doctor 20/20, all-platform export and whitespace checks. Those are automated/source-build checks, separate from the native assertions above.

This run does not verify the full native UI, chart accessibility, reduced-motion rendering, haptics, CSV document picker/save/readback/failure behavior, an old-schema device upgrade, iPhone behavior, automatic imports, encrypted recovery, F-Droid eligibility or signed release delivery. Those gates remain in #34, #42, #56 and the feature issues. No real inbox, mailbox or receipt was accessed.
