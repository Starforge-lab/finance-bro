# Android friends preview

Target: a standalone, shareable APK by 20 October 2026, 23:00 IST. SMS is the primary first-use flow, with explicit opt-in and review for uncertain formats. This is an experimental personal preview, not completion of the stable 2.0 acceptance gates.

The `friends` EAS profile builds an internal APK with embedded JavaScript. It uses `com.rohangupta.financebro.preview`, the name **Finance Bro Preview**, and the `financebropreview` scheme. Its local ledger is separate from production, development and SMS QA installs. QA probes are disabled. It needs no Metro server. The original `preview` profile retains its existing production identity.

Run from `apps/mobile`: `eas build --platform android --profile friends`. Signing setup and any paid build require explicit authorization; use existing project access and a free build. Never commit credentials or signing keys. Preserve the preview signing key for future compatible updates. Uninstalling the preview removes its local data; no backup or recovery service is provided.

Before sharing:

- Run the repository checks, Expo compatibility check, Doctor and all-platform export.
- Inspect the exact APK identity, signing certificate, embedded bundle, permissions and QA flags; record its source commit and SHA-256.
- On an isolated fictional ledger, verify cold launch without Metro, manual entry, permission denial, cancellable SMS preview, consent, review/correction and restart persistence.
- Use only fictional messages for import acceptance. A local read-only inbox coverage check does not authorize ledger import or publication of private examples or aggregates.
- Keep unsupported/ambiguous messages in review. A recognized bank sender or a popular UPI app does not establish format coverage. Only fixture-backed verified formats may auto-save.
- Report the remaining live delivery, multipart, natural background/reboot/OEM, key-loss, accessibility and performance gates from [SMS acceptance](android-sms-acceptance-20261017.md). No external SMS sender is available for the current check.

SMS setup and review are first in Android Settings and reachable directly from Home. Permission alone does not enable imports. Users can turn imports off and keep using manual entry. Raw message text is transient and never stored in the ledger or logs.

## Coverage priorities

The [NPCI ecosystem statistics](https://www.npci.org.in/product/ecosystem-statistics/upi), September 2026 selection checked on 19 October, provide a concrete interpretation of popular providers. Their first ten bank-volume rows are SBI, HDFC, Bank of Baroda, Union Bank, PNB, Canara, Kotak, Axis, Indian Bank and ICICI. Their first ten UPI application rows are PhonePe, Google Pay, Paytm, Navi, super.money, BHIM, FamApp, WhatsApp, Kotak apps and CRED.

These are coverage priorities, not supported-format claims. UPI app rankings do not establish which bank SMS templates a user receives. Verify debit, credit, card and reversal formats separately with anonymised positive and negative fixtures; retain uncertain formats in review. The current automatic-save allowlist remains the verified HDFC UPI credit rule version.

The observed HDFC card-UPI `Txn` alert now supplies a medium-confidence candidate with exact paise, card suffix, merchant/VPA and reference. It requires explicit review and is excluded from the automatic-save allowlist. Its body omits the year, so the candidate retains SMS arrival time for date review. Masked, malformed and unsupported variants remain in review without invented fields.
