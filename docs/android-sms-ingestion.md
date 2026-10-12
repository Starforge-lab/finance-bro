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
- #43 still needs review listing/re-read/save and recovery actions, health state,
  protected-key unavailability/loss lifecycle proof and full native cross-source
  regression evidence. Existing platform key loading still needs to stop creating
  a replacement when import history exists; rejecting the replacement identifier
  at this boundary prevents writes but is not the full key-loss recovery flow.
- #44 supplies opt-in permissions, cancellable history preview, bounded inbox
  pages, catch-up and receiver integration. Permission changes must stop further
  reads/writes safely; this storage API cannot establish source consent itself.
- #16 and #56 retain their provider, lifecycle, device and release gates. Node
  SQLite tests and mocked native-runner tests do not establish Android behavior.

No native source is read by this API. Its caller must have revocable user consent;
this implementation is not consent to inspect a personal inbox.
