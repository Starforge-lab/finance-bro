const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const appDirectory = path.resolve(__dirname, '../..');
const receiverSource = readFileSync(path.join(__dirname, 'android/src/main/java/expo/modules/smsreader/SmsWakeReceiver.kt'), 'utf8');
const moduleSource = readFileSync(path.join(__dirname, 'android/src/main/java/expo/modules/smsreader/SmsReaderModule.kt'), 'utf8');

function getAndroidManifest(probeEnabled, variant = 'development') {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'expo', 'config', '--type', 'introspect', '--json'],
    {
      cwd: appDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_VARIANT: variant,
        ANDROID_SMS_PROBE: probeEnabled ? '1' : '',
      },
      shell: process.platform === 'win32',
    }
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const config = JSON.parse(result.stdout);
  const manifest = config._internal.modResults?.android?.manifest?.manifest;
  assert.ok(manifest, 'Expo config introspection must produce an Android manifest');
  return { config, manifest };
}

function permissionNames(manifest) {
  return (manifest['uses-permission'] ?? []).filter((permission) => permission.$['tools:node'] !== 'remove')
    .map((permission) => permission.$['android:name']);
}

const { config: normalConfig, manifest: normalManifest } = getAndroidManifest(false);
assert.equal(normalConfig.extra.androidBackgroundProbe, false);
assert.ok(!permissionNames(normalManifest).some((name) => name === 'android.permission.READ_SMS' || name === 'android.permission.RECEIVE_SMS'));
assert.ok(!(normalManifest.application?.[0]?.receiver ?? []).some((receiver) => receiver.$['android:name'] === 'expo.modules.smsreader.SmsWakeReceiver'));

const { config: probeConfig, manifest: probeManifest } = getAndroidManifest(true);
const permissions = permissionNames(probeManifest);
assert.equal(permissions.filter((name) => name === 'android.permission.READ_SMS').length, 1);
assert.equal(permissions.filter((name) => name === 'android.permission.RECEIVE_SMS').length, 1);
assert.equal(probeConfig.android.package, 'com.rohangupta.financebro.smsqa.dev');
assert.equal(probeConfig.extra.androidBackgroundProbe, true);

const receiver = (probeManifest.application?.[0]?.receiver ?? []).find((item) =>
  item.$['android:name'] === 'expo.modules.smsreader.SmsWakeReceiver'
);
assert.ok(receiver, 'probe build must register the SMS wake receiver');
assert.equal(receiver.$['android:exported'], 'true');
assert.equal(receiver.$['android:permission'], 'android.permission.BROADCAST_SMS');
assert.ok(receiver['intent-filter']?.some((filter) =>
  filter.action?.some((action) => action.$['android:name'] === 'android.provider.Telephony.SMS_RECEIVED')
));

assert.match(receiverSource, /getMessagesFromIntent/);
assert.doesNotMatch(receiverSource, /messageBody|originatingAddress|putString|putStringSet|Log\.|println\(/);
assert.doesNotMatch(moduleSource, /Log\.|println\(/);

const { config: productionConfig, manifest: productionManifest } = getAndroidManifest(true, 'production');
assert.equal(productionConfig.android.package, 'com.rohangupta.financebro');
assert.equal(productionConfig.extra.androidBackgroundProbe, false);
assert.ok(!permissionNames(productionManifest).some((name) => name === 'android.permission.READ_SMS' || name === 'android.permission.RECEIVE_SMS'));
assert.ok(!(productionManifest.application?.[0]?.receiver ?? []).some((item) => item.$['android:name'] === 'expo.modules.smsreader.SmsWakeReceiver'));

const resolution = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'expo-modules-autolinking', 'resolve', '--platform', 'android', '--json'],
  { cwd: appDirectory, encoding: 'utf8', shell: process.platform === 'win32' });
assert.equal(resolution.status, 0, resolution.stderr || resolution.error?.message);
const modules = JSON.parse(resolution.stdout).modules;
assert.ok(modules.some((module) => module.projects?.some((project) =>
  project.modules?.some((entry) => entry.classifier === 'expo.modules.smsreader.SmsReaderModule'))),
  'Android resolver must register the actual Kotlin module');

process.stdout.write('SMS reader manifest, scope, and privacy self-checks passed.\n');
