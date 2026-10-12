# Signed libsodium source snapshot

The manual crypto experiments compile this source archive; it contains no
prebuilt native libraries. The normal app does not consume it.

- Upstream: https://download.libsodium.org/libsodium/releases/libsodium-1.0.22-stable.tar.gz
- Signature: the same URL with `.minisig` appended
- Retrieved: 2026-10-10; upstream publication and signature date: 2026-10-09
- Size: 2,096,278 bytes
- SHA-256: `141fe4ef54a9f5ca7a219d1431adc13f02f63ed8f7d3f0513db697207595f0c1`
- Minisign trusted timestamp: `1791588915`
- License: ISC; copied from the archive as `LICENSE.libsodium`

The upstream `-stable` URL changes in place. Retaining its signed bytes makes
reruns reproducible instead of silently accepting a new download. The builder
checks the exact hash and upstream Minisign signature before extracting it.
Minisign 0.12 verified both the signature and trusted comment locally.

To refresh, retrieve the source and adjacent signature together, verify them
with the public key in `build-libsodium-arm64.sh`, inspect archive paths and
contents, then update the dated filename, builder hash and provenance here.
Do not replace the archive with compiled outputs or skip signature validation.
