# Android SMS import flow

The Settings import section extends the existing Ink and Stamps screens. A
private Android QA run has exercised the flow with fictional source rows and
isolated storage; that bounded evidence is not Android SMS 2.0 release
acceptance.

## Consent and preview

Normal Android builds declare READ_SMS and RECEIVE_SMS. Neither declaration nor
an OS grant enables import. The native setting defaults off; the receiver checks
it before decoding PDUs. Manual entry and paste remain available.

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

The app entry defines the Android task before loading the router. Confirming an
opt-in registers a best-effort Expo background task with a minimum interval of
15 minutes; Android controls actual timing and may require network availability
and sufficient battery. Registration failure attempts to turn import off and
remove the task, and reports a body-free error. Disable persists off before
unregistering. Launch reconciles persisted consent and task registration.

The background runner checks consent, its start date and both SMS permissions
before opening the ledger. It uses the same bounded catch-up path as app-open
recovery. Background execution on the matching native build remains unverified;
the current failure status is held in runtime memory and does not establish
durable capture-health reporting after the headless runtime ends.

The verified rule list is still empty: uncertain formats remain in review.
Receiver-triggered processing is not yet connected.
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
