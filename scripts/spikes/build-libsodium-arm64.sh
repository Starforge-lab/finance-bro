#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 ]]; then
  echo 'Usage: build-libsodium-arm64.sh SOURCE_TARBALL NEW_OUTPUT_DIRECTORY' >&2
  exit 2
fi
archive=$(realpath "$1")
output=$(realpath -m "$2")
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to NDK 30.0.16248370}"
grep -Eq '^Pkg.Revision *= *30\.0\.16248370$' "$ANDROID_NDK_HOME/source.properties"
[[ ! -e "$output" ]] || { echo 'Output directory must be new' >&2; exit 2; }
echo "141fe4ef54a9f5ca7a219d1431adc13f02f63ed8f7d3f0513db697207595f0c1  $archive" | sha256sum --check
minisign -Vm "$archive" -P RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3

mkdir -p "$output"
tar -xzf "$archive" -C "$output"
cd "$output/libsodium-stable"
# Full build keeps the password hashing APIs required for encrypted recovery.
LIBSODIUM_FULL_BUILD=1 NDK_PLATFORM=android-21 bash dist-build/android-armv8-a.sh

library="$PWD/libsodium-android-armv8-a+crypto/lib/libsodium.so"
toolchain="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
test -s "$library"
"$toolchain/llvm-readelf" -h "$library" > "$output/elf-header.txt"
grep -Eq 'Machine: +AArch64' "$output/elf-header.txt"
"$toolchain/llvm-readelf" -lW "$library" > "$output/elf-segments.txt"
"$toolchain/llvm-nm" -D --defined-only "$library" > "$output/exported-symbols.txt"
for symbol in crypto_pwhash crypto_aead_xchacha20poly1305_ietf_encrypt crypto_aead_xchacha20poly1305_ietf_decrypt; do
  awk '{print $NF}' "$output/exported-symbols.txt" | grep -Fx "$symbol"
done
python3 - "$output/elf-segments.txt" <<'PY'
import pathlib
import sys
alignments = [int(line.split()[-1], 16) for line in pathlib.Path(sys.argv[1]).read_text().splitlines() if line.strip().startswith('LOAD ')]
assert alignments and all(value >= 0x4000 for value in alignments), alignments
print('Every ELF LOAD alignment is at least 16 KB:', alignments)
PY
cp LICENSE "$output/LICENSE.libsodium"
sha256sum "$library" > "$output/library-sha256.txt"
printf 'Source signature, pinned hash, ARM64 exports and ELF alignment checks passed.\n'
