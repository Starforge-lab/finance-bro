# Android SMS import flow

The Settings import section extends the existing Ink and Stamps screens. A
private Android QA run has exercised the flow with fictional source rows and
isolated storage; that bounded evidence is not Android SMS 2.0 release
acceptance.

## Consent and preview

Normal Android builds declare READ_SMS and RECEIVE_SMS. Neither declaration nor
an OS grant enables import. The native setting defaults off; the receiver checks
it before enqueuing work and never decodes SMS PDUs. Manual entry and paste remain
available.

The user starts the preview before either permission is requested. First use
counts a fixed 90-day interval in batches of at most 100. No preview write or
fingerprint-key creation occurs. Cancel discards the preview; a separate
confirmation records the body-free enabled flag and original start date. The
native setter validates the frozen preview interval, so delayed confirmation
does not change or invalidate the window the user saw.

Disable aborts the shared foreground import and writes the setting off, including
when enable is still pending. It preserves the original start date and committed
cursor for explicit resume. Earlier committed pages remain; the in-flight page
must roll back. The native provider cannot interrupt an already running query,
so cancellation is checked again when it returns.

## Catch-up and review

While enabled, opening or foregrounding the app scans the original consented
range in bounded pages, including previously checked messages. Preview counts
the same range and explains that existing entries and corrections are preserved.
A separate page cursor leaves the committed main cursor monotonic, recovering
older-arriving messages and changed bodies without recreating saved entries.
Permission and consent are checked at write
boundaries. Backgrounding aborts foreground catch-up and source counting. A
user-started OS permission dialog may finish, but preview reads begin only while
Settings is focused and the app is active; leaving Settings cancels that
continuation. Settings shows the last
successful catch-up, pending reviews, permission state and body-free failures.

Review pages hold at most 100 source references. Selecting one re-reads its exact
inbox row in memory. The existing correction form confirms through the SMS
review API, including stale-selection, duplicate, edit and tombstone checks;
it does not save the item as a paste. The parsed transaction date is the default,
with receipt time used only when no parsed date exists. A missing original or
unavailable key offers manual/paste recovery. Raw text is never displayed by
this flow or saved in its status state.

The app entry defines the periodic and receiver-wake Expo tasks before loading
the router. Both delegate to the same guarded catch-up runner. Confirming an opt-in
registers the existing best-effort Expo background task with a minimum interval
of 15 minutes; Android controls actual timing and may require network availability
and sufficient battery. It also registers a separate persisted TaskManager
consumer for `SMS_RECEIVED`. After checking persisted consent, the receiver queues
one-time WorkManager work with no message data; it does not decode PDUs or read
the inbox. The worker rechecks the original consent floor and both SMS permissions,
then calls the alias through Expo's task service and waits for the JS completion
callback. The worker stamps a body-free `deadlineElapsedRealtimeMs` into the wake
task data immediately before dispatch, using Android's monotonic elapsed clock.
The wake handler accepts only that single safe-integer field, reads the same
native clock, and subtracts the JS-to-native bridge round trip from the remaining
budget. It fails before settings or ledger access if the deadline is invalid,
expired, or more than seven minutes ahead; it does not assume the JS and native
clock origins match. Receiver scheduling is bounded to active work plus at most one trailing
pass: wakes coalesce while a pass is already queued, and one pass is appended only
when work is running with no trailing pass. Its unique `APPEND_OR_REPLACE` chain
retains that trailing wake. The JS runner has a seven-minute cooperative deadline;
the worker's eight-minute bound only limits how long it waits for the callback.
Expo's `TaskInterface` has no cancellation handle, so a native inbox read already
in progress may finish after the worker stops waiting. The abort signal prevents
the JS catch-up from starting later reads or writes after that await returns, and
the existing active catch-up guard avoids parallel writes in the same runtime.
Each worker attempt applies exponential backoff for three attempts and checks for
the numeric success result. A body-free native
metadata record exposes the last attempt time and `success`, `deferred` or `failed`
outcome plus a cumulative saturating failed-attempt count; the multipart field
remains API-compatible but is always zero because this wake path does not inspect
PDUs. If outcome metadata cannot be committed, the worker retries without invoking
JS and reports a failed WorkManager result after the retry budget; this storage
failure can fail an already-appended pass. Opening the app or a later SMS wake can
recover. For ordinary JS failure or retry exhaustion, a work item finishes so a
queued wake can proceed, while the stored outcome remains `failed`. This status is
the receiver worker's retry status, not proof of a successful import or the
separate capture-check counters below.
Registration failure attempts to turn import off and remove both tasks and queued
work, and reports a body-free error. Disable persists off before unregistering;
the receiver gate and worker gate prevent inbox access if queued work races with
disable. Launch reconciles persisted consent and both task registrations.

The periodic background runner starts its seven-minute budget at handler entry.
The receiver wake runner uses the native dispatch deadline, capped at seven
minutes. Both check consent, its start date and both SMS permissions before
opening the ledger, and use the same bounded catch-up path as app-open recovery.
These budgets are cooperative:
if expiry occurs during a settings, ledger, key-provider or inbox native await,
that native call itself may continue until it returns. After return, the runner
does not start a catch-up that had not begun before expiry; an active catch-up is
aborted and its guards prevent later page reads or writes. Receiver-triggered
execution on the matching native build remains unverified. The native outcome
record does not establish durable, detailed JS failure reporting after the
headless runtime ends.

The verified rule list is still empty: uncertain formats remain in review.
Later-timestamp/changed-body row-ID reuse and unreadable-row progress
have source fixes; the private device run exercised fictional ID reuse. Full
range replay addresses same-cursor changes and out-of-order dates in source;
fictional Android recovery and batch contention checks have passed. Batch
fingerprints run outside the writer; selected-review source/key awaits inside
the writer still need validation. Repeated scans cost more as history grows, and
source changes behind an in-flight page require a later scan. Live/multipart delivery, the real
permission/consent lifecycle, restart/reboot, installer/source-build eligibility
and release acceptance remain open. See #16, #43, #44, #46 and #56.

On 2026-10-14, a Motorola Edge 60 Pro (Android 17) QA run used the APK from
successful workflow 38587798479 for isolated package
`com.rohangupta.financebro.smsqa.dev`. The APK used native revision
`54d3cd7dbdf008d947c582e93670dc11ccafd8e0`; the QA session used JS/storage
revision `c907994` and UI fix `3635f66`. The private QA patches supplied a
fictional reader and simulated grants/consent with a private database and key.
The actual native consent gate stayed off; no real inbox rows were read and no
OS permission request was made.

The device flow confirmed that previewing two rows and cancelling made no ledger
or key writes; the QA-only fake enable produced two reviews. Correcting and
confirming a review saved 45,000 paise with the corrected October 11 transaction
date while retaining its receipt clock. Home then showed ₹450 through the native
change listener. The same run exercised a changed later row under reused
platform ID 7002: the old selected reference offered manual/paste recovery
without redirecting or saving, while selecting the new reference confirmed
81,000 paise. The UI fix prevents status refresh from clearing the recovery
alert. After UI fix `3635f66`, the previously failing recovery-alert check
passed. This validates the fictional-source UI and storage paths, not real
consent, permission requests, inbox access, restart behavior or release
eligibility. See
`android-sms-ingestion.md` for migration and final-state evidence.

The 2026-10-15 private diagnostic at source `a638448` additionally passed 14
native assertions: a manual save completed during blocked fingerprinting,
older/changed sources replayed without rewinding progress, repeat replay was
idempotent, and keys, foreign keys, raw-body exclusion and cleanup passed.
It used the same verified native APK with a temporary fictional database;
native SMS consent stayed off and source access was simulated. This does not
establish real opt-in, receiver delivery, background execution or process restart.

A second private diagnostic on that APK exercised the public native task APIs
with scheduling source `b727a82`: all 13 assertions passed, including task
definition, availability, registration at a 15-minute minimum, idempotent
registration, and removal. It made no inbox query, permission request or consent
write; native and fictional consent remained off. The installed development
client retained its old router entry URL, so this diagnostic loaded through the
private route harness. It proves native registration/removal, not the new global
entry's cold-start behavior or a delivered background import. The new entry
exported successfully for Android, iOS and web; matching native execution remains
required.

The later isolated APK from workflow `38775730895`, native revision `d03ddab`,
was installed and its SHA-256 matched
`2fa18ee74e698d4462e727cdcf972b9efd88951b3fea02a086d65f9a44171845`.
Opening it loaded the new global entry. A forced scheduled cold-start attempt
reached the background callback, but its isolation assertion found the new
fictional reference already present before that callback; this is not a passing
fresh-source ingestion proof. The temporary arm flag was removed and the probe
was stopped after the test. Matching receiver-bridge device acceptance remains open.

On 2026-10-16, hosted Android build
[`38940585460`](https://github.com/Starforge-lab/finance-bro/actions/runs/38940585460)
at `d4255d7` compiled the receiver bridge, passed its JVM tests and built the
normal ARM64 development APK. Native/module files are unchanged through source
`5e0986f`. The isolated phone build for that source is
[`38942149039`](https://github.com/Starforge-lab/finance-bro/actions/runs/38942149039);
its fictional corpus device execution passed as recorded below. Receiver and
cold-start acceptance remain open.

Source `5e0986f` passed `pnpm check` (260 mobile and 134 parser tests, typecheck
and lint), Android/iOS/web exports, the installed-SDK offline dependency check,
and Expo Doctor 1.21.4's 20 checks. Independent standards and spec reviews found
no actionable findings in the durable replay checkpoint change. The simulated
50,000-row resume test and Node SQLite corpus acceptance are source evidence;
they do not establish Android provider latency, battery cost or cold delivery.

The matching isolated APK was installed on the Motorola Edge 60 Pro running
Android 17/API 37. Its installed SHA-256 matched
`9b5aa164b219d2acb466bf595651c2914710db76f54612878037b86006bfbd7b`.
Manual diagnostic run `1792174008888-7pn9ubty`, reporting source `5e0986f`,
completed all 53 fictional HDFC cases using the production ingestion code,
Expo SQLite and the platform-backed fingerprinter: six saved, 39 reviewed,
eight ignored. Replay returned 45 duplicates and eight ignored cases, retaining
six transactions and 45 references. All assertions passed, including exact
saved economics and provenance, absence of raw body/sender columns, unchanged
private key and production-slot surrogate, and cleanup of this run's databases.
Native import consent stayed off before and after; the source reader was
fictional and no real inbox was accessed. This is foreground import/storage
proof, not native provider, receiver, cold-start or permission-lifecycle proof.

A separate explicitly authorized, read-only provider probe on that same APK
completed as run `1792174357583`. It queried only the prior 24 hours, with a
10-row ascending request and a 10-row newest-first request. Both returned ten
rows with valid identifiers, in-range receipt timestamps, strict date/id order
and valid cursor behavior; newest-first returned no continuation cursor. The
observed query times were 96 ms ascending and 23 ms descending. Source rows
remained in memory and were discarded; only counts, timings and assertion
booleans left the device. No ledger writes or permission requests occurred,
and native import consent stayed off. This verifies the bounded provider API
on this device, not 10k/50k history performance, capture delivery or battery cost.

## Persistent capture health

The native reader adds consent-gated `beginCaptureAttemptAsync` and
`finishCaptureAttemptAsync` methods in the existing wake preferences. The
body-free status contains safe counters, a monotonic revision, an allowlisted
failure code and its timestamp. It contains no message identifiers or contents.
A current, unfinished revision can record one failed or unavailable outcome.
Stale and duplicate finishes are
ignored so an older callback cannot replace a newer result. These are recorded
latest-attempt outcomes, not message counts, lost-transaction counts or a complete
history of interrupted/superseded checks. The receiver worker's existing
`failedAttemptCount` remains a distinct retry metric.

Unavailable outcomes are permission denied/unavailable, invalid saved consent,
source/key unavailable, required duplicate review and unavailable background
scheduling. Invalid pages, stale cursors, storage/clock problems, exhausted time
budgets and unexpected errors are failed outcomes. Native validation enforces the
code/category pairing; arbitrary exception text is rejected. Counts saturate at
the JavaScript safe-integer limit; revisions never wrap.

Joining callers share the active catch-up promise and health attempt. Beginning
or cancelling a check and turning imports off preserve the last failure; only
completed success clears it. Native writes check persisted enabled consent, and
disabled imports do not create checks. A failure before the reader/preferences
are accessible cannot be durably recorded there; the caller still reports its
static error when available. A timeout stops financial work without waiting for
a potentially hung status write.

If background-task registration fails, the app attempts to unregister the task
before writing the body-free failure status, then attempts to persist consent
off. The health write has a one-second JavaScript wait bound so a promise that
never settles does not hold the settings queue indefinitely. This timeout does
not cancel native work: if a native module call or preferences monitor is blocked
at the platform level, the later consent-off write may also remain pending. The
guarantee is the early unregister attempt and bounded JavaScript health wait, not
recovery from a stalled native preferences operation.

Settings reads this record after restart and shows recorded failed/unavailable
checks separately from failed-payment alerts in review. The SQLite successful
catch-up timestamp remains the record of committed, exhausted source work.
Metadata-read failure offers retry and paste recovery. The bounded native API
and status-count display were later verified on device as recorded below.

## Cold headless catch-up evidence

On 2026-10-17, isolated run `mvbvwlmq-uk6h6j6c` exercised the production
background runner in a fresh headless JavaScript runtime, not the foreground
app. It used the isolated APK from workflow
[`38942149039`](https://github.com/Starforge-lab/finance-bro/actions/runs/38942149039),
and reported source `5e0986f` for the isolated APK and JavaScript runner. The app
process was absent before the callback; Android started a new process with a
fresh headless JavaScript runtime. Before it began, the run's private database
had one seeded account, zero transactions and references, and no import cursor
or replay checkpoint. The runner saved one fictional HDFC
credit for 25,075 paise, then replayed it without adding a duplicate: the final
database held one transaction and one reference. Foreign-key checks, catch-up
health recording, checkpoint clearing, and unchanged private and production key
slots passed. The run used a fictional inbox without requesting permission or
writing consent; native consent remained off before and after. Its body-free
report and native log contain no SMS contents.

The run was initiated manually with Android's `jobscheduler run --satisfied` at
2026-10-17 04:32:20 UTC; Android ran the callback at about 04:40 UTC after a
scheduler backlog. This proves the production runner's bounded storage and
replay path from an absent process into a fresh headless runtime. It does not
prove naturally timed task delivery, SMS receiver or multipart delivery, real
inbox access, permission or consent lifecycle, or behavior after device reboot.
That installed APK predates the capture-health API; the separate matching
verification appears below. Cleanup completed: the QA task was unregistered,
its manifest and unique database were
removed, and no scheduled job remained.

## Capture-health device verification

On 2026-10-17, native capture-health run `mvbxhk6g-vvfdgclu` passed on a
Motorola Edge 60 Pro running Android 17. It reported source `74bbc4b` and used
the isolated APK from workflow
[`39003901576`](https://github.com/Starforge-lab/finance-bro/actions/runs/39003901576),
with SHA-256
`7d8f421b22588169afdb03350db4a5b331f6eae4763375dcb0c5c62584861904`. Native
and JVM assertions passed. The same head's normal development APK
[`39003898201`](https://github.com/Starforge-lab/finance-bro/actions/runs/39003898201),
CI and CodeQL checks also passed.

Native consent started off, was temporarily enabled only for health API checks,
and ended off. The run did not register a background task, query the inbox, or
request a platform permission. Starting from zero failed/unavailable counts, it
recorded one of each with current static code `permission_denied`. It verified
that success does not increase outcome counts,
cancellation preserves a failure, stale and duplicate finishes are ignored, and
disabled consent makes begin return null and ignores finish. A second, fresh
JavaScript runtime read the same failure code and counters while consent remained
off.

The current Settings status panel, mirrored byte-for-byte in the private QA
build, showed `Recorded checks: 1 failed · 1 unavailable`, the recovery copy
“SMS permission is unavailable. Grant it, then preview again. Manual entry and
paste still work.”, and `Import is off`. The `permission_denied` value was
written through the health API; this was not a test of Android permission
revocation or grant behavior. A separate Settings preview inspection showed
zero messages and retained the October 17, 2026 start date; this does not prove
the initial 90-day preview.

The current Settings panel also completed a bounded preview/cancel and
confirm/disable sequence. Preview followed by `Cancel preview` left import off
and the preview dismissed. A fresh read-only database contained two
transactions and four references; its key was preserved and its report recorded
no raw body. A second preview of the preserved October 17 zero-message window,
followed by `Turn on and import`, turned import on, displayed the October 17
last-catch-up date and cleared the injected failure. Turning import off restored
native consent off. Post-disable wake metadata/XML still showed one failed and
one unavailable outcome, no current failure code, and zero app-owned scheduled
jobs. No new transaction was saved in this sequence. The status panel was visually
checked in dark and light themes; Auto was restored afterward. This does not
establish TalkBack, large-text or reduced-motion acceptance.

This verifies the bounded zero-message preview/cancel/confirm/disable path, the
native health API's persistence across a fresh JavaScript runtime, and the
displayed status counts. It does not establish initial 90-day history, live
inbox access, Android permission revocation/grant, background delivery, a new
financial save, or reboot behavior. Full capture acceptance remains open beyond
this bounded UI sequence.
