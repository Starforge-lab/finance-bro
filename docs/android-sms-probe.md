# Android SMS feasibility probe

This is the bounded native probe for [issue #16](https://github.com/Starforge-lab/finance-bro/issues/16), a prerequisite for Android SMS-only 2.0. It does not implement automatic ledger ingestion or prove background JavaScript execution. Follow the confirmed scope in [the 2.0 roadmap](v2-roadmap.md).

## Build isolation and consent

The local Expo module is compiled into the development client. Its manifest permissions and receiver are enabled only when both `APP_VARIANT=development` and `ANDROID_SMS_PROBE=1` are set. The probe uses package `com.rohangupta.financebro.smsqa.dev` and scheme `financebrosmsqa`; ordinary development and production packages keep their existing identities and have no probe permission declarations or receiver.

Use the `Android development APK` workflow's `android_sms_probe=true` dispatch input on the exact reviewed branch. Generated Android files remain uncommitted. A matching client must be installed before testing native APIs; an Expo export is not native proof.

Request separate explicit consent before granting SMS permissions or querying a real phone's inbox. Permission denial must leave manual entry and paste usable. Never grant permissions through ADB, read a personal ledger, or publish SMS sender/body values. Do not send, delete or mark messages read.

## Native contract

- `getSmsReader()` returns the optional native module, or `null` on unsupported platforms.
- Permission methods report `READ_SMS` and `RECEIVE_SMS` separately. A permission request is a deliberate user action, never a side effect of module import.
- Inbox reads are transient, strictly bounded and ordered by date plus platform id. Platform ids remain strings. The maximum batch is 100 and the maximum requested time window is 90 days. A compound cursor advances within that fixed window.
- The receiver records aggregate wake count, receipt time and multipart count only. It stores no sender, body, parsed candidate or financial value. Receiver wake metadata is evidence of delivery, not evidence of parsing or saving.
- The bridge returns bodies only for immediate on-device processing. Do not serialize its results to files, logs, analytics, crash reports or a durable queue. Production review must re-open the original by reference or use manual/paste recovery if it is gone.
- No headless runtime, WorkManager task, notification permission, network service or production import screen is introduced by the probe.

Use the existing pure parser and shared SQLite/HMAC contract in an isolated fictional-data harness to establish the foreground handoff. Do not auto-save real records during feasibility testing. Production ingestion must still implement correction/tombstone protection, key-unavailable handling, duplicate review and a committed catch-up cursor in #43/#44.

## Required evidence

All native results below are pending until exercised on a matching build. Keep synthetic evidence separate from physical-device evidence.

| Check | Evidence required |
| --- | --- |
| Default manifests | No probe SMS permissions or receiver in ordinary development/production manifests |
| Probe manifest and autolinking | Correct package, two read-only permissions, receiver and compiled Expo module |
| Permission denial/revocation | Calls reject safely; manual/paste remain usable |
| Bounded inbox query | Stable pagination, boundary timestamps, equal-date ids, empty/missing rows; no durable raw text |
| Live multipart receipt | Fictional SMS received with expected aggregate wake/part metadata |
| Foreground parser/SQLite | Fictional corpus parses, saves and replays safely in an isolated database |
| Process kill/reboot/unlock | Record actual receiver and app-open catch-up behavior |
| Force-stop/reopen and battery limits | Document missed wakes and required recovery; do not promise delivery while force-stopped |
| Locked/missing fingerprint key | Defer or require explicit duplicate review; no silent duplicate import |
| Distribution | Verify installer permission restrictions for the intended channel separately from debug installation |

Issue #16 stays open until its device matrix and go/no-go recommendation are complete. This probe alone does not satisfy the Android SMS 2.0 release gates.

References: [Expo local modules](https://docs.expo.dev/modules/get-started/), [Expo module API](https://docs.expo.dev/modules/module-api/), [Android SMS intents](https://developer.android.com/reference/android/provider/Telephony.Sms.Intents), and [Android manifest permissions](https://developer.android.com/reference/android/Manifest.permission).
