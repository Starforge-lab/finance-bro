'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_AUDIT_SECTION_BYTES,
  MAX_CATEGORY_PATHS,
  parseFileList,
  renderAuditSection,
  scanDefinedClasses,
  validateMetadata,
} = require('./android-apk-audit.cjs');

const validMetadata = {
  applicationId: 'com.rohangupta.financebro\n',
  debuggable: 'false\n',
  minSdk: '24\n',
  targetSdk: '35\n',
  permissions: 'android.permission.INTERNET\nandroid.permission.POST_NOTIFICATIONS\n',
};

function validFileList() {
  return [
    '/',
    '/lib/',
    '/lib/arm64-v8a/',
    '/lib/arm64-v8a/libsqlite.so',
    '/assets/',
    '/assets/index.android.bundle',
    '/res/',
    '/res/raw/',
    '/res/raw/third-party-notice.txt',
  ].join('\n');
}

test('validates production package, non-debuggable manifest, SDKs and permissions', () => {
  assert.deepEqual(validateMetadata(validMetadata), {
    applicationId: 'com.rohangupta.financebro',
    debuggable: false,
    minSdk: 24,
    targetSdk: 35,
    permissions: ['android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS'],
  });
});

test('rejects wrong package and debug builds', () => {
  assert.throws(
    () => validateMetadata({ ...validMetadata, applicationId: 'com.rohangupta.financebro.dev\n' }),
    /unexpected application ID/,
  );
  assert.throws(() => validateMetadata({ ...validMetadata, debuggable: 'true\n' }), /is debuggable/);
});

test('rejects malformed SDK metadata and inconsistent SDK bounds', () => {
  assert.throws(() => validateMetadata({ ...validMetadata, minSdk: 'not-a-number\n' }), /Malformed minimum SDK/);
  assert.throws(() => validateMetadata({ ...validMetadata, targetSdk: '23\n' }), /below its minimum SDK/);
});

test('preserves max SDK caps emitted by apkanalyzer permissions and rejects unknown suffixes', () => {
  const metadata = validateMetadata({
    ...validMetadata,
    permissions: "android.permission.INTERNET\nandroid.permission.READ_EXTERNAL_STORAGE' maxSdkVersion='32\nandroid.permission.WRITE_EXTERNAL_STORAGE' maxSdkVersion='32\n",
  });
  assert.deepEqual(metadata.permissions, [
    'android.permission.INTERNET',
    'android.permission.READ_EXTERNAL_STORAGE (maxSdkVersion=32)',
    'android.permission.WRITE_EXTERNAL_STORAGE (maxSdkVersion=32)',
  ]);
  for (const cap of [0, 1000, 2_147_483_647]) {
    assert.deepEqual(validateMetadata({
      ...validMetadata, permissions: `android.permission.INTERNET' maxSdkVersion='${cap}\n`,
    }).permissions, [`android.permission.INTERNET (maxSdkVersion=${cap})`]);
  }
  for (const suffix of ["' maxSdkVersion='-1", "' maxSdkVersion='2147483648", "' unknown='32", "' maxSdkVersion='32' extra='1"]) {
    assert.throws(() => validateMetadata({
      ...validMetadata, permissions: `android.permission.READ_EXTERNAL_STORAGE${suffix}\n`,
    }), /Malformed manifest permissions/);
  }
});

test('scans defined class names by exact namespace boundary', () => {
  const packageTree = [
    'P d 2 2 160 com.google.firebaseish',
    'C d 1 1 85 com.google.firebaseish.Helper',
    'C d 0 0 48 com.example.Ledger$-CC',
    'P d 1 1 85 com.example',
    'C d 1 1 85 com.example.Ledger',
  ].join('\n');
  assert.deepEqual(scanDefinedClasses(packageTree), {
    definedClassCount: 3,
    forbiddenPrefixMatchCounts: {
      'com.google.android.gms': 0,
      'com.google.firebase': 0,
      'com.google.mlkit': 0,
      'com.android.billingclient': 0,
      'com.android.vending': 0,
    },
  });
  assert.deepEqual(
    scanDefinedClasses('P d 1 1 85 com.google.firebase\nC d 1 1 85 com.google.firebase.analytics.Client'),
    {
      definedClassCount: 1,
      forbiddenPrefixMatchCounts: {
        'com.google.android.gms': 0,
        'com.google.firebase': 1,
        'com.google.mlkit': 0,
        'com.android.billingclient': 0,
        'com.android.vending': 0,
      },
    },
  );
  assert.throws(() => scanDefinedClasses('C r 0 1 30 com.google.mlkit.Foo'), /Malformed defined-class/);
});

test('reports the class count and zero matches for every checked prefix', () => {
  const report = renderAuditSection({
    fingerprint: { sha256: 'a'.repeat(64), bytes: 10 },
    metadata: validateMetadata(validMetadata),
    inventories: parseFileList(validFileList()),
    classScan: scanDefinedClasses('C d 1 1 85 com.example.Ledger'),
  });
  assert.match(report, /defined_class_count=1/);
  assert.match(report, /defined_class_prefix_matches\.com\.google\.firebase=0/);
  assert.match(report, /defined_class_prefix_matches\.com\.android\.vending=0/);
});

test('requires only ARM64 native libraries and rejects malformed inventory', () => {
  assert.deepEqual(parseFileList(validFileList()).nativeSharedLibraries, ['/lib/arm64-v8a/libsqlite.so']);
  assert.throws(
    () => parseFileList(validFileList().replace('/lib/arm64-v8a/libsqlite.so\n', '')),
    /missing ARM64/,
  );
  assert.throws(
    () => parseFileList(validFileList().replace('/lib/arm64-v8a/', '/lib/x86/').replace('/lib/arm64-v8a/', '/lib/x86/')),
    /missing ARM64/,
  );
  assert.throws(() => parseFileList(`${validFileList()}\n/lib/x86/\n/lib/x86/libother.so`), /non-ARM64/);
  assert.throws(() => parseFileList(`${validFileList()}\n/assets/native-library.so`), /outside the ARM64 ABI path/);
  assert.throws(() => parseFileList('/\nrelative/path\n'), /Malformed APK file inventory/);
});

test('fails closed when a path inventory or rendered report exceeds its cap', () => {
  const tooManyAssets = [validFileList(), ...Array.from({ length: MAX_CATEGORY_PATHS + 1 }, (_, i) => `/assets/image-${i}.png`)].join('\n');
  assert.throws(() => parseFileList(tooManyAssets), /assets inventory exceeded its path limit/);

  const metadata = validateMetadata(validMetadata);
  const inventories = parseFileList(validFileList());
  inventories.assets = Array.from({ length: 60 }, (_, i) => `/assets/${'x'.repeat(1800)}-${i}`);
  assert.ok(MAX_AUDIT_SECTION_BYTES < 100000);
  assert.throws(
    () => renderAuditSection({
      fingerprint: { sha256: 'a'.repeat(64), bytes: 10 },
      metadata,
      inventories,
      classScan: scanDefinedClasses('C d 1 1 85 com.example.Ledger'),
    }),
    /report limit/,
  );
});

test('includes files inside nested license directories', () => {
  const inventory = parseFileList(`${validFileList()}\n/META-INF/licenses/MIT.txt`);
  assert.ok(inventory.licenseNoticeCandidates.includes('/META-INF/licenses/MIT.txt'));
});
