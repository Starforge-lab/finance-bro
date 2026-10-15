# Android SMS ingestion storage

Work for [#43](https://github.com/Starforge-lab/finance-bro/issues/43), part of
the Android-SMS-only [2.0 scope](v2-roadmap.md). This is the storage boundary,
not a permission flow, inbox reader, background receiver or completed import feature.

SMS storage was introduced in migration `0007`, after dev's category and
preference migrations. Migration `0008` adds stable source-reference IDs; a
stable dev schema at version 7 applies `0007` and `0008` to reach version 9;
an existing SMS draft schema at version 8 upgrades to version 9 without losing
ledger or preference data. The migration rebuilds only `sms_import_refs`, assigns existing
references IDs of the form `legacy:<platformId>`, and copies their source fields
and transaction links. It does not rewrite transaction IDs, transaction
`sms_ref_id` values, corrections, tombstones or other ledger links. Earlier
unmerged SMS draft revisions used the same migration numbers as dev for
different tables; those prototype databases are not an upgrade source for this
revision. A conflicting prototype schema fails migration transactionally rather
than resetting its records. Use a fresh isolated fictional ledger for prototype
checks; no prototype conversion is implemented.

`DataLayer.importSmsBatch(rows, expectedCursor, options?)` accepts at most 100
already-read Android inbox rows, ordered by received timestamp and numeric
platform row ID. IDs stay canonical decimal strings through the Android
signed-64-bit range. The caller obtains `getSmsImportCursor()` before reading its
next bounded page. A stale cursor stops the batch; callers must reload it before
retrying.

Catch-up replays the original consented date range on each run because inbox
dates and row IDs do not identify newly inserted or changed messages. It uses
`{ replayAfter: null }` for the first page and a separate replay cursor for
later pages. This option validates page order independently of `expectedCursor`;
the latter still guards the current main cursor inside the writer transaction.
Each page commits atomically and retains the greater of the main cursor and its
last row. Existing source tuples remain idempotent; corrections and tombstones
are preserved. Omitting `replayAfter` retains the forward-only batch contract.
The caller supplies the original consent floor; this storage API establishes
no consent itself.

Only the caller that has exhausted the source pages may pass
`{ catchupCompletedAt }`, either a positive safe-integer timestamp or a
zero-argument function that returns one. The function is snapshotted with the
options and invoked after row work inside the final writer transaction, so the
checkpoint time reflects the final commit attempt. This explicit checkpoint is
committed in the same writer transaction as the final batch. An empty final page
records the checkpoint without creating SMS cursor or key state; an ordinary
empty batch remains a no-op. Passing the option on an intermediate page would
falsely claim a completed catch-up, so source exhaustion remains the caller's
responsibility. The timestamp is stored as a reserved, body-free preference
value and does not change the theme preference or the protected-key creation
policy.

`DataLayer.getSmsImportHealth()` is read-only. It returns the last successful
catch-up time, the current pending-review count, and the non-posted-alert subset
of that count. It reads no inbox rows and does not request permissions or load or
create a fingerprint key. Catch-up failures and unavailable outcomes are not
stored as history; callers can report the current operation result, but this API
does not fabricate durable failed-operation or unavailable counts.

`catchUpAndroidSms` is the framework-free foreground coordinator for part of
#44. Its caller supplies the native reader, the shared data layer, an explicit
date range, an `AbortSignal`, and a clock. The caller must obtain revocable user
consent and complete a cancellable history preview before invoking it; neither
the preview nor a permission-request flow is implemented or wired here. The
coordinator never requests permission. It requires both SMS permissions before
each query and after each read, and checks them again inside each writer
transaction before work and before commit. It reads pages of at most 100 rows in
adjacent inclusive windows no wider than 90 days, validates compound ordering
and numeric Android IDs before writing a page, and checkpoints completion only
after the final window is exhausted. Earlier committed pages remain resumable
when a later page is cancelled or access is revoked. Results and coordinator
errors contain no message body or sender. The current native query method has no
cancellation parameter, so an in-flight platform query can finish before the
coordinator observes cancellation and stops further work.
Known saved-key unavailability and duplicate-review requirements are returned
as distinct body-free catch-up error codes so a future caller can offer safe
recovery without inspecting arbitrary storage errors.

If the final access check fails, that revocation or cancellation error takes
precedence over another error from the writer callback, and the active SQLite
transaction rolls back. This does not make platform-protected key writes
transactional: a protected key provider may have completed an external write
before SQLite rolls back, so providers must tolerate that boundary.

The Android connection enables and verifies foreign-key enforcement before
`BEGIN IMMEDIATE`. All batch queries use that connection. References, accepted
transactions, SQLite fingerprint key state and the final cursor commit together
or roll back together. Protected key-store writes happen outside SQLite and can
survive a transaction rollback. Other platforms keep the existing manual/paste API; SMS batch
commit is unavailable there. Expo's exclusive transaction helper opens another
connection and starts the transaction before its callback, so it cannot enable
connection-local foreign keys inside the callback. The explicit connection also
acquires the write lock before reading the current cursor.

References contain a stable `referenceId` (opaque for new rows), the system
inbox ID and timestamp, keyed fingerprints, parser provenance, disposition and
optional ledger transaction ID. Each source tuple is unique by platform ID,
received timestamp and keyed body identity. New reference IDs are derived with
the existing keyed fingerprint service. References contain no raw body or
sender label; sender identity is also keyed. Unknown and uncertain messages stay
as review references rather than incomplete ledger transactions. Non-financial
ignored messages need no durable reference. Missing keys, mismatched key
identifiers and storage failures stop cursor advancement.

`getSmsReviewPage({ limit, after })` lists pending review references without
loading a key or reading the inbox. Pages default to 100 rows and accept limits
from 1 to 100. Each returned row contains `referenceId`, platform ID, received
timestamp, review reason and parser rule/version; it contains no source
fingerprints. Ordering is by timestamp, numeric platform ID, then `referenceId`.
The review cursor carries all three fields so rows sharing a timestamp and
platform ID are not skipped. A `nextCursor` is returned only when more pending
rows exist. Resolved references are excluded; refresh from the first page to
discover newly pending earlier references. This listing does not prepare or
confirm a transaction.

`prepareSmsReview(referenceId, readOriginal)` prepares one pending reference
selected by its stable ID. The caller-supplied Android reader still receives the
stored platform ID. Preparation forbids key creation, checks matching key
history before accessing the source, and verifies the returned platform ID,
timestamp, body fingerprint and normalized-sender fingerprint against the
selected reference. It then rechecks that exact reference after the async read,
so a concurrently resolved item cannot return ready. If Android has recycled the
platform ID for a different row, preparation returns `source_changed` and stays
bound to the selected reference; it never redirects to the newer row. A missing
original returns `missing_original`. Parser-derived identities and rule versions
may change; they are not immutable source proof. Preparation is read-only and
returns no original text or sender label. Ready and unavailable results carry the
selected `referenceId` and its platform ID when available.

`confirmSmsReview(referenceId, expected, readOriginal, corrections?, options?)`
is the transactional human-confirmation boundary. It copies and validates the
reviewed values before awaiting, then rereads the exact source and protected key
state inside the Android writer transaction. The preparation snapshot binds the
reference ID, platform ID and received timestamp. Confirmation rechecks the
source fingerprints and conditionally resolves only that reference, inserting a
new transaction in the same transaction or rolling both changes back. New SMS
transaction and SMS-link identifiers derive from `referenceId`; existing
transaction identifiers and links are unchanged. Confirmation results carry the
selected reference ID and platform ID. It never advances the batch cursor.
Corrections and existing edited or deleted transactions are preserved; an
unknown format may be saved only after the reviewer supplies all required
transaction fields, and its rule ID/version stay paired as null. A weak-identity
overlap stays pending unless the reviewer explicitly confirms a distinct
payment. That choice cannot override a strong identity conflict. Failures return
body-free reasons; cancellation propagates.

Unavailable results distinguish a non-pending selection, missing original,
changed or unavailable source, no-longer-financial parse, inaccessible key,
unreadable source, stale preparation, ambiguous overlap, invalid correction,
unavailable transaction and storage errors. Error text is not returned;
cancellation propagates from the reader and key operations. The caller must
obtain revocable source consent; this API does not request permission or read the
inbox by itself.

The data layer checks persisted state before requesting a protected key. Any
import key state, SMS cursor state, review reference or imported transaction
(including a tombstone) forbids key creation. This deliberately includes
preview-only and ignored-only state; there is no implicit reset or rebinding.
Fresh ledgers containing only manual entries may create their first key.
Android performs this decision inside the immediate transaction. Paste save
rechecks key availability and the preparation's key identity, even when the user
acknowledges historical duplicate risk. That acknowledgement cannot override a
missing key or a key changed after preparation.

Providers default to forbidding creation and reread protected storage after each
completed operation. Concurrent requests with the same policy share only the
in-flight load; successful key material is not permanently cached. A restrictive
request cannot borrow a load that permits creation. Store failures remain errors,
with no temporary key fallback. Actual device store/lifecycle behavior still
requires Android checks.

SMS source identity protects replay. An exact platform-ID, timestamp and body
tuple reuses its prior reference only when sender identity and key identity also
match. An importable or reviewable row with a reused platform ID but a later
timestamp or changed body is treated as a separate source and gets its own
reference. Non-financial ignored rows still need no durable reference. Any newly
accepted transaction derives its identity from its source reference. Existing
transaction IDs, corrections, tombstones and links are not rewritten. Keyed
identities are shared with paste imports in both
directions; strong coherent overlap preserves existing edits and deletion
markers, while conflicting or weak evidence requires review. Body fingerprints
are not globally unique: two genuine identical purchases must remain
distinguishable. Amount/time similarity alone never merges transactions.

The main cursor remains `(receivedAt, platformId)`, while each catch-up uses its
own page continuation from the consent floor. This recovers older-arriving rows
and same-cursor body changes visible during the scan without rewinding the main
cursor. Full scans cost more as consented history grows. The provider exposes no
snapshot token: changes inserted behind an in-flight page require a later scan.
Pages remain bounded and cancellation preserves earlier committed pages. A
successful empty final page rechecks an existing protected key and key history;
an initial empty ledger does not provision a key. Batch parsing and per-row
fingerprints run outside the writer. A short initial transaction checks source
access and the main cursor and serializes any permitted first-key provisioning;
it creates no ledger key-history marker. The final writer rechecks access,
cursor, the existing protected key with creation forbidden, and matching key
history before committing database-dependent decisions. Cancellation checks
surround each prepared row. SecureStore key creation cannot be rolled back by
SQLite, as before; a later failed batch may leave its initial protected key.
Selected-review confirmation still performs source/key awaits inside its writer
transaction and needs separate lock-duration validation.

Automatic saving requires an explicitly verified rule/version, high confidence,
posted status, safe integer paise and one active mapped account. The verified
rule list is currently empty because #46's supplied shapes and synthetic tests
are not a verified acceptance corpus. Generic parsing therefore stays in review.

## Remaining integration gates

On 2026-10-14, the Motorola Edge 60 Pro (Android 17) passed 12 fictional
checks in the isolated `com.rohangupta.financebro.smsqa.dev` client built from
native revision `6bbc2a4`, with storage source
`a01e22badd30a5bef2784fe80f7a159947d8f134`. The harness used a separate
database and a temporary protected-key slot; it preserved the production key
and cleaned up its own data. It covered migration preservation, foreign keys,
bounded review/cursor, rollback, writer exclusion, paste overlap/corrections/
tombstones, selected review confirmation, connection reopen, foreground
catch-up/health, cancellation rollback, key loss and manual fallback. Inbox
pages were fictional; no inbox access or permission request occurred.

The 12-check run above remains evidence for its stated revisions and storage
cases. A later Android flow run below covers the schema 8-to-9 migration,
reference-ID selection, correction flow and Home listener refresh. Neither run
establishes process-restart behavior or live inbox/permission behavior.
Later-timestamp/changed-body platform-ID reuse and unreadable-row progress have
source fixes; the new run exercised the later-timestamp reuse case with
fictional rows. Full-range replay now addresses same-cursor changes and
out-of-order dates in source; matching Android recovery validation remains open.
The batch preflight has a second-connection regression proving a manual save can
finish while fingerprinting is blocked; old-source failure and fixed-source
success were observed. Matching Android contention validation and selected-
review writer-lock duration remain release gates.

On 2026-10-14, a Motorola Edge 60 Pro (Android 17) QA run used the APK from
successful workflow 38587798479 for isolated package
`com.rohangupta.financebro.smsqa.dev`. The APK used native revision
`54d3cd7dbdf008d947c582e93670dc11ccafd8e0`; the QA session used JS/storage
revision `c907994` and UI fix `3635f66`. Private QA patches supplied a
fictional reader and simulated grants/consent, using a private database and key.
The actual native consent gate stayed off; the run read no real inbox rows and
made no OS permission requests.

The real Android SQLite migration from schema 8 to 9 preserved both legacy
references, the saved transaction ID and SMS reference, and the existing
correction. `PRAGMA foreign_key_check` was clean on the WAL-backed database. A
fictional row reusing platform ID 7002 with a later receipt time and changed
body created a third reference while preserving the old one. Selecting the old
reference returned visible manual/paste fallback without redirecting or saving;
selecting the new reference confirmed 81,000 paise. Separately, previewing two
rows and cancelling made no ledger or key writes, while the QA-only fake enable
created two pending reviews. Correcting and confirming one review saved 45,000
paise for October 11 while retaining its receipt clock; Home showed ₹450 via
the native change listener. The UI revision fixed status refresh clearing the
recovery alert. After UI fix `3635f66`, the previously failing recovery-alert
check passed. The final report recorded two transactions, three references,
one pending review, the corrected date, no raw body, preserved key, consent gate
off, schema 9 and
`PASS`.

- Full Android concurrent manual/import saves and process-restart behavior
  remain required before this native storage path is ready to merge.
- #46 must establish the eligible rule corpus before any automatic saving claim.
- #43's selection/recovery path now has isolated Android UI evidence with a
  fictional reader: an old selection showed fallback without redirecting or
  saving, a new selection confirmed, and a corrected transaction was saved.
  Failed/unavailable operation-count semantics and presentation,
  protected-key unavailability/loss lifecycle proof, and full native
  cross-source regression evidence remain open. The storage health API reports
  persisted pending reviews and the non-posted-alert subset; it does not retain
  failed/unavailable operation history. The missing-key creation guard is
  implemented and tested in source/platform mocks and an isolated real browser
  key-store probe; actual Android store/lifecycle proof remains incomplete.
- #44's preview/cancel UI path was exercised with fictional rows, but positive
  consent was simulated and the native gate stayed off. Real opt-in and
  permission-request lifecycle, native-reader wiring, and receiver integration
  remain open. The foreground coordinator handles bounded catch-up only after
  its caller has established consent and preview; source consent is not durable
  or established by this storage API. An in-flight native query cannot be
  interrupted by the current reader method.
- #16 and #56 retain their provider, lifecycle, device and release gates. Node
  SQLite tests and mocked native-runner tests do not establish Android behavior.

This module requests no source permissions itself. Review preparation calls only
the supplied exact-ID reader; that caller must have revocable user consent. This
implementation is not consent to inspect a personal inbox.
