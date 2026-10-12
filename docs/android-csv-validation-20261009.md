# Android CSV destination validation

PR #66 implements one-document save-as for #15. This check uses fictional CSV
content only; it does not open the user's ledger or request folder access.

## Observed failure

On the Motorola Edge 60 Pro, Android 17, the development client built before the
patch opened the system picker, but saving failed. Both `File.write` and
`File.delete` rejected the destination because it was an Android `Intent`
description rather than a `content://` URI. A temporary blank QA route made the
failed test appear as a black screen; the app process remained running.

The installed `expo-intent-launcher@58.0.3` bridge calls `toString()` on
`OnActivityResultPayload.data`, which is an `Intent`. The pinned pnpm patch calls
`toString()` on that intent's `data` URI instead, preserving extras and result
codes. Remove the patch when a compatible upstream release includes this fix.
This changes native code: existing development clients must be rebuilt.

The first rebuilt client (`c6db4d4`, APK run `37967460598`) passed cancellation
but saving still returned an invalid destination. Its Gradle log linked
`expo-intent-launcher` as a precompiled publication, so the source patch did not
reach that binary. The application now opts just this module into
`expo.autolinking.android.buildFromSource`. This is required for patched native
source under SDK 58; a successful APK build alone did not prove the fix shipped.
See [Expo's precompiled-module guidance](https://docs.expo.dev/guides/prebuilt-expo-modules/).

The shared destination helper also rejects malformed or non-content destinations
before any write or cleanup operation. Its regression test failed before the
guard and passed after it. The patch is version-specific and recorded in the
lockfile. The patch keeps the launcher version and build-script permissions
unchanged; the compatible SDK refresh from #74 is integrated separately.

## Passed physical checks — 2026-10-10

Source `f94cf097c41b54225bc27533facbd380a0f35f21`, APK
[run 38061188406](https://github.com/Starforge-lab/finance-bro/actions/runs/38061188406),
SHA-256 `CA2F9259D7AE10997CDA893D2F2E73EAC007188BBBB63766D4A8BCD626AC0149`.
The build log contains `:expo-intent-launcher:compileDebugKotlin`, demonstrating
source compilation of the patched module. The APK was installed with a
data-preserving replacement on the same Motorola Edge 60 Pro / Android 17.

All three user-driven picker cases passed in the app-private QA report:

1. Cancel: `saveCsv` returns `cancelled` without touching a document.
2. Save: the single chosen document reads back the exact fictional CSV bytes.
3. Injected write failure: only that incomplete document is removed, and the
   original injected write error propagates unchanged.

The user independently reported all three native checks passed. The retrieved
report records that same source, `status: pass`, and all three named assertions.
The retained temporary harness SHA-256 is
`DFA508AE69B35C69F49297385EE7BE5BC65E41327BFF78AE8D154C36BC858333`.
The report and harness were archived locally, then the QA app was stopped,
the temporary route/script removed, and the owned development server stopped.
No personal ledger or protected key was opened or cleared.

Provider refusal to delete retains explicit cleanup-failure handling in source
and automated tests; it was not reproduced against a refusing native provider.
Failed earlier saves may have left picker-created fictional files in Downloads.
iOS export, other document providers and full export performance remain open.
These observations close the Android picker checks, not all of #15 or release gates.
