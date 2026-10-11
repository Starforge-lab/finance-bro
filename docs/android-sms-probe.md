# Android SMS feasibility probe

This is the bounded native probe for [issue #16](https://github.com/Starforge-lab/finance-bro/issues/16), a prerequisite for Android SMS-only 2.0. It does not implement automatic ledger ingestion. A separate fictional-data check exercises the SDK background-task API; a development test trigger does not prove natural scheduling or headless-process execution. Follow the confirmed scope in [the 2.0 roadmap](v2-roadmap.md).

## Build isolation and consent

The local Expo module is compiled into the development client. Its manifest permissions and receiver are enabled only when both `APP_VARIANT=development` and `ANDROID_SMS_PROBE=1` are set. The probe uses package `com.rohangupta.financebro.smsqa.dev` and scheme `financebrosmsqa`; ordinary development and production packages keep their existing identities and have no probe permission declarations or receiver.

The `extra.androidBackgroundProbe` flag uses the same gate. The temporary probe entry must import `apps/mobile/test/sms-background-check.ts` before `expo-router/entry`; the production entry must not import it. Importing the helper from a route layout alone does not establish cold headless availability: Router registers its React root without rendering the route tree, whereas TaskManager's headless loader starts the task without rendering that root. Its helpers register one 15-minute-minimum task, unregister it, request the SDK's development-only test trigger, and read the last QA report. The task is defined at module scope so TaskManager can resolve it when the module is loaded. No iOS background configuration is enabled for this Android-only experiment.

Use the `Android development APK` workflow's `android_sms_probe=true` dispatch input on the exact reviewed branch. Generated Android files remain uncommitted. A matching client must be installed before testing native APIs; an Expo export is not native proof.

Request separate explicit consent before granting SMS permissions or querying a real phone's inbox. Permission denial must leave manual entry and paste usable. Never grant permissions through ADB, read a personal ledger, or publish SMS sender/body values. Do not send, delete or mark messages read.

## Native contract

- `getSmsReader()` returns the optional native module, or `null` on unsupported platforms.
- Permission methods report `READ_SMS` and `RECEIVE_SMS` separately. A permission request is a deliberate user action, never a side effect of module import.
- Inbox reads are transient, strictly bounded and ordered by date plus platform id. Platform ids remain strings. The maximum batch is 100 and the maximum requested time window is 90 days. A compound cursor advances within that fixed window.
- The receiver records aggregate wake count, receipt time and multipart count only. It stores no sender, body, parsed candidate or financial value. Receiver wake metadata is evidence of delivery, not evidence of parsing or saving.
- The bridge returns bodies only for immediate on-device processing. Do not serialize its results to files, logs, analytics, crash reports or a durable queue. Production review must re-open the original by reference or use manual/paste recovery if it is gone.
- The background check uses the existing fictional runtime fixture with Expo SQLite and `getFingerprinter()` backed by SecureStore/Crypto in the isolated probe package. Each run opens a fresh, uniquely named SQLite fixture database, closes it, and deletes it. It never queries the inbox, reads the personal ledger or saves SMS values. The fixture's HMAC key remains in the isolated probe package's protected storage and is never included in the report.
- The fixed `finance-bro-sms-background-qa.json` report is written in the app document directory. A test-trigger request replaces the prior report with `started` before dispatch, and each task writes `started` before opening its fixture database. If Android interrupts work, the latest report therefore remains incomplete instead of showing an earlier pass. It contains only static check names, started/passed/failed and cleanup status, a curated failure stage, timestamps, invocation type and React Native `AppState`; it never includes error messages, sender/body, source references or key material. A failed cleanup or report write returns a failed task result.
- Android uses WorkManager with a minimum 15-minute interval; execution time is inexact and system-controlled. SDK 58's Android implementation also requires a connected network, even though this fixture is local-only. Therefore this probe cannot establish offline background capture, and using this API for a future offline import remains undecided.
- The development test-trigger helper is available only in a debug build. Expo's Android source runs registered callbacks only when the app is already backgrounded; when called in the foreground it schedules work for later instead. A report marked `test-trigger-call-window` means the callback began while that helper call was still pending; `origin-unknown` makes no claim about how it was scheduled. Natural WorkManager scheduling needs a separate device observation; headless-process proof additionally requires the callback to run after the JS process has been terminated and restarted by the system. A helper return value alone is not proof that the fixture callback ran.
- No production SMS import screen, SMS permission or SMS receiver is added by the background-task code. Native Expo TaskManager components may be autolinked with the dependency, but SMS reader permissions and the SMS wake receiver remain gated by the existing probe build configuration.

Use the existing pure parser and shared SQLite/HMAC contract in an isolated fictional-data harness to establish the foreground handoff. Do not auto-save real records during feasibility testing. Production ingestion must still implement correction/tombstone protection, key-unavailable handling, duplicate review and a committed catch-up cursor in #43/#44.

## Required evidence

Keep synthetic evidence separate from physical-device evidence. On 2026-10-11, the [matching ARM64 build](https://github.com/Starforge-lab/finance-bro/actions/runs/38117321881) at `89f59fe73f0adfa725341f50cd2c58b9ceb4b0c4` passed on a Motorola edge 60 pro running Android 17/API 37. APK SHA256: `5a212dd684d807affa8e37034fc02cbae0b7c44c903b15a2213cc87ae16b1802`.

The reusable fictional harness in `apps/mobile/test/sms-runtime-check.ts` passed on both Node SQLite and physical-device Expo SQLite/HMAC: parser handoff, exact paise and transaction semantics, a platform id above JavaScript's safe integer range kept as a string, no stored body, and correction/tombstone protection on replay. The isolated fictional database was closed and deleted. This is a probe fixture, not the production eligibility or ingestion policy.

A separately consented inbox probe checked a fixed preceding 24-hour window with a maximum of 20 returned messages. Range, strict compound order and pagination checks passed; only counts/checks were reported locally, with no sender, body, platform id or ledger write. Both SMS permissions were revoked afterward; a fresh run reported denial and rejected inbox access. See [the device record](https://github.com/Starforge-lab/finance-bro/issues/16#issuecomment-6106309184). These development-client results do not prove release-build behavior or the remaining matrix below.

Expo SDK 58 uses WorkManager on Android. Its documented interval is a minimum of 15 minutes, not a schedule guarantee; its installed Android implementation additionally sets a `CONNECTED` network constraint. The QA test trigger is development-only and may schedule work instead of invoking it immediately when the app is foregrounded. A callback recorded as `origin-unknown` is not by itself headless-process evidence; verify process termination/restart independently. If Android terminates the process before fixture cleanup, the unique QA database may remain until manually cleaned; it contains only fictional fixture values. See the [SDK 58 BackgroundTask reference](https://docs.expo.dev/versions/v58.0.0/sdk/background-task/) and [TaskManager reference](https://docs.expo.dev/versions/v58.0.0/sdk/task-manager/).

On 2026-10-11, the matching background client at `dbd9635d682cf6d6e7e0bef90679bef66aea642e` built successfully in [run 38120051487](https://github.com/Starforge-lab/finance-bro/actions/runs/38120051487). APK SHA256: `c26f2e8b0a3f1ff3854ff5c5f5494b1b255810b924a9b36982e61558b0e8f8ba`. On the same physical device, the development-triggered callback reported `appState: background`, seven passing fictional checks and passing database cleanup. It completed in 356 ms. This establishes background execution while the existing JS runtime was alive, not natural scheduling or a cold headless start. See [the device record](https://github.com/Starforge-lab/finance-bro/issues/16#issuecomment-6106660704).

A subsequent forced WorkManager request and scoped background-process termination produced no newer callback report. Android restarted the native process, but the job later remained waiting on timing and connectivity constraints. The old report must not be counted as a forced or headless pass. Source inspection identified the route-only task import as a cold-start gap; a temporary global-entry experiment bundles and typechecks, but its native result remains pending. Phone privacy/network settings were not changed.

| Check | Evidence required |
| --- | --- |
| Default manifests | No probe SMS permissions or receiver in ordinary development/production manifests |
| Probe manifest and autolinking | Correct package, two read-only permissions, receiver and compiled Expo module |
| Permission denial/revocation | Initial and post-revocation rejection passed; manual/paste fallback still needs its own flow check |
| Bounded inbox query | Consented foreground range/order/pagination passed; boundary timestamps, equal-date ids and empty/missing-row cases remain unverified |
| Background test trigger | Seven fictional SQLite/HMAC checks and cleanup passed on the matching `dbd9635` Android client; a development trigger does not prove WorkManager scheduling |
| Natural scheduled/headless execution | Pending physical-device proof after app background/process termination; WorkManager's SDK 58 network constraint means offline execution is not covered |
| Live multipart receipt | Fictional SMS received with expected aggregate wake/part metadata |
| Foreground parser/SQLite | Fictional fixture passed on Expo SQLite/HMAC with database cleanup; a verified bank corpus and production ingestion policy remain pending |
| Process kill/reboot/unlock | Record actual receiver and app-open catch-up behavior |
| Force-stop/reopen and battery limits | Document missed wakes and required recovery; do not promise delivery while force-stopped |
| Locked/missing fingerprint key | Defer or require explicit duplicate review; no silent duplicate import |
| Distribution | Verify installer permission restrictions for the intended channel separately from debug installation |

Issue #16 stays open until its device matrix and go/no-go recommendation are complete. This probe alone does not satisfy the Android SMS 2.0 release gates.

### Cold development-client limit

Installed SDK 58 source inspection shows that `RNHeadlessAppLoader` starts the application's ReactHost without using the task's stored `appUrl` to select a development project. React Native can try Metro when development support is enabled, but the interactive development launcher's selected manifest and bundle-loader injection are not established by this headless path. A reachable Metro server and a registered task therefore do not prove that a cold process loaded the intended probe entry.

On the same device, scheduler job 6 reached pending/ready with timing, connectivity and quota satisfied while no probe process or newer fictional report was present. This is scheduler evidence, not a passing or failed JavaScript callback. Preserve the distinction from the earlier development-triggered pass.

A subsequent manually requested run of the same ready job produced a new native PID and a fresh passing report: `startedAtMs=1791730510566`, `completedAtMs=1791730511272`, `appState=background`, `invocation=origin-unknown`, all seven fictional checks and cleanup passed. The probe process was absent before the request; own-package native logs recorded worker start, one restored consumer, headless task start and completion. This establishes one cold headless execution with Metro available on the installed `dbd9635` client and the temporary global probe entry. The native request used the ordinary scheduler run command, without forced constraints or standby changes. Its externally observed provenance is a manual scheduler request, regardless of the report's `origin-unknown` label.

This result does not prove natural delivery, offline operation, production imports or a bundled release. A standalone embedded-bundle probe remains useful if those runtime conditions need to be isolated; do not repeat builds merely to reproduce this passing development-client case. Record the exact APK and source, and keep manually requested invocations separate from natural scheduling.

References: [Expo local modules](https://docs.expo.dev/modules/get-started/), [Expo module API](https://docs.expo.dev/modules/module-api/), [Expo SDK 58 BackgroundTask](https://docs.expo.dev/versions/v58.0.0/sdk/background-task/), [Expo SDK 58 TaskManager](https://docs.expo.dev/versions/v58.0.0/sdk/task-manager/), [Android SMS intents](https://developer.android.com/reference/android/provider/Telephony.Sms.Intents), and [Android manifest permissions](https://developer.android.com/reference/android/Manifest.permission).
