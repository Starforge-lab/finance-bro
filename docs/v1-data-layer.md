# V1 local data and business layer

Scope confirmed by Suvo on 2026-10-07: the complete local data layer for the manual-first MVP (#8–#15). Shared screen integration follows the approved Ink and Stamps design. Rohan owns all iOS-specific implementation and physical-device validation; shared app, Android and web work are handled here. There is no hosted backend, app account, network prerequisite, analytics or automatic message access. Automatic Android/iOS capture, receipt OCR, connected email, forecasts and encrypted backup/restore remain separate work.

## Screen contract

Call `await getLedger()` from `apps/mobile/src/db/index.ts`. It opens one persistent Expo SQLite database, applies generated migrations and returns the composed API. Failed opening/migration rejects without resetting data; a later call can retry. Always await writes and preserve form input until the promise resolves. The screen API hides raw database access and low-level import writes; infrastructure/tests can use `createLedger` separately.

| Workflow | API |
| --- | --- |
| Manual expense/income | `saveManualEntry({ id, amountInr, direction, occurredAt, categoryId?, accountId?, note? })` |
| Transaction details/feed | `getTransaction(id)`, `listTransactions({ month?, categoryId?, accountId?, direction? })` |
| Corrections/deletion | `editTransaction(id, patch)`, `softDeleteTransaction(id)` |
| Account setup | `createAccount`, `listAccounts`, `updateAccount`, `archiveAccount` |
| Category setup | `createCategory`, `listCategories`, `updateCategory`, `deleteCategory` |
| Monthly totals | `getMonthlySummary('YYYY-MM')` |
| Monthly category budgets | `setBudget`, `editBudget`, `removeBudget`, `listBudgets`, `getBudgetSummary` |
| Bills | `createBill`, `editBill`, `removeBill`, `setBillPaid`, `listBills(today)` |
| Paste review | `preparePaste(raw)`, then `saveReviewedPaste(prepared, corrections, options?)` after confirmation |
| CSV content | `exportTransactionsCsv()` |

IDs are caller-supplied and stable. Keep the same manual-entry ID during retries or simultaneous submits: a duplicate ID rejects and preserves the saved row. A new ID denotes a new entry. Validation/storage errors propagate to the screen; the data layer never clears user input or silently falls back to ephemeral storage.

Manual INR input accepts plain decimal digits, optional one/two decimal places and surrounding whitespace (`450`, `450.5`, `450.50`). Currency symbols, grouping separators, exponent notation, signs and fractional paise are rejected. Conversion uses integer arithmetic; amounts must be positive safe integer paise. Dates at transaction boundaries are valid `Date` objects. Bills use actual calendar `YYYY-MM-DD` dates; `listBills` receives today's date explicitly. Categories referenced by transactions, tombstones, budgets or child categories cannot be deleted. Budget categories must remain expense categories.

## Approved calculation rules

Month selection uses India calendar boundaries (UTC+05:30), independent of device timezone. Only posted, non-deleted records without `excludeFromStats` enter totals. Spending counts debit expenses and subtracts credit refunds/reversals in their receipt month. Income counts credit income. Transfers, cash withdrawals, pending/failed entries and other direction/kind combinations are excluded. Category budgets use exactly the same expense calculation. Empty totals are zero; no budgets returns an empty list; remaining amounts can be negative or exceed the original budget after refunds. Unsafe aggregate/remaining amounts reject instead of rounding.

These are recorded cash-flow totals, not account balances or forecasts. A paid bill does not create a transaction or change spending. Bill status is paid, otherwise overdue when its due date precedes the supplied day, otherwise upcoming (including today). Recurrence and notifications are deferred.

## Paste identity and recovery

Preparation is asynchronous and uses device-keyed HMAC-SHA256, with separate domains for key identity, body fingerprints and transaction identity. Matching UPI references/direction/status/kind share identity across alerts and cannot be split by time. Otherwise identical sender/body text shares identity independently of paste time. On a collision, review defaults to the existing paste; the user may deliberately choose a separate payment and select its India date and time. That choice derives a stable keyed identity from the original body identity and the selected epoch-second, so retries resolve to the same row and edits/tombstones remain protected. The original paste identity is unchanged. Distinct purchases in the same second cannot be disambiguated here and must be entered manually. Preparation retains candidates and keyed metadata, never the raw body. The screen owns transient raw input and clears it after completion/dismissal, without logging it.

Native secrets use Expo SecureStore; browser secrets are nonextractable WebCrypto keys in IndexedDB. The financial database remains SQLite on all platforms; IndexedDB stores only the browser key. No secret enters SQLite, CSV, telemetry or logs. Browser key protection depends on the browser profile and origin; this is not protection against malicious same-origin code or an unlocked compromised device. Crypto/store failures reject; there is no weak-hash fallback. [Expo Crypto](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/), [SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/).

SQLite retains a public key identifier. If the key changes or legacy pasted rows have no identifier, preparation reports `duplicateReviewRequired: true`; save raises `DuplicateReviewRequiredError` unless the user explicitly confirms duplicate risk with `{ acknowledgeDuplicateRisk: true }`. This requirement continues for future pastes while the old marker remains. Existing rows/corrections/tombstones stay intact; the API does not pretend a new key can deduplicate against an old key. Legacy fingerprints cannot be recomputed without originals. Key recovery/portability through encrypted backup is deferred. Fresh keyed imports atomically insert or return `duplicate`; they never overwrite user corrections or resurrect tombstones.

## CSV boundary

CSV content is generated locally after explicit user initiation and is never uploaded automatically. Android opens the system single-file `ACTION_CREATE_DOCUMENT` picker for `text/csv`; cancellation returns before file creation, and a failed write attempts to delete only the selected document. A successful picker result without a document URI is an error. The browser adapter requests a download; iOS destination support remains Rohan's work. Columns in stable order: `id, amount_inr, direction, kind, status, occurred_at, category_id, category_name, account_id, account_name, source, counterparty, note`. INR values have exactly two decimal places; timestamps are UTC ISO strings. All non-deleted records are included, including failed/pending/excluded records, rather than just statistics-eligible records. Fields use double-quote escaping and CRLF record separators. Formula-like user text, including leading whitespace/control characters before `=`, `+`, `-` or `@`, receives an apostrophe prefix. Raw messages, import references, fingerprints and credentials are excluded. CSV is neither a complete restore format nor encrypted backup.

## Verification and release gates

Observed on 2026-10-07: frozen install, `pnpm check` (27 mobile/data tests and 31 parser tests), Expo dependency check, Expo Doctor (20/20), Android/iOS/web bundle exports and tracked diff whitespace checks passed. The final Node suite includes all five migrations and transaction/category integrity triggers.

A temporary fictional-data harness passed seven SQLite business/persistence checks on the connected Motorola Edge 60 Pro, including a process restart, and in browser OPFS SQLite, including reload. The browser also exercised the actual WebCrypto/IndexedDB adapter: concurrent saves deduplicated, the key persisted across reload, and deleting the generated test key required explicit duplicate-risk review. These platform observations preceded the final integrity migration/API guards; they do not establish final-revision platform validation. Isolated test databases/browser key were removed and the original app route restored. Those earlier native tests used a deterministic test signer and did not verify SecureStore/Crypto; see the final-revision follow-up below.

Final-revision follow-up on 2026-10-07: [Android build 37625072552](https://github.com/Starforge-lab/finance-bro/actions/runs/37625072552) built development client dependencies from commit `4228c54`; `adb install -r` succeeded. On the Motorola Edge 60 Pro (Android 17), the current JavaScript/native adapter passed RFC 4231 HMAC case 1 using actual Expo Crypto, all seven SQLite business checks with five migrations, concurrent keyed paste deduplication and restart persistence (process IDs changed from 29944 to 30168). Deleting only the harness-created SecureStore key and restarting produced `duplicateReviewRequired` and `DuplicateReviewRequiredError`, blocking unacknowledged saves. This uncovered and fixed Expo Crypto's native requirement for a typed-array view rather than an ArrayBuffer. Final browser OPFS SQLite also passed all seven business checks and seven reopen checks. Temporary routes/harnesses were removed; isolated databases and the owned native key were deleted, with ADB confirming no `v1-final*` database remained. Existing app data and pre-existing keys were preserved. iOS device behavior and human screen usability remain unverified.

`pnpm check` runs the SQLite-backed migration/persistence, manual validation, CRUD, totals/month boundaries, budget/bill, CSV, HMAC test-vector and import key-loss checks. `test/runtime-check.ts` supplies a reusable fictional-data scenario for native/browser storage, separate from the application's main ledger.

Native SecureStore/Crypto dependencies require a rebuilt development client. Verify the actual platform adapters and restart persistence on Android/iOS; web must verify OPFS SQLite and IndexedDB key persistence on a secure origin with required isolation headers. [Issue #34](https://github.com/Starforge-lab/finance-bro/issues/34) tracks the outstanding iOS data-layer device gate owned by Rohan. His iOS-device results are required before claiming iOS readiness. Bundle exports and Node tests are insufficient evidence for those platform gates. The Android CSV picker and write/cleanup behavior still need confirmation on a real device; iOS CSV destination support and device verification remain Rohan's work.
