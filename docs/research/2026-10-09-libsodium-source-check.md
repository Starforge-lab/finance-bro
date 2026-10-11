# Recovery source-build check

This bounded check advances [#42](https://github.com/Starforge-lab/finance-bro/issues/42)
without installing a runtime binding or choosing the archive format.

Run the existing Android development workflow with `libsodium_source_check=true`.
The default manual action and pull-request APK job retain their normal behavior.
The source job downloads the official 1.0.22-stable tarball and signature, verifies
the pinned SHA-256 and the upstream Minisign public key, then invokes
[`build-libsodium-arm64.sh`](../../scripts/spikes/build-libsodium-arm64.sh).
The helper accepts local inputs and performs no downloads during compilation.
It uses NDK 30.0.16248370, API 21 and the full upstream ARM64 build. It does not
install npm packages or consume the binding's prebuilt `build.tgz`.

The self-check requires an ARM64 shared library exporting `crypto_pwhash` and
XChaCha20-Poly1305 encrypt/decrypt, and verifies every ELF LOAD alignment is at
least 16 KB. The workflow retains hashes, ELF/symbol reports, the ISC license
and resulting library for one day.

Sources: [libsodium build and signature documentation](https://doc.libsodium.org/installation),
[Android NDK releases](https://developer.android.com/ndk/downloads),
[GitHub runner inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).
The exact archive digest is a snapshot pin: changes to the upstream stable
tarball deliberately fail until reviewed and repinned.

## Observed execution

[Run 37964056713](https://github.com/Starforge-lab/finance-bro/actions/runs/37964056713)
passed at source commit `8dc9ab2`. The log confirms the exact archive digest,
Minisign archive/comment verification, source compilation, all three required
exports, and three ELF LOAD alignments of 16,384 bytes. The downloaded library
matches SHA-256 `297cd7ecd90f36101f1946da3d035b43e95063a08899186ef9d982e593e5374a`.
The artifact also retains its ISC license and inspection reports.

This proves only the upstream ARM64 source build and binary shape. It does not prove the React Native
binding links against the generated library, SDK58 runtime compatibility,
correct KDF/AEAD results on a phone, nonblocking UI, iOS/web parity, a complete
F-Droid recipe, license-tree compliance or reproducibility. Those remain gates
before encrypted recovery ships; see [the feasibility note](https://github.com/Starforge-lab/finance-bro/pull/64).
