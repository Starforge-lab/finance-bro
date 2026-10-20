# Friends preview checkpoint — 20 October 2026

This is a shareable experimental Android preview with SMS discovery first. It is not stable 2.0 acceptance or a broad bank-support claim.

## Artifact

- [Download APK](https://expo.dev/artifacts/eas/eSGUUSCkAVL-sA2IDN1A-zSZPLI4DgFQfAqnTCUd4Cc.apk) · [EAS build](https://expo.dev/accounts/starforge-lab/projects/finance-bro/builds/26ae5550-bf23-4800-ae0e-ade25bc2e050)
- Source: `84bb68e75ecfb689522e4caea01755a38d206957`; subsequent preview commits change documentation only.
- Identity: `com.rohangupta.financebro.preview`, Finance Bro Preview, version `0.1.0`, version code `2`.
- APK size: 116,717,290 bytes. Minimum SDK 24; target SDK 36. Device checks cover one Motorola Edge 60 Pro on Android 17/API 37.
- SHA-256: `6eafe12abe997082c92ab5194cad63556cacd69a6a569c61ee3a373bbe42820f`.
- Signing certificate SHA-256: `93a709548d44977bb9dcba31c2a8d59ecb4e373608c324d5fa155c7aaaf3c7e8`.

Google SDK `apksigner verify` passed with one v2 signer matching the original preview key. The device accepted a compatible update. Compiled manifest/resource inspection verified backup disabled, all nine storage domains excluded from legacy/cloud/device transfer, QA probes off, an embedded Android bundle, and no SEND_SMS permission. Android's SMS permission dialog uses the generic “send and view” wording despite this app declaring read/receive only.

The first baseline (`38c22ef`) crashed before JavaScript: its optimized WorkManager database implementation had no constructor. The rebuilt APK retains that constructor and passes repeated cold launches without Metro. Release optimization remains enabled; no dependency upgrade was used.

## Observed checks

- Frozen installation, typecheck, lint, 323 mobile tests, 155 parser tests, installed-SDK compatibility, Doctor 20/20 and all-platform export passed on 19 October. CI, CodeQL and Android development checks also passed for the preview head. See PR #98 for current check links.
- The exact signed APK cold-launched without Metro, saved a fictional manual entry with SMS denied, and handled Android's permission-denial recovery text.
- Its consented read-only 90-day provider preview could be cancelled. Import stayed off, with zero entries/accounts/reviews after the cancellation check. No real messages were imported into its ledger and no private examples or counts are published here.
- A fictional generic bank message prefilled ₹47.35, was explicitly corrected to ₹40.00, saved and cleared its text. Cold restart retained one entry/₹40. Replaying it reported “Already handled” and changed nothing.
- The exact HDFC card fixture prefilled correctly in the browser; a correction survived browser reload. Earlier isolated native fixture/storage checks remain separate from the signed-APK generic-message check. Automated typing through the phone keyboard changed the strict card fixture's casing, so that attempt is not counted as exact-format native acceptance.
- Light/dark screens and readable Home controls at font scale 1.3 were checked. The original font setting was restored. This is not TalkBack or full accessibility acceptance.
- Four repeated empty-Home cold launches had Spending below the empty Today panel. One earlier v1-to-v2 first-upgrade capture showed overlap; it was not reproduced after a clean reset. Its cause remains uncertain, and no speculative animation change was made.
- An isolated 10k/50k native SQLite check with production/minified JavaScript passed exact totals/counts. Single 50k/all-in-one-month samples were 1,851 ms for summary, 1,679 ms for month navigation and 3,643 ms for entries. The native host was a development client; these are not release UI/startup or controlled comparison timings. The disposable database was deleted.

## Use and limits

Open SMS imports from Home, preview the date range, then confirm only if you want imports enabled. Permission alone does not start imports. Add your bank accounts and matching suffixes in Settings for supported formats to resolve; ambiguous mappings stay in review. Manual entry and paste work with SMS denied.

Only `hdfc.upi.credit@2` is eligible for automatic saving, subject to its exact format, safe amount, strong UPI reference and a single active matching HDFC bank account. The strict HDFC card-UPI format provides a review-only candidate. Other bank/app formats may get generic review fields or need manual completion. The popular-provider list is a coverage priority, not verified support.

Live/multipart delivery, naturally timed background/reboot/OEM behavior, ordinary friends' installer/SMS-grant paths, device transfer/restore, full native key-loss/unavailability, TalkBack and full 10k/50k screen responsiveness remain unverified. No external SMS sender was available. SMS totals can be incomplete; this preview is not a sole financial record. Backup/recovery is not provided, and uninstalling removes local data. Preserve important records separately.

Existing extreme-amount Home arithmetic defects are tracked in [#99](https://github.com/Starforge-lab/finance-bro/issues/99); performance work remains in [#71](https://github.com/Starforge-lab/finance-bro/issues/71). The frozen dependency advisories in SECURITY.md, F-Droid source/publication gates and the draft upstream PR acceptance gates remain open. This checkpoint does not waive them.
