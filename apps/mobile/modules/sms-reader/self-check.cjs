const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const appDirectory = path.resolve(__dirname, '../..');
const receiverSource = readFileSync(path.join(__dirname, 'android/src/main/java/expo/modules/smsreader/SmsWakeReceiver.kt'), 'utf8');
const moduleSource = readFileSync(path.join(__dirname, 'android/src/main/java/expo/modules/smsreader/SmsReaderModule.kt'), 'utf8');
const settingsSource = readFileSync(path.join(__dirname, 'android/src/main/java/expo/modules/smsreader/SmsImportSettings.kt'), 'utf8');
const workSource = readFileSync(path.join(__dirname, 'android/src/main/java/expo/modules/smsreader/SmsCatchupWakeWork.kt'), 'utf8');
const metadataSource = readFileSync(path.join(__dirname, 'android/src/main/java/expo/modules/smsreader/SmsWakeMetadata.kt'), 'utf8');
const gradleSource = readFileSync(path.join(__dirname, 'android/build.gradle'), 'utf8');
const typesSource = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');

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

function assertSmsReaderEnabled(manifest) {
  const permissions = permissionNames(manifest);
  assert.equal(permissions.filter((name) => name === 'android.permission.READ_SMS').length, 1);
  assert.equal(permissions.filter((name) => name === 'android.permission.RECEIVE_SMS').length, 1);

  const receiver = (manifest.application?.[0]?.receiver ?? []).find((item) =>
    item.$['android:name'] === 'expo.modules.smsreader.SmsWakeReceiver'
  );
  assert.ok(receiver, 'Android builds must register the consent-gated SMS reader receiver');
  assert.equal(receiver.$['android:exported'], 'true');
  assert.equal(receiver.$['android:permission'], 'android.permission.BROADCAST_SMS');
  assert.ok(receiver['intent-filter']?.some((filter) =>
    filter.action?.some((action) => action.$['android:name'] === 'android.provider.Telephony.SMS_RECEIVED')
  ));
}

const { config: normalConfig, manifest: normalManifest } = getAndroidManifest(false);
assert.equal(normalConfig.extra.androidBackgroundProbe, false);
assert.equal(normalConfig.extra.androidSmsProbe, false);
assert.equal(normalConfig.android.package, 'com.rohangupta.financebro.dev');
assertSmsReaderEnabled(normalManifest);

const { config: probeConfig, manifest: probeManifest } = getAndroidManifest(true);
assert.equal(probeConfig.android.package, 'com.rohangupta.financebro.smsqa.dev');
assert.equal(probeConfig.extra.androidBackgroundProbe, true);
assert.equal(probeConfig.extra.androidSmsProbe, true);
assertSmsReaderEnabled(probeManifest);

assert.match(receiverSource, /intent\.action != Telephony\.Sms\.Intents\.SMS_RECEIVED_ACTION\) return/);
assert.doesNotMatch(receiverSource, /getMessagesFromIntent|pdus|messageBody|originatingAddress|intent\.extras/,
  'the receiver must only gate and enqueue work; it must not inspect SMS payloads');
assert.match(receiverSource, /SmsCatchupWakeWork\.enqueue\(context\.applicationContext, intent\.action, goAsync\(\)\)/);
assert.match(workSource, /recordSmsWakeReceived\(context\.smsWakePreferences\(\)\)/);
assert.match(workSource, /scheduleSmsCatchupIfEnabled\([\s\S]*readImportSettings\(context\.smsImportSettingsPreferences\(\)\)\.enabled/);
assert.match(workSource, /CoroutineScope\(SupervisorJob\(\) \+ Dispatchers\.IO\)/);
assert.match(workSource, /ExistingWorkPolicy\.APPEND_OR_REPLACE/);
assert.match(workSource, /OneTimeWorkRequestBuilder<SmsCatchupWakeWorker>/);
assert.match(workSource, /getWorkInfosForUniqueWork\(SMS_WAKE_WORK_NAME\)/);
assert.match(workSource, /schedulingLock\.tryLock\(SCHEDULING_LOCK_TIMEOUT_MS, TimeUnit\.MILLISECONDS\)/);
assert.match(workSource, /SmsWakeEnqueueDecision\.COALESCE/);
assert.match(workSource, /SmsWakeEnqueueDecision\.APPEND_TRAILING/);
assert.match(workSource, /class SmsCatchupWakeTaskConsumer @DoNotStrip constructor\(context: Context, taskManagerUtils: TaskManagerUtilsInterface\)/);
assert.match(workSource, /@DoNotStrip\s+class SmsCatchupWakeTaskConsumer @DoNotStrip constructor/);
assert.match(workSource, /@field:DoNotStrip\s+@JvmField\s+val VERSION = 0/);
assert.doesNotMatch(workSource, /setInputData|inputData|NetworkType|requiresCharging|requiresBatteryNotLow/,
  'the receiver job must have no SMS payload or periodic worker constraints');
assert.match(workSource, /TaskServiceProviderHelper\.getTaskServiceImpl\(context\)/);
assert.match(workSource, /getTaskConsumers\(context\.packageName\)/);
assert.match(workSource, /registeredTask\.execute\(data, null, callback\)/);
assert.match(workSource, /putLong\(WAKE_DEADLINE_KEY, deadlineElapsedRealtimeMs\)/);
assert.match(workSource, /withTimeoutOrNull\(TASK_TIMEOUT_MS\)/);
assert.match(workSource, /callbackResumed\.compareAndSet\(false, true\)/);
assert.match(workSource, /continuation\.resume\(isSuccessfulSmsCatchupResponse\(response\)\)/);
assert.doesNotMatch(workSource, /tryResume|completeResume|ExperimentalCoroutinesApi/);
assert.match(workSource, /\.result\.get\(WORK_QUERY_TIMEOUT_MS, TimeUnit\.MILLISECONDS\)/);
assert.match(workSource, /result\?\.toDouble\(\) == JS_TASK_SUCCESS/);
assert.match(workSource, /recordSmsWakeOutcome\(context\.smsWakePreferences\(\), SmsWakeOutcome\.DEFERRED, failedAttempt = false\)/);
assert.match(workSource, /decideSmsWakeOutcomeWrite\(/);
assert.match(workSource, /if \(!isEligible\(context\)\) return finish\(SmsWakeOutcome\.DEFERRED, failedAttempt = false\)/);
assert.doesNotMatch(workSource, /Class\.forName|BackgroundTaskScheduler|HeadlessJsTaskService/);
assert.match(moduleSource, /AsyncFunction\("getImportSettingsAsync"\)/);
assert.match(moduleSource, /AsyncFunction\("getElapsedRealtimeAsync"\)/);
assert.match(moduleSource, /AsyncFunction\("setImportSettingsAsync"\)/);
assert.match(moduleSource, /registerTask\(SMS_WAKE_TASK_NAME, SmsCatchupWakeTaskConsumer::class\.java/);
assert.ok(moduleSource.indexOf('SmsCatchupWakeWork.cancel') < moduleSource.indexOf('taskManager.unregisterTask'),
  'native unregister must cancel queued work before unregistering the consumer');
assert.match(typesSource, /previewEndDateMs\?: number/);
assert.match(typesSource, /registerWakeTaskAsync\(\): Promise<void>/);
assert.match(typesSource, /lastMultipartCount: number/);
assert.match(typesSource, /lastOutcome\?: 'success' \| 'failed' \| 'deferred' \| null/);
assert.match(metadataSource, /"lastMultipartCount" to 0/);
assert.match(metadataSource, /"lastAttemptAtMs"/);
assert.match(metadataSource, /"lastOutcome"/);
assert.match(metadataSource, /"failedAttemptCount"/);
assert.match(gradleSource, /androidx\.work:work-runtime-ktx:2\.9\.1/);
assert.match(settingsSource, /previewEndDateMs is required for the initial SMS import/);
assert.match(settingsSource, /previewEndDateMs - requestedStartDateMs <= MAX_RANGE_MS/);
assert.match(settingsSource, /private fun commitFailClosed[\s\S]*editor\.commit\(\)/);
assert.doesNotMatch(settingsSource, /\.apply\(\)/);
assert.doesNotMatch(receiverSource, /messageBody|originatingAddress|putString|putStringSet|Log\.|println\(/);
assert.doesNotMatch(moduleSource, /Log\.|println\(/);
assert.doesNotMatch(workSource, /Log\.|println\(|stackTraceToString|putString\("error"/);

const { config: productionConfig, manifest: productionManifest } = getAndroidManifest(true, 'production');
assert.equal(productionConfig.android.package, 'com.rohangupta.financebro');
assert.equal(productionConfig.extra.androidBackgroundProbe, false);
assert.equal(productionConfig.extra.androidSmsProbe, false);
assertSmsReaderEnabled(productionManifest);

const resolution = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'expo-modules-autolinking', 'resolve', '--platform', 'android', '--json'],
  { cwd: appDirectory, encoding: 'utf8', shell: process.platform === 'win32' });
assert.equal(resolution.status, 0, resolution.stderr || resolution.error?.message);
const modules = JSON.parse(resolution.stdout).modules;
assert.ok(modules.some((module) => module.projects?.some((project) =>
  project.modules?.some((entry) => entry.classifier === 'expo.modules.smsreader.SmsReaderModule'))),
  'Android resolver must register the actual Kotlin module');

process.stdout.write('SMS reader manifest, wake bridge, scope, and privacy self-checks passed.\n');
