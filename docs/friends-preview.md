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
