# Android release source-build check

This is the bounded buildability check for [#27](https://github.com/Starforge-lab/finance-bro/issues/27). It is separate from Android SMS feature evidence in #16/#56 and from F-Droid acceptance, signing and publication. The current candidate includes the reviewed SDK baseline #74 and Android CSV fix #66; it is not a finished 2.0 release.

## Recipe

Dispatch the existing `Android development APK` workflow on an exact reviewed branch with `android_release_source_check=true`. The source-check job is manual only; ordinary development APK behavior remains the default.

```sh
gh workflow run android-development.yml --ref <reviewed-branch> -f android_release_source_check=true
```

The check starts from a clean checkout, uses the pinned pnpm version and frozen lockfile, sets the production app variant, and generates Android with Expo prebuild. A temporary checkout-only autolinking override sets `android.buildFromSource` to `[".*"]`, forcing Expo modules to compile from their installed package sources. It does not change the committed dependency graph or normal build settings.

`ANDROID_RELEASE_SOURCE_CHECK=1` enables a guarded config plugin that removes release signing from the generated Gradle configuration. Development signing and normal production configuration are unchanged. Unexpected native template contents fail the check; no signing key, EAS account, signing secret or publication is involved.

The standard Ubuntu 24.04 runner uses Node 22, Java 17 and Gradle's ARM64 release variant with two workers. Current package pins include Expo 58.0.8 and React Native 0.88.0-rc.4. The generated Gradle wrapper and Android toolchain inputs remain authoritative; inspect the run's recorded versions and resolved release dependencies when reviewing the result.

The job retains build, dependency and bounded packaged-APK metadata for one day. It does not upload an APK. Generated Android/iOS projects remain outside Git.

## Packaged APK metadata audit

After the unsigned release APK is built, the job runs the Android SDK's `apkanalyzer` against that exact file. The report records the APK SHA-256 and byte size, production application ID, `debuggable` flag, minimum and target SDK values, and the permission names declared in the merged packaged manifest. It requires the expected production ID, `debuggable=false`, valid SDK values, ARM64 native libraries, and no additional native ABI. It does not require SMS permissions on this baseline branch, which does not include the SMS module.

The permissions inventory preserves SDK-limited declarations as `android.permission.READ_EXTERNAL_STORAGE (maxSdkVersion=32)`. Android's analyzer can include aapt's quoted `maxSdkVersion` suffix in its permission-name output; the parser accepts only that known suffix and rejects malformed SDK values or unknown attributes. These declarations are metadata, not proof that a permission is granted or available on a device.

The audit scans `dex packages --defined-only` output for defined classes under `com.google.android.gms`, `com.google.firebase`, `com.google.mlkit`, `com.android.billingclient` and `com.android.vending`; a match fails the job. A passing report records the number of defined classes scanned and a zero match count for each prefix. It emits only a bounded inventory of paths and counts for native `.so` files, assets, `res/raw`, and license/notice candidates. APK Analyzer output, each path inventory, the audit section and the whole report have size limits; exceeding one fails the audit rather than silently trimming APK evidence. The existing dependency section remains separately bounded.

This is a narrow packaged-metadata check. The permission list reflects manifest declarations, not runtime grants or all sensitive API use. The class scan can miss relocated, obfuscated or dynamically loaded code and does not establish absence of other unwanted dependencies. Path names and counts do not inspect file contents, hash individual assets, validate notices, establish source provenance, or provide license clearance. No APK, DEX, JavaScript bundle, XML contents, or full class tree is retained in the report. A later run on an SMS feature branch needs a separate source-specific review of the SMS permissions and receiver declarations; this baseline audit deliberately does not make those permissions universal requirements.

## Evidence and limits

The first hosted source build at `8086cbfff2509f4fff004d3e5e2f8d38fa21338f` failed in [run 38150756109](https://github.com/Starforge-lab/finance-bro/actions/runs/38150756109): Gradle's release JavaScript bundling could not resolve `babel-preset-expo`. The app's Babel config names that preset, so it now declares the SDK-compatible `58.0.12` preset directly as a pinned development dependency rather than relying on a transitive package.

The corrected source build passed at `b3f94cd7ff316a4ea518af217a1ef30d42ae7228` in [run 38151771333](https://github.com/Starforge-lab/finance-bro/actions/runs/38151771333). It generated the expected ARM64 unsigned release APK and uploaded a 107,353-byte report recording Node 22.23.3, pnpm 12.9.1, Java 17.0.20.1 and Gradle 9.4.1. Report SHA-256: `5de54cf5133ab551e46da61348711e93d83352e49651372940e0ce3daf28f162`. The dependency section ends normally below the configured cap; no truncation marker was present.

The resolved `releaseRuntimeClasspath` report contains no `com.google.android.gms`, `com.google.mlkit`, Firebase, Play Billing or licensing coordinates searched during the preliminary audit. Expo development-launcher 58.0.12 declares Google code-scanner and ML Kit dependencies as `debugOnly`; the release report supports their exclusion from this resolved configuration. The packaged audit adds a defined-class prefix scan, but neither check is a complete dependency or license audit. Keep #27 open until all acceptance criteria have evidence.

Forcing Expo modules to build from source does not prove that every transitive native library or tool was source-built or freely licensed. The [current F-Droid inclusion policy](https://f-droid.org/en/docs/Inclusion_Policy/) permits some trusted FLOSS binary sources and requires dependency, toolchain and license review. Audit the resolved Gradle graph, npm packages and bundled assets separately; repository or package names alone are insufficient.

`expo-notifications` is absent from this candidate's package and lock files. Its Firebase warning remains relevant if it is introduced later; absence from those files alone is not a complete native dependency audit. No notification provider, recovery feature, store variant or import source is added by this check.

Before claiming F-Droid eligibility, establish source provenance and redistribution licenses, review packaged native dependencies and asset contents, verify the intended installer's restricted SMS permission behavior, and recheck submission/toolchain requirements. The bounded APK path inventory is not a content or license review. A successful build is not F-Droid acceptance or reproducibility evidence. Obtain separate authorization for signing setup, account/store configuration and publication.

Expo documents the source-build override in [Precompiled Expo Modules](https://docs.expo.dev/guides/prebuilt-expo-modules/). Preserve the explicit pnpm `allowBuilds` policy and any reviewed source patches; do not approve all package build scripts to make this check pass.
