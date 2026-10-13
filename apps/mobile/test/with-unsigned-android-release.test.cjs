const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { clearReleaseSigning } = require('../plugins/withUnsignedAndroidRelease.cjs');

test('source-check signing override requires an explicit production variant', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app.config.ts'), 'utf8');
  const script = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const load = (env) => {
    const context = { exports: {}, process: { env } };
    vm.runInNewContext(script, context);
    return context.exports.default({ config: {} });
  };
  for (const variant of [undefined, 'development', 'preview']) {
    assert.throws(() => load({ APP_VARIANT: variant, ANDROID_RELEASE_SOURCE_CHECK: '1' }), /requires the production variant/);
  }
  const config = load({ APP_VARIANT: 'production', ANDROID_RELEASE_SOURCE_CHECK: '1', ANDROID_SMS_PROBE: '1' });
  assert.equal(config.android.package, 'com.rohangupta.financebro');
  assert.equal(config.extra.androidSmsProbe, false);
  assert.ok(config.plugins.includes('./plugins/withUnsignedAndroidRelease.cjs'));
  assert.ok(!load({}).plugins.includes('./plugins/withUnsignedAndroidRelease.cjs'));
});
const generatedGradle = [
  'android {', '    buildTypes {', '        debug {',
  '            signingConfig signingConfigs.debug', '        }',
  '        release {', '            signingConfig signingConfigs.debug',
  '            minifyEnabled false', '        }', '    }', '}', '',
].join('\n');

test('clears only release signing and preserves debug plus surrounding Gradle text', () => {
  const updated = clearReleaseSigning(generatedGradle);
  assert.equal(updated, generatedGradle.replace(
    '        release {\n            signingConfig signingConfigs.debug',
    '        release {\n            signingConfig null',
  ));
});

test('rejects Kotlin build files instead of guessing at the generated syntax', () => {
  assert.throws(() => clearReleaseSigning(generatedGradle, 'kotlin'), /requires the Groovy build.gradle format/);
});

test('fails closed when the generated release signing line is missing or ambiguous', () => {
  assert.throws(() => clearReleaseSigning(generatedGradle.replace('            signingConfig signingConfigs.debug\n            minifyEnabled false', '            minifyEnabled false')), /Expected one default signing line/);
  assert.throws(() => clearReleaseSigning(generatedGradle.replace('            minifyEnabled false', '            signingConfig signingConfigs.debug\n            minifyEnabled false')), /Expected one default signing line/);
});

test('release source check stays opt-in and cannot run the ordinary APK job', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/android-development.yml'), 'utf8');
  assert.match(workflow, /android_release_source_check:\s+description:[^\n]+\s+type: boolean\s+default: false/);
  assert.match(workflow, /build:\s+if: \$\{\{ !inputs\.libsodium_source_check && !inputs\.android_release_source_check \}\}/);
  assert.match(workflow, /android-release-source:\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.android_release_source_check \}\}/);
  assert.match(workflow, /name: finance-bro-android-release-source-report\s+path: \$\{\{ runner\.temp \}\}\/finance-bro-android-release-source-report\.txt/);
});
