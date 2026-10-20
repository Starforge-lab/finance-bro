# Android SMS acceptance — 2026-10-17

Bounded evidence for #16 and #56, not release or merge acceptance. The device was
a Motorola Edge 60 Pro running Android 17/API 37. Application code was PR #89
at `428a98e`, followed by the consent-status fix described below. Native,
dependency and workflow inputs are unchanged from `74bbc4b`.

The installed isolated APK was workflow `39003901576`, package
`com.rohangupta.financebro.smsqa.dev`, SHA-256
`7d8f421b22588169afdb03350db4a5b331f6eae4763375dcb0c5c62584861904`.
Its hash was checked again on the phone. Production preview, catch-up,
ingestion, ledger, schema, migrations and transaction-runner sources matched
the PR. Private harness changes selected disposable databases and the existing
QA SecureStore key slot. The UI run additionally used the production root
layout, Settings panel and native reader; it did not use the fictional reader.

## Consented provider and storage checks

Real-provider access and disposable local ingestion were separately authorized.
Message bodies stayed in memory on the phone. Only aggregate reports and
assertion results were collected; no source rows, bodies, senders, references,
keys or transaction amounts were exported from the real-inbox checks.

| Check | Observed result | Limit |
| --- | --- | --- |
| Read-only 90-day preview | 811 messages, nine pages, at most 100 rows per page; 434 ms initially and 604 ms after restoring permission | One device and current inbox; not a 10k/50k performance result |
| Preview cancellation | Aborting after the first native page stopped the production preview; native consent/settings and both key slots were unchanged | A running native query itself is not interruptible |
| Revoked READ_SMS | Production preview rejected before querying; a direct native query also rejected | Permission was changed on the isolated QA package only |
| Disposable import | 401 review references, zero transactions and zero accounts; 37,621 ms first pass | No account mapping or real-message automatic-save acceptance |
| Replay | Reference/transaction counts stayed unchanged; 20,423 ms for the first replay | Development-build timing; repeated scans still cost time |
| Close/reopen and replay | A new SQLite connection retained the same counts, then replayed without additions | This probe closed/reopened SQLite; it was not a headless callback |
| Integrity and cleanup | Foreign keys valid, replay checkpoint cleared, no raw body/sender columns, existing key slots unchanged; connection closed and disposable DB deleted | Schema checks are not a comprehensive telemetry/logging audit |

The catch-up algorithm processes the newest page and then sweeps history.
Its first-pass/replay aggregate counters therefore include repeated visits;
they are not counts of distinct inbox messages. The stable stored-reference
count above is the persistence check, not a parser precision claim.

## Actual Settings flow

A second disposable database and fresh isolated native consent settings exercised
the production screen, native permission API, scheduler and ingestion path:

- Initial native consent was off with no saved start date. Preview displayed
  811 messages and `2026-07-19 – 2026-10-17`. Cancel dismissed it while accounts,
  transactions and references all remained zero, with no import tasks registered.
- Revoking both SMS permissions produced Android's actual SMS permission dialog.
  Choosing Allow returned to preview; consent remained off and storage empty.
- `Turn on and import` enabled consent and registered both periodic catch-up and
  receiver-wake tasks. Completion produced 401 pending reviews and no transactions
  in the account-free disposable ledger.
- Revoking READ_SMS while enabled killed the app process. Cold reopen retained
  401 references, removed import task registrations and showed permission recovery
  text plus a newly recorded unavailable check. It did not silently disable the
  user's saved consent. Turning import off still worked without READ_SMS.
- With SMS access unavailable and import off, a fictional ₹1.23 manual expense
  saved through the normal UI and survived force-stop/cold reopen.

The UI database, including its real-source review references and fictional manual
entry, was then closed and deleted. Native consent was off and both import tasks
were removed. The original QA preferences and READ_SMS grant were restored.
The pre-existing fictional QA database retained its original SHA-256 throughout
the disposable-provider/UI runs. No normal application ledger was opened.

## Consent-status regression

Before the fix, native consent and both task registrations were on while the
screen still displayed `Import is off` during pending catch-up. A private
device assertion reproduced that mismatch. The screen now uses its existing
guarded status refresh before starting catch-up and after a failed confirmation.
The same device assertion then passed while catch-up was still pending.

This changes status timing only. Rohan's approved compositions, components,
colors, typography and motion are unchanged. Two existing fictional native
concurrency probes also passed against the current ingestion/review sources:
manual saves completed during paused source/fingerprint preparation; corrections,
replay, foreign keys, raw-body exclusion and temporary DB cleanup passed.

With fictional storage/source data restored, the production root layout and
Settings panel were inspected in light/dark appearances at font scale 1.3 with
Android's transition-animation scale at zero. Status text and primary controls
were readable without clipping; the original font/animation/night settings were
restored afterward. This is a bounded visual check, not TalkBack acceptance.
Hot reloading the restored private QA root initially produced a navigation error;
clean starts with the production root and the subsequent theme switch succeeded.
Configuration-change interruption is not certified by this check.

## Remaining gates

Live/multipart receiver delivery, naturally timed background execution, reboot /
unlock and OEM/battery behavior remain unverified. No test SMS was available in
this session. Full native key-loss/unavailability, 10k/50k production-mode latency
and battery checks, TalkBack and full accessibility/interruption acceptance also
remain open. Existing fictional corpus evidence does not verify other bank/app
formats. Required CI, independent review and applicable F-Droid/signing/publication
gates remain separate.

Frozen install, uncached baseline checks (270 mobile and 134 parser tests,
typecheck and lint), installed-SDK dependency compatibility, Expo Doctor 20/20
and all-platform exports passed. After the four-line UI fix, mobile checks and
all-platform exports passed again; the unchanged parser suite used its cache.
