# Finance Bro 2.0 — Android SMS imports

## Scope

On 2026-10-10, Suvo narrowed 2.0 to **automatic imports from Android SMS only**, superseding the broader 2026-10-09 plan. iOS and every other import source are later work. The existing manual-first app remains the base and must keep working when SMS access is denied; its existing features are not new 2.0 deliverables.

2.0 adds consented Android SMS capture, safe parsing, review, and recovery from ordinary capture failures. The roadmap describes required behavior, not shipped capability. [PRODUCT.md](../PRODUCT.md) records this confirmed scope and remains the product authority.

## Required behavior

- Explain the access and request `READ_SMS` and `RECEIVE_SMS` only when the user starts the import flow. After access is granted, preview the bounded 90-day history before writing to the ledger and require a separate confirmation. Cancel leaves the ledger unchanged.
- Handle new SMS through Android's `SMS_RECEIVED` broadcast, including multipart messages. Process message text transiently. Use WorkManager only for best-effort work and query the bounded system inbox again when the app opens. Do not promise delivery while Android or an OEM has stopped or restricted the app.
- Parse only verified, high-confidence SMS rules into transactions. Require a known account and a safe integer-paise amount. Unknown accounts, ambiguous or unsupported formats, and invalid amounts go to review; never guess or auto-save them.
- Commit accepted transactions and source progress atomically. Replays must be idempotent. A source message must not overwrite a user's protected edit or resurrect a deleted transaction. Two genuine identical purchases remain two transactions.
- Keep raw message text out of the database, durable queues, logs, telemetry, crash reports, and GitHub. Persist only the structured transaction and the minimum protected source identity needed for replay safety. If source access, an inbox row, or the protected fingerprint key is unavailable, report the item for review or recovery without silently advancing past it.
- Permission denial or revocation leaves manual entry and paste usable. Missing inbox messages can be entered or pasted by the user. Surface capture failures and the last successful catch-up plainly.

The current SQLite and Android integration must be proven at [#16](https://github.com/Starforge-lab/finance-bro/issues/16) before fixing the shared ingestion contract. Build only the seam the Android flow needs; do not add a generalized multi-provider framework. If the feasibility evidence requires a different contract, document and review that before implementation.

## Delivery order

Tracked in the [2.0 epic #58](https://github.com/Starforge-lab/finance-bro/issues/58).

1. **Android feasibility — #16:** prove SMS permissions, receiver and inbox behavior, capture limits, transient parsing, and safe writes against the existing Expo/SQLite app on the target device. Record Android/OEM limits and the supported message corpus.
2. **Safe ingestion — #43 and verified SMS rules — #46:** agree on transactional cursor/replay behavior, protected edits and tombstones, key-loss handling, safe-money validation, and explicit review outcomes. Keep the two work items focused; integrate the contract before connecting capture.
3. **Android capture — #44:** add opt-in receiver and bounded history catch-up, then exercise new-message delivery, multipart messages, app-open recovery, and best-effort background work on the exact supported build.
4. **Release — #56:** publish supported institutions/formats and Android limits, and attach evidence for the exact release revision. The F-Droid source-build and dependency audit in [#27](https://github.com/Starforge-lab/finance-bro/issues/27) remains a separate distribution gate. It does not require implementing encrypted backup.

Suvo owns Android and shared integration. Rohan remains the independent reviewer and design owner; existing iOS work stays in its backlog and does not block this Android-only scope.

## Acceptance evidence

Use fictional messages and an isolated ledger on the exact Android build. Record source revision, device/OS, permission state, and parser-rule versions. Cover:

- First-run history preview and confirmation; cancellation leaves the ledger untouched.
- Permission denied, later granted, and revoked; manual and paste flows continue to work.
- New single-part and multipart SMS, bounded inbox catch-up, and app-open catch-up. Verify and document WorkManager, force-stop, and locked-key behavior without promising delivery Android cannot guarantee.
- A missing inbox row or unavailable source identity does not lose a transaction silently or advance a cursor past recoverable work.
- Replaying one SMS creates one transaction; two genuine identical purchases both survive; replay preserves a protected edit and a deletion tombstone.
- Verified messages save exact integer paise. Unknown account, malformed amount, unsupported format, and uncertain parse require review.
- Failure and retry do not leave partial ledger writes. Inspection confirms no raw SMS text was retained in storage or diagnostics.

Readiness requires all in-scope cases to pass on the exact release source, no false-positive auto-saves in the labelled corpus, no duplicate or lost accepted transactions in the replay matrix, and no regression to manual use with SMS permission denied. Report corpus size, institutions, rule versions, device and known Android/OEM limits; do not claim universal bank coverage or reliable background delivery. Release and F-Droid gates must be recorded separately from feature evidence.

## Deferred beyond 2.0

These remain later work and are not 2.0 blockers: iOS Shortcuts/SMS (#17, #34, #45, #55); encrypted backup and restore (#42); reconciliation and transfers (#47); recurring planning (#48); [forecasts (#49)](https://github.com/Starforge-lab/finance-bro/issues/49) and [insights (#50)](https://github.com/Starforge-lab/finance-bro/issues/50); receipt OCR (#51); Gmail import (#52–#53); widgets and other native conveniences (#54); and [merchant correction rules (#76)](https://github.com/Starforge-lab/finance-bro/issues/76). Notification-listener access, cloud services, bank linking, and new import providers are out of scope.

Track delivery evidence in #58 and the owning issues. A merged PR, successful bundle, or permission prompt alone does not prove native SMS capture or release readiness.
