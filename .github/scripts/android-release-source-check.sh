#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"

if [[ "${APP_VARIANT:-}" != "production" || "${ANDROID_SMS_PROBE:-}" != "0" || "${ANDROID_RELEASE_SOURCE_CHECK:-}" != "1" ]]; then
  echo "Release source check requires production config, SMS probe disabled, and the explicit check flag." >&2
  exit 1
fi

mobile_package="$repo_root/apps/mobile/package.json"
package_backup="$(mktemp)"
report="${RUNNER_TEMP:?RUNNER_TEMP must be set}/finance-bro-android-release-source-report.txt"
dependency_report="$(mktemp)"

cp "$mobile_package" "$package_backup"
restore_package() {
  cp "$package_backup" "$mobile_package"
  rm -f "$package_backup" "$dependency_report"
}
trap restore_package EXIT
trap 'exit 1' HUP INT TERM

node - "$mobile_package" "$package_backup" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [packagePath, backupPath] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const expected = JSON.parse(JSON.stringify(before));
expected.expo ??= {};
expected.expo.autolinking ??= {};
expected.expo.autolinking.android ??= {};
expected.expo.autolinking.android.buildFromSource = ['.*'];
fs.writeFileSync(packagePath, JSON.stringify(expected, null, 2) + '\n');
assert.deepEqual(JSON.parse(fs.readFileSync(packagePath, 'utf8')), expected);
NODE

(
  cd "$repo_root/apps/mobile"
  pnpm exec expo prebuild --platform android --no-install
)

(
  cd "$repo_root/apps/mobile/android"
  ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2
)

(
  cd "$repo_root/apps/mobile/android"
  ./gradlew :app:dependencies --configuration releaseRuntimeClasspath --console=plain
) > "$dependency_report"

release_apk="$repo_root/apps/mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk"
if [[ ! -s "$release_apk" ]]; then
  echo "Expected unsigned release APK was not generated at $release_apk." >&2
  exit 1
fi

git_status="$(git -C "$repo_root" status --porcelain -- apps/mobile/android apps/mobile/ios)"
if [[ -n "$git_status" ]]; then
  echo "Generated native projects are not ignored; refusing to leave them in Git status:" >&2
  printf '%s\n' "$git_status" >&2
  exit 1
fi

{
  printf 'schema=1\n'
  printf 'git_sha=%s\n' "${GITHUB_SHA:-local}"
  printf 'git_ref=%s\n' "${GITHUB_REF_NAME:-local}"
  printf 'architecture=arm64-v8a\n'
  printf 'app_variant=%s\n' "$APP_VARIANT"
  printf 'android_sms_probe=%s\n' "$ANDROID_SMS_PROBE"
  printf 'release_apk_generated=unsigned\n'
  printf '\n=== toolchain ===\n'
  printf 'node=%s\n' "$(node --version)"
  printf 'pnpm=%s\n' "$(pnpm --version)"
  java -version 2>&1
  printf '\n=== Gradle ===\n'
  (cd "$repo_root/apps/mobile/android" && ./gradlew --version --console=plain) | sed -n '1,10p'
  printf '\n=== releaseRuntimeClasspath (first 2000 lines / 512 KiB) ===\n'
  awk 'NR <= 2000 && bytes < 524288 { print; bytes += length($0) + 1 } NR == 2001 || bytes >= 524288 { print "[dependency report truncated at configured limit]"; exit }' "$dependency_report"
} > "$report"

if [[ "$(wc -c < "$report")" -gt 550000 ]]; then
  echo "Bounded dependency report exceeded its size limit." >&2
  exit 1
fi
