'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { createReadStream } = require('node:fs');

const EXPECTED_APPLICATION_ID = 'com.rohangupta.financebro';
const MAX_TOOL_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_FILE_LIST_ENTRIES = 20000;
const MAX_CATEGORY_PATHS = 500;
const MAX_AUDIT_SECTION_BYTES = 96 * 1024;
const FORBIDDEN_CLASS_PREFIXES = Object.freeze([
  'com.google.android.gms',
  'com.google.firebase',
  'com.google.mlkit',
  'com.android.billingclient',
  'com.android.vending',
]);

function fail(message) {
  throw new Error(message);
}

function oneLine(label, output) {
  if (typeof output !== 'string') fail(`Malformed ${label} output.`);
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || lines[0].trim() !== lines[0]) fail(`Malformed ${label} output.`);
  return lines[0];
}

function parsePermissions(output) {
  if (typeof output !== 'string') fail('Malformed manifest permissions output.');
  const text = output.trim();
  if (!text) return [];
  const permissions = text.split(/\r?\n/);
  if (permissions.some((permission) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(permission))) {
    fail('Malformed manifest permissions output.');
  }
  return [...new Set(permissions)].sort();
}

function validateMetadata(raw) {
  const applicationId = oneLine('application ID', raw.applicationId);
  if (applicationId !== EXPECTED_APPLICATION_ID) fail('Packaged APK has an unexpected application ID.');

  const debuggableText = oneLine('debuggable flag', raw.debuggable);
  if (debuggableText !== 'true' && debuggableText !== 'false') fail('Malformed debuggable flag.');
  if (debuggableText !== 'false') fail('Production APK is debuggable.');

  function parseSdk(label, output) {
    const value = oneLine(label, output);
    if (!/^[1-9][0-9]{0,2}$/.test(value)) fail(`Malformed ${label} output.`);
    return Number(value);
  }

  const minSdk = parseSdk('minimum SDK', raw.minSdk);
  const targetSdk = parseSdk('target SDK', raw.targetSdk);
  if (targetSdk < minSdk) fail('Packaged APK target SDK is below its minimum SDK.');

  return {
    applicationId,
    debuggable: false,
    minSdk,
    targetSdk,
    permissions: parsePermissions(raw.permissions),
  };
}

function parseFileList(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_TOOL_STDOUT_BYTES) {
    fail('APK file inventory output exceeded its limit.');
  }
  const trimmed = output.trim();
  if (!trimmed) fail('APK file inventory is empty.');

  const paths = trimmed.split(/\r?\n/);
  if (paths.length > MAX_FILE_LIST_ENTRIES) fail('APK file inventory exceeded its entry limit.');
  const seen = new Set();
  for (const path of paths) {
    if (
      !path.startsWith('/') ||
      path.length > 2048 ||
      path.includes('//') ||
      /[\x00-\x1f\x7f\\]/.test(path) ||
      path.split('/').some((part) => part === '.' || part === '..') ||
      seen.has(path)
    ) {
      fail('Malformed APK file inventory.');
    }
    seen.add(path);
  }

  const files = paths.filter((path) => path !== '/' && !path.endsWith('/'));
  const nativeLibraries = files.filter((path) => path.toLowerCase().endsWith('.so'));
  const libAbis = new Set();
  for (const path of paths) {
    const match = path.match(/^\/lib\/([^/]+)(?:\/|$)/);
    if (match) libAbis.add(match[1]);
  }
  if (!libAbis.has('arm64-v8a')) fail('Packaged APK is missing ARM64 native libraries.');
  if ([...libAbis].some((abi) => abi !== 'arm64-v8a')) fail('Packaged APK contains a non-ARM64 native ABI.');
  if (!nativeLibraries.some((path) => /^\/lib\/arm64-v8a\/.+\.so$/i.test(path))) {
    fail('Packaged APK is missing ARM64 native libraries.');
  }
  if (nativeLibraries.some((path) => !/^\/lib\/arm64-v8a\/.+\.so$/i.test(path))) {
    fail('Packaged APK contains a shared library outside the ARM64 ABI path.');
  }

  const inventories = {
    nativeSharedLibraries: nativeLibraries,
    assets: files.filter((path) => path.startsWith('/assets/')),
    rawResources: files.filter((path) => path.startsWith('/res/raw/')),
    licenseNoticeCandidates: files.filter((path) => /(?:^|\/)(?:licenses?|licences?|notices?|copying|third[-_. ]?party)(?:$|[._-])/i.test(path)),
  };
  for (const [category, entries] of Object.entries(inventories)) {
    if (entries.length > MAX_CATEGORY_PATHS) fail(`APK ${category} inventory exceeded its path limit.`);
  }
  return inventories;
}

function scanDefinedClasses(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_TOOL_STDOUT_BYTES) {
    fail('Defined-class scan output exceeded its limit.');
  }

  let classCount = 0;
  const matchCounts = Object.fromEntries(FORBIDDEN_CLASS_PREFIXES.map((prefix) => [prefix, 0]));
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^C(?:\s|$)/.test(line)) continue;
    const parsed = line.match(/^C\s+([a-z])\s+\d+\s+\d+\s+\d+\s+(\S+)$/);
    if (!parsed || parsed[1] !== 'd') fail('Malformed defined-class scan output.');
    classCount += 1;
    const className = parsed[2];
    for (const prefix of FORBIDDEN_CLASS_PREFIXES) {
      if (className === prefix || className.startsWith(`${prefix}.`)) matchCounts[prefix] += 1;
    }
  }
  if (classCount === 0) fail('Defined-class scan returned no classes.');
  return { definedClassCount: classCount, forbiddenPrefixMatchCounts: matchCounts };
}

async function fingerprintApk(apkPath) {
  let stat;
  try {
    stat = fs.statSync(apkPath);
  } catch {
    fail('Unsigned release APK is not readable.');
  }
  if (!stat.isFile() || stat.size <= 0) fail('Unsigned release APK is empty or not a file.');

  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(apkPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  }).catch(() => fail('Could not hash unsigned release APK.'));
  return { bytes: stat.size, sha256: hash.digest('hex') };
}

function renderAuditSection({ fingerprint, metadata, inventories, classScan }) {
  if (!classScan || !Number.isSafeInteger(classScan.definedClassCount) || classScan.definedClassCount <= 0) {
    fail('Malformed defined-class scan result.');
  }
  if (FORBIDDEN_CLASS_PREFIXES.some((prefix) => !Number.isSafeInteger(classScan.forbiddenPrefixMatchCounts?.[prefix]) || classScan.forbiddenPrefixMatchCounts[prefix] < 0)) {
    fail('Malformed defined-class prefix results.');
  }

  const lines = [
    'apk_sha256=' + fingerprint.sha256,
    'apk_bytes=' + fingerprint.bytes,
    'application_id=' + metadata.applicationId,
    'debuggable=false',
    'min_sdk=' + metadata.minSdk,
    'target_sdk=' + metadata.targetSdk,
    `declared_manifest_permission_count=${metadata.permissions.length}`,
    ...metadata.permissions.map((permission) => `manifest_permission=${permission}`),
    `defined_class_count=${classScan.definedClassCount}`,
    ...FORBIDDEN_CLASS_PREFIXES.map((prefix) => `defined_class_prefix_matches.${prefix}=${classScan.forbiddenPrefixMatchCounts[prefix]}`),
  ];

  const sections = [
    ['native_shared_libraries', inventories.nativeSharedLibraries],
    ['asset_files', inventories.assets],
    ['res_raw_files', inventories.rawResources],
    ['license_notice_candidate_paths', inventories.licenseNoticeCandidates],
  ];
  for (const [name, paths] of sections) {
    lines.push(`${name}_count=${paths.length}`, `${name}_paths:`);
    lines.push(...(paths.length ? paths.map((path) => `  ${path}`) : ['  [none]']));
  }

  const output = lines.join('\n') + '\n';
  if (Buffer.byteLength(output, 'utf8') > MAX_AUDIT_SECTION_BYTES) {
    fail('Packaged APK audit section exceeded its report limit.');
  }
  return output;
}

function runApkAnalyzer(executable, args, apkPath) {
  try {
    const output = execFileSync(executable, [...args, apkPath], {
      encoding: 'utf8',
      maxBuffer: MAX_TOOL_STDOUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (Buffer.byteLength(output, 'utf8') > MAX_TOOL_STDOUT_BYTES) fail('APK Analyzer output exceeded its limit.');
    return output;
  } catch {
    fail(`apkanalyzer ${args.join(' ')} failed or exceeded its output limit.`);
  }
}

async function auditApk(executable, apkPath) {
  const metadata = validateMetadata({
    applicationId: runApkAnalyzer(executable, ['manifest', 'application-id'], apkPath),
    debuggable: runApkAnalyzer(executable, ['manifest', 'debuggable'], apkPath),
    minSdk: runApkAnalyzer(executable, ['manifest', 'min-sdk'], apkPath),
    targetSdk: runApkAnalyzer(executable, ['manifest', 'target-sdk'], apkPath),
    permissions: runApkAnalyzer(executable, ['manifest', 'permissions'], apkPath),
  });

  const inventories = parseFileList(runApkAnalyzer(executable, ['files', 'list'], apkPath));
  const classScan = scanDefinedClasses(
    runApkAnalyzer(executable, ['dex', 'packages', '--defined-only'], apkPath),
  );
  const forbiddenMatches = FORBIDDEN_CLASS_PREFIXES.filter((prefix) => classScan.forbiddenPrefixMatchCounts[prefix] > 0);
  if (forbiddenMatches.length) {
    fail(`Forbidden defined classes found under: ${forbiddenMatches.join(', ')}.`);
  }

  const fingerprint = await fingerprintApk(apkPath);
  return renderAuditSection({ fingerprint, metadata, inventories, classScan });
}

async function main() {
  const [executable, apkPath, ...extra] = process.argv.slice(2);
  if (!executable || !apkPath || extra.length) fail('Usage: android-apk-audit.cjs <apkanalyzer> <unsigned-apk>');
  process.stdout.write(await auditApk(executable, apkPath));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Packaged APK audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FORBIDDEN_CLASS_PREFIXES,
  MAX_AUDIT_SECTION_BYTES,
  MAX_CATEGORY_PATHS,
  MAX_FILE_LIST_ENTRIES,
  MAX_TOOL_STDOUT_BYTES,
  parseFileList,
  parsePermissions,
  renderAuditSection,
  scanDefinedClasses,
  validateMetadata,
};
