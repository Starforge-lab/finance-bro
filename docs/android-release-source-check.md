# Android release source-build check

This is the bounded buildability check for [#27](https://github.com/Starforge-lab/finance-bro/issues/27). It is separate from Android SMS feature evidence in #16/#56 and from F-Droid acceptance, signing and publication. The current candidate includes the reviewed SDK baseline #74 and Android CSV fix #66; it is not a finished 2.0 release.

## Recipe

Dispatch the existing `Android development APK` workflow on an exact reviewed branch with `android_release_source_check=true`. The source-check job is manual only; ordinary development APK behavior remains the default.

```sh
gh workflow run android-development.yml --ref <reviewed-branch> -f android_release_source_check=true
```

The check starts from a clean checkout, uses the pinned pnpm version and frozen lockfile, sets the production app variant, and generates Android with Expo prebuild. A temporary checkout-only autolinking override sets `android.buildFromSource` to `[".*"]`, forcing Expo modules to compile from their installed package sources. It does not change the committed dependency graph or normal build settings.

`ANDROID_RELEASE_SOURCE_CHECK=1` enables a guarded config plugin that removes release signing from the generated Gradle configuration. Development signing and normal production configuration are unchanged. Unexpected native template contents fail the check; no signing key, EAS account, signing secret or publication is involved.

The standard Ubuntu 24.04 runner uses Node 22, Java 17 and Gradle's ARM64 release variant with two workers. Current package pins include Expo 58.0.7 and React Native 0.88.0-rc.4. The generated Gradle wrapper and Android toolchain inputs remain authoritative; inspect the run's recorded versions and resolved release dependencies when reviewing the result.

The job retains build/dependency metadata for one day. It does not upload an APK. Generated Android/iOS projects remain outside Git.

## Evidence and limits

The first exact-head hosted source build is pending. Local exports or a development APK are not substitutes for its result. Record the run URL and source SHA here after it completes; keep #27 open until all acceptance criteria have evidence.

Forcing Expo modules to build from source does not prove that every transitive native library or tool was source-built or freely licensed. The [current F-Droid inclusion policy](https://f-droid.org/en/docs/Inclusion_Policy/) permits some trusted FLOSS binary sources and requires dependency, toolchain and license review. Audit the resolved Gradle graph, npm packages and bundled assets separately; repository or package names alone are insufficient.

`expo-notifications` is absent from this candidate's package and lock files. Its Firebase warning remains relevant if it is introduced later; absence from those files alone is not a complete native dependency audit. No notification provider, recovery feature, store variant or import source is added by this check.

Before claiming F-Droid eligibility, establish source provenance and redistribution licenses, inspect packaged native dependencies and assets, verify the intended installer's restricted SMS permission behavior, and recheck submission/toolchain requirements. A successful build is not F-Droid acceptance or reproducibility evidence. Obtain separate authorization for signing setup, account/store configuration and publication.

Expo documents the source-build override in [Precompiled Expo Modules](https://docs.expo.dev/guides/prebuilt-expo-modules/). Preserve the explicit pnpm `allowBuilds` policy and any reviewed source patches; do not approve all package build scripts to make this check pass.
