# Android SMS ingestion storage

Work for [#43](https://github.com/Starforge-lab/finance-bro/issues/43), part of
the Android-SMS-only [2.0 scope](v2-roadmap.md). This is the storage boundary,
not a permission flow, inbox reader, background receiver or completed import feature.

`DataLayer.importSmsBatch(rows, expectedCursor)` accepts at most 100 already-read
Android inbox rows, ordered by received timestamp and numeric platform row ID.
IDs stay canonical decimal strings through the Android signed-64-bit range.
The caller obtains `getSmsImportCursor()` before reading its next bounded page.
A stale cursor stops the batch; callers must reload it before retrying.

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
- #43 still needs review re-read/save and recovery actions, health state,
  protected-key unavailability/loss lifecycle proof and full native cross-source
  regression evidence. The missing-key creation guard is implemented and tested
  in source/platform mocks and an isolated real browser key-store probe; visible
  recovery actions and actual Android store/lifecycle proof remain incomplete.
- #44 supplies opt-in permissions, cancellable history preview, bounded inbox
  pages, catch-up and receiver integration. Permission changes must stop further
  reads/writes safely; this storage API cannot establish source consent itself.
- #16 and #56 retain their provider, lifecycle, device and release gates. Node
  SQLite tests and mocked native-runner tests do not establish Android behavior.

No native source is read by this API. Its caller must have revocable user consent;
this implementation is not consent to inspect a personal inbox.
