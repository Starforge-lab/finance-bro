# SDK 58 recovery binding spike

Tracked in [#42](https://github.com/Starforge-lab/finance-bro/issues/42).
This experiment follows the [source compilation check](2026-10-09-libsodium-source-check.md).
It does not implement backups or select an archive format.

## Boundary

The manual Android workflow tests `react-native-libsodium@1.7.0` against the
repository's compatible SDK 58 / React Native 0.88 dependency set from #74.
The normal mobile manifest, lockfile and build-script approvals contain no new
runtime dependency. Only the manual job's disposable checkout installs the
candidate, skips its binary-extraction postinstall, and supplies the freshly
signature/hash-verified libsodium 1.0.22 ARM64 build and headers.

The spike uses a distinct `com.rohangupta.financebro.sodiumqa.dev` application
and `financebrosodiumqa` scheme. Its temporary root screen runs fictional crypto
checks only; it imports no ledger, preferences, fingerprint manager or protected
storage. It can be installed beside the personal and CSV-test apps.

Candidate Android CMake imports its ABI library from `libsodium/build`. This
experiment supplies that location from the verified source build and checks
the APK's packaged library against it. It demonstrates one crypto library's
provenance if successful, not source-only provenance of the entire Expo graph.
[Pinned candidate CMake](https://github.com/serenity-kit/react-native-libsodium/blob/v1.7.0/android/CMakeLists.txt)
and [binary-extraction postinstall](https://github.com/serenity-kit/react-native-libsodium/blob/v1.7.0/package.json).

## Shared fixture

`scripts/spikes/libsodium-binding-vectors.mjs` asserts the same Argon2id-derived
key and XChaCha ciphertext against a separately generated
`libsodium-wrappers-sumo@0.8.4` Node/WASM reference. Fixed fictional salt/nonce
bytes are test inputs, not a production encryption recipe. Password derivation
uses algorithm 2, two operations, and 64 MiB; these are experiment parameters,
not frozen backup policy. AAD is a UTF-8 string and ciphertext is a byte array,
matching the candidate native implementation's narrower supported input types.

Assertions cover the derived key, ciphertext, Unicode round trip, tampered and
truncated ciphertext, changed AAD, wrong password and random-byte availability.
The QA screen writes only `finance-bro-sodium-binding-qa.json` in its own app's
document directory. It records KDF duration and zero-delay timer latency to
expose synchronous blocking; it makes no responsiveness claim from build success.

## Observed and remaining checks

The unchanged app graph passes frozen installation, the 36 mobile/44 parser
checks, dependency compatibility, Expo Doctor 20/20, Android/iOS/web exports
and diff checks. Those checks do not exercise the temporary binding.

The shared vectors passed on Node/WASM on 2026-10-10, with one observed WASM
instantiation. The single desktop sample measured about 241 ms for the KDF and
243 ms for the scheduled timer. These observations do not validate native or
browser behavior and are not a performance distribution.

The first manual binding run stopped before compilation because the upstream
`1.0.22-stable` download changed after the earlier source check. Its pinned
checksum correctly rejected the new bytes. Both manual modes now use the dated
[signed source snapshot](../../scripts/spikes/vendor/README.md) retained in this
repository. The archive hash, Minisign signature and trusted comment were
verified locally; inspection found no compiled native libraries or unsafe
archive paths. This verifies the new source input, not its Android build.

The retry compiled that signed source and passed candidate preparation. APK
assembly then failed because the candidate's own Gradle file explicitly
requested four ABIs despite the app's ARM64 build flag. The experiment supplies
only ARM64. Preparation now verifies the original candidate Gradle hash and
known ABI declaration before narrowing that disposable dependency to ARM64;
provenance retains the original/prepared hashes. A copied-package fixture
passed preparation and an altered Gradle file was rejected. The normal app's
Gradle and dependency graph are unchanged.

The temporary QA app also passed a production web export and visibly completed
all eight shared vectors on a fresh localhost origin in the in-app browser.
Its single desktop browser sample measured 143.7 ms for the KDF and 143.9 ms
for the timer. This confirms that initializer and fixture on that browser;
it does not prove responsive hashing, cross-browser coverage or a distribution.

Native binding compilation/linkage, APK provenance assertion, Android runtime
vectors and blocking measurement remain pending. Additional browser coverage,
iOS linkage/device vectors (Rohan), thread/offloading design,
memory profiling, the full F-Droid dependency/license/reproducibility audit,
atomic restore, key epochs and failure-preserving recovery remain open. Keep #42
open and keep the archive format gated until the relevant requirements pass.
