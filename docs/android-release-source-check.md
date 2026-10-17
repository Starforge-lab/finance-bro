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

The job retains build/dependency metadata for one day. It does not upload an APK. Generated Android/iOS projects remain outside Git.

## Evidence and limits

The first hosted source build at `8086cbfff2509f4fff004d3e5e2f8d38fa21338f` failed in [run 38150756109](https://github.com/Starforge-lab/finance-bro/actions/runs/38150756109): Gradle's release JavaScript bundling could not resolve `babel-preset-expo`. The app's Babel config names that preset, so it now declares the SDK-compatible `58.0.12` preset directly as a pinned development dependency rather than relying on a transitive package.

The corrected source build passed at `b3f94cd7ff316a4ea518af217a1ef30d42ae7228` in [run 38151771333](https://github.com/Starforge-lab/finance-bro/actions/runs/38151771333). It generated the expected ARM64 unsigned release APK and uploaded a 107,353-byte report recording Node 22.23.3, pnpm 12.9.1, Java 17.0.20.1 and Gradle 9.4.1. Report SHA-256: `5de54cf5133ab551e46da61348711e93d83352e49651372940e0ce3daf28f162`. The dependency section ends normally below the configured cap; no truncation marker was present.

The resolved `releaseRuntimeClasspath` report contains no `com.google.android.gms`, `com.google.mlkit`, Firebase, Play Billing or licensing coordinates searched during the preliminary audit. Expo development-launcher 58.0.12 declares Google code-scanner and ML Kit dependencies as `debugOnly`; the release report supports their exclusion from this resolved configuration. This is not packaged-APK inspection or a complete transitive license audit. Keep #27 open until all acceptance criteria have evidence.

The frozen SDK/SMS candidate at `066b788eda519e339b77fbae747aa4e2e85e3af4`
also passed the production unsigned ARM64 source-build check in
[run 38945344874](https://github.com/Starforge-lab/finance-bro/actions/runs/38945344874).
Its 113,507-byte report records production variant, probe disabled, unsigned APK
generation, Node 22.23.3, pnpm 12.9.1, Java 17.0.20.1 and Gradle 9.4.1.
Report SHA-256:
`4d85251f5d8d5207583ea1b9cdf38b5b133b1e6063940ef44f8132b0bcae4757`.
The dependency report ends normally without a truncation marker. Searches for
Google Play services, ML Kit, Firebase, Play Billing and vending coordinates
returned no matches. This refreshes clean-build evidence for the frozen SMS
candidate; packaged-artifact inspection, transitive license/provenance review
and intended-installer SMS permission behavior remain unverified. Gradle reports
deprecated features incompatible with Gradle 10; the tested wrapper remains 9.4.1.

Forcing Expo modules to build from source does not prove that every transitive native library or tool was source-built or freely licensed. The [current F-Droid inclusion policy](https://f-droid.org/en/docs/Inclusion_Policy/) permits some trusted FLOSS binary sources and requires dependency, toolchain and license review. Audit the resolved Gradle graph, npm packages and bundled assets separately; repository or package names alone are insufficient.

`expo-notifications` is absent from this candidate's package and lock files. Its Firebase warning remains relevant if it is introduced later; absence from those files alone is not a complete native dependency audit. No notification provider, recovery feature, store variant or import source is added by this check.

Before claiming F-Droid eligibility, establish source provenance and redistribution licenses, inspect packaged native dependencies and assets, verify the intended installer's restricted SMS permission behavior, and recheck submission/toolchain requirements. A successful build is not F-Droid acceptance or reproducibility evidence. Obtain separate authorization for signing setup, account/store configuration and publication.

Expo documents the source-build override in [Precompiled Expo Modules](https://docs.expo.dev/guides/prebuilt-expo-modules/). Preserve the explicit pnpm `allowBuilds` policy and any reviewed source patches; do not approve all package build scripts to make this check pass.
