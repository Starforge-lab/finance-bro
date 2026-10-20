# Android friends preview

Target: a standalone, shareable APK by 20 October 2026, 23:00 IST. SMS is the primary first-use flow, with explicit opt-in and review for uncertain formats. This is an experimental personal preview, not completion of the stable 2.0 acceptance gates.

The signed version-code-2 APK and its bounded device checks are recorded in [the 20 October preview checkpoint](friends-preview-20261020.md). Use that artifact; the earlier baseline crashes on startup.

The `friends` EAS profile builds an internal APK with embedded JavaScript. It uses `com.rohangupta.financebro.preview`, the name **Finance Bro Preview**, and the `financebropreview` scheme. Its local ledger is separate from production, development and SMS QA installs. QA probes are disabled. It needs no Metro server. The original `preview` profile retains its existing production identity.

Android automatic backup is disabled. Explicit Android 11-and-earlier backup rules and Android 12+ cloud/device-transfer rules exclude all app storage domains, including SMS consent preferences and device-protected storage. This replaces SecureStore's preference-only backup rules, which excluded the ledger and key but could transfer opt-in settings. Keep records local until an explicitly approved recovery mechanism is implemented. See [Android backup behavior](https://developer.android.com/identity/data/autobackup); OEM backup/transfer behavior still needs separate device-transfer acceptance.

No iOS cross-platform pairing metadata is configured. In [AOSP API 37 eligibility rules](https://android.googlesource.com/platform/frameworks/base/+/94b4c163b7dfe5ce3607f7bb8456f9573f7de57d/services/backup/java/com/android/server/backup/utils/BackupEligibilityRules.java), cross-platform transfer requires both `allowBackup` and platform-specific pairing parameters; this app supplies neither. Do not add fictitious iOS identifiers to the extraction rules. This source check does not prove every manufacturer's transfer behavior.

Run from `apps/mobile`: `eas build --platform android --profile friends`. Android version codes increment for compatible preview updates. Signing setup and any paid build require explicit authorization; use existing project access and a free build. Never commit credentials or signing keys. Preserve the preview signing key for future compatible updates. Uninstalling the preview removes its local data; no backup or recovery service is provided.

The first signed baseline (`38c22ef`) crashed in WorkManager initialization before JavaScript loaded. Its optimized DEX retained `WorkDatabase_Impl` without a constructor. The SMS module now supplies [AndroidX's Room constructor keep rule](https://android.googlesource.com/platform/frameworks/support/+/e4765e38e27a3f4d86188b996df97a52403dff46) through its consumer ProGuard configuration. Release optimization remains enabled. Verify the constructor and cold launch in the rebuilt signed APK; a development-client launch cannot validate this fix. Do not share the crashing baseline.

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
