# Android SMS ingestion storage

Work for [#43](https://github.com/Starforge-lab/finance-bro/issues/43), part of
the Android-SMS-only [2.0 scope](v2-roadmap.md). This is the storage boundary,
not a permission flow, inbox reader, background receiver or completed import feature.

SMS storage is now migration `0007`, following dev's category and preference
migrations. The seeded dev schema version 7 upgrades to version 8 without losing
existing ledger or preference data. Earlier unmerged SMS draft revisions used
the same migration numbers as dev for different tables; those prototype databases
are not an upgrade source for this revision. A conflicting prototype schema fails
migration transactionally rather than resetting its records. Use a fresh isolated
fictional ledger for prototype checks; no prototype conversion is implemented.

`DataLayer.importSmsBatch(rows, expectedCursor, options?)` accepts at most 100
already-read Android inbox rows, ordered by received timestamp and numeric
platform row ID. IDs stay canonical decimal strings through the Android
signed-64-bit range. The caller obtains `getSmsImportCursor()` before reading its
next bounded page. A stale cursor stops the batch; callers must reload it before
retrying.

Only the caller that has exhausted the source pages may pass
`{ catchupCompletedAt }`, a positive safe-integer completion timestamp. This
explicit checkpoint is committed in the same writer transaction as the final
batch. An empty final page records the checkpoint without creating SMS cursor or
key state; an ordinary empty batch remains a no-op. Passing the option on an
intermediate page would falsely claim a completed catch-up, so source exhaustion
remains the caller's responsibility. The timestamp is stored as a reserved,
body-free preference value and does not change the theme preference or the
protected-key creation policy.

`DataLayer.getSmsImportHealth()` is read-only. It returns the last successful
catch-up time, the current pending-review count, and the non-posted-alert subset
of that count. It reads no inbox rows and does not request permissions or load or
create a fingerprint key. Catch-up failures and unavailable outcomes are not
stored as history; callers can report the current operation result, but this API
does not fabricate durable failed-operation or unavailable counts.

The Android connection enables and verifies foreign-key enforcement before
`BEGIN IMMEDIATE`. All batch queries use that connection. References, accepted
transactions, fingerprint key state and the final cursor commit together or roll
back together. Other platforms keep the existing manual/paste API; SMS batch
commit is unavailable there. Expo's exclusive transaction helper opens another
connection and starts the transaction before its callback, so it cannot enable
connection-local foreign keys inside the callback. The explicit connection also
acquires the write lock before reading the current cursor.

References contain the system inbox ID, timestamp, keyed fingerprints, parser
provenance, disposition and optional ledger transaction ID. They contain no raw
body or sender label; sender identity is also keyed. Unknown and uncertain
messages stay as review references rather than incomplete ledger transactions.
Non-financial ignored messages need no
durable reference. Missing keys, mismatched key identifiers and storage failures
stop cursor advancement.

`getSmsReviewPage({ limit, after })` lists pending review references without
loading a key or reading the inbox. Pages default to 100 rows and accept limits
from 1 to 100. The returned rows contain only platform ID, received timestamp,
review reason and parser rule/version. Ordering uses timestamp then numeric
platform ID, retaining precision beyond JavaScript's safe integer range. A
`nextCursor` is returned only when more pending rows exist. Resolved references
are excluded; refresh from the first page to discover newly pending earlier
references. This listing does not prepare or confirm a transaction.

`prepareSmsReview(platformId, readOriginal)` prepares one pending reference using
a caller-supplied exact-ID Android read. It forbids key creation, checks matching
key history before accessing the source, and verifies timestamp, body HMAC and
normalized-sender HMAC. Parser-derived identities and rule versions may change;
they are not immutable source proof. The reference is rechecked after the async
read so a concurrently resolved item cannot return ready. Preparation is read-only
and returns no original text or sender label.

`confirmSmsReview(platformId, expected, readOriginal, corrections, options)` is
the transactional human-confirmation boundary. It copies and validates the
reviewed values before awaiting, then rereads the exact inbox row and protected
key state inside the Android writer transaction. It compares the fresh parser
preparation with the selected snapshot, inserts the canonical `sms:<platformId>`
transaction and resolves the reference together, or rolls both back. It never
advances the batch cursor. Corrections and existing edited or deleted
transactions are preserved; an unknown format may be saved only after the
reviewer supplies all required transaction fields, and its rule ID/version stay
paired as null. A weak-identity overlap stays pending unless the reviewer
explicitly confirms a distinct payment. That choice cannot override a strong
identity conflict. Failures return body-free reasons; cancellation propagates.

Unavailable results distinguish a resolved reference, missing original, changed
source, no-longer-financial parse, inaccessible key, unreadable source, stale
selection, ambiguous overlap, invalid corrected references and database failure. Error text is not returned;
cancellation propagates from the reader and key operations. The caller must
obtain revocable source consent. The confirmation API is not yet connected to
the native reader or a screen.

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

SMS platform identity protects replay. Keyed identities are shared with paste
imports in both directions; strong coherent overlap preserves existing edits
and deletion markers, while conflicting or weak evidence requires review. Body fingerprints are not
globally unique: two genuine identical purchases must remain distinguishable.
Amount/time similarity alone never merges transactions.

Automatic saving requires an explicitly verified rule/version, high confidence,
posted status, safe integer paise and one active mapped account. The verified
rule list is currently empty because #46's supplied shapes and synthetic tests
are not a verified acceptance corpus. Generic parsing therefore stays in review.

## Remaining integration gates

- Matching Android tests of the connection, migration, concurrent saves, rollback
  and restart are required before this native storage path is ready to merge.
- #46 must establish the eligible rule corpus before any automatic saving claim.
- #43 still needs native review-reader wiring, confirmation/recovery actions,
  failed/unavailable operation-count semantics and presentation, protected-key
  unavailability/loss lifecycle proof and full native cross-source regression
  evidence. The storage health API reports persisted pending reviews and the
  non-posted-alert subset; it does not retain failed/unavailable operation
  history. The missing-key creation guard is implemented and tested in
  source/platform mocks and an isolated real browser key-store probe; visible
  recovery actions and actual Android store/lifecycle proof remain incomplete.
- #44 supplies opt-in permissions, cancellable history preview, bounded inbox
  pages, catch-up and receiver integration. Permission changes must stop further
  reads/writes safely; this storage API cannot establish source consent itself.
- #16 and #56 retain their provider, lifecycle, device and release gates. Node
  SQLite tests and mocked native-runner tests do not establish Android behavior.

This module requests no source permissions itself. Review preparation calls only
the supplied exact-ID reader; that caller must have revocable user consent. This
implementation is not consent to inspect a personal inbox.
