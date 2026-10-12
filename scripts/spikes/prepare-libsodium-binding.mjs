import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { access, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [packageArgument, sourceArgument, provenanceArgument] = process.argv.slice(2);
if (!packageArgument || !sourceArgument || !provenanceArgument || process.argv.length !== 5) {
  throw new Error('Usage: node prepare-libsodium-binding.mjs PACKAGE_ROOT SOURCE_BUILD_ROOT PROVENANCE_DIRECTORY');
}

const packageRoot = path.resolve(packageArgument);
const sourceRoot = path.resolve(sourceArgument);
const provenanceRoot = path.resolve(provenanceArgument);
const expectedCandidateHashes = {
  packageJson: '5ca7614266965857818d1ed51a8b03a188a79bc5d46eb2ec4968e20436dc387d',
  cmakeLists: 'ce42617e29160fac6583d6dfd33cfb4b52f086f9ff3e75c53e6bbc76bf12ad04',
  androidGradle: '9f538c09461429c84f760502e217a6083a953e63d642baeb4c0fcca90de73f6b',
  nativeCpp: 'c085e128a3da4bd5cac6eb0b61efb34de065552100f76e999a3f1f339725fbb0',
  bundledBuildTgz: '3fbed06822bee4939f5091cc4d4706ac890039116e288cd15f913c63f9b577b3',
};
const exists = async (file) => access(file).then(() => true, () => false);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digestFile = async (file) => digest(await readFile(file));
const requireText = (text, expression, description) => {
  if (!expression.test(text)) throw new Error(`react-native-libsodium@1.7.0 drift: ${description}`);
};
const requireHash = (actual, expected, description) => {
  if (actual !== expected) throw new Error(`react-native-libsodium@1.7.0 drift: ${description} SHA-256 changed`);
};
const prepareArm64OnlyGradle = (gradle) => {
  const abiFilterLines = gradle.match(/^[ \t]*abiFilters\b.*$/gm) ?? [];
  if (abiFilterLines.length !== 1) {
    throw new Error('Candidate Android Gradle ABI filter changed; expected one known four-ABI declaration');
  }
  const knownDeclaration = abiFilterLines[0].match(/^([ \t]*)abiFilters "x86", "x86_64", "armeabi-v7a", "arm64-v8a"([ \t]*)$/);
  if (!knownDeclaration) {
    throw new Error('Candidate Android Gradle ABI filter changed; refusing an unknown declaration');
  }
  return gradle.replace(abiFilterLines[0], `${knownDeclaration[1]}abiFilters "arm64-v8a"${knownDeclaration[2]}`);
};

const checkGradlePreparationFixtures = () => {
  const source = 'android {\n  defaultConfig {\n    abiFilters "x86", "x86_64", "armeabi-v7a", "arm64-v8a"\n  }\n}\n';
  const expected = 'android {\n  defaultConfig {\n    abiFilters "arm64-v8a"\n  }\n}\n';
  assert.equal(prepareArm64OnlyGradle(source), expected);
  assert.throws(() => prepareArm64OnlyGradle(source.replace('"x86_64"', '"x86_64", "mips"')), /ABI filter changed/);
  assert.throws(() => prepareArm64OnlyGradle(`${source}abiFilters "arm64-v8a"\n`), /ABI filter changed/);
};
checkGradlePreparationFixtures();

const manifestPath = path.join(packageRoot, 'package.json');
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes);
if (manifest.name !== 'react-native-libsodium' || manifest.version !== '1.7.0') {
  throw new Error(`Expected react-native-libsodium@1.7.0; found ${manifest.name}@${manifest.version}`);
}
requireHash(digest(manifestBytes), expectedCandidateHashes.packageJson, 'package.json');
if (manifest.scripts?.postinstall !== 'tar -xzf libsodium/build.tgz --directory ./libsodium') {
  throw new Error('Candidate postinstall changed; refusing to prepare unknown bundled native inputs');
}

const cmakePath = path.join(packageRoot, 'android', 'CMakeLists.txt');
const cmakeBytes = await readFile(cmakePath);
const cmake = cmakeBytes.toString('utf8');
requireHash(digest(cmakeBytes), expectedCandidateHashes.cmakeLists, 'Android CMakeLists.txt');
requireText(cmake, /set\s*\(LIBSODIUM_BUILD_DIR\s+\$\{CMAKE_CURRENT_LIST_DIR\}\/\.\.\/libsodium\/build\)/, 'CMake build root changed');
requireText(cmake, /if\s*\(\$\{ANDROID_ABI\}\s+STREQUAL\s+arm64-v8a\)[\s\S]*?set\s*\(LIBSODIUM_BUILD_DIR\s+\$\{LIBSODIUM_BUILD_DIR\}\/libsodium-android-armv8-a\+crypto\)/, 'ARM64 CMake directory changed');
requireText(cmake, /add_library\s*\(sodium\s+SHARED\s+IMPORTED\)/, 'CMake sodium import is no longer a shared library');
requireText(cmake, /include_directories\s*\(\s*\$\{LIBSODIUM_BUILD_DIR\}\/include\//, 'CMake sodium include path changed');
requireText(cmake, /set_target_properties\s*\(\s*sodium\s+PROPERTIES\s+IMPORTED_LOCATION\s+\$\{LIBSODIUM_BUILD_DIR\}\/lib\/libsodium\.so\s*\)/, 'CMake imported library path changed');
requireText(cmake, /target_link_libraries\s*\(libsodium\s+sodium\s*\)/, 'CMake sodium link target changed');

const builder = await readFile(path.join(packageRoot, 'libsodium', 'build.sh'), 'utf8');
requireText(builder, /source_file='libsodium-1\.0\.21-stable\.tar\.gz'/, 'candidate source builder pin changed');
requireText(builder, /dist-build\/android-armv8-a\.sh/, 'candidate ARM64 builder changed');
const cppPath = path.join(packageRoot, 'cpp', 'react-native-libsodium.cpp');
const gradlePath = path.join(packageRoot, 'android', 'build.gradle');
if (!(await exists(cppPath)) || !(await exists(gradlePath))) throw new Error('Candidate C++ or Android Gradle source is missing');
requireHash(await digestFile(cppPath), expectedCandidateHashes.nativeCpp, 'native C++ binding');
const gradleBytes = await readFile(gradlePath);
const gradleSha256 = digest(gradleBytes);
requireHash(gradleSha256, expectedCandidateHashes.androidGradle, 'Android build.gradle');
const preparedGradle = prepareArm64OnlyGradle(gradleBytes.toString('utf8'));

const sodiumRoot = path.join(packageRoot, 'libsodium');
const bundledArchive = path.join(sodiumRoot, 'build.tgz');
if (!(await exists(bundledArchive))) throw new Error('Expected candidate build.tgz is missing');
const candidateFiles = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await candidateFiles(file));
    else if (entry.isFile()) files.push(file);
    else if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in candidate libsodium input: ${file}`);
  }
  return files;
};
const vendorLibraries = (await candidateFiles(sodiumRoot)).filter((file) => file.endsWith('.so'));
if (vendorLibraries.length) throw new Error(`Refusing vendor .so input before copy: ${vendorLibraries.join(', ')}`);

const buildRoot = path.join(sodiumRoot, 'build');
const destination = path.join(buildRoot, 'libsodium-android-armv8-a+crypto');
if (await exists(buildRoot)) throw new Error('Candidate build directory already exists; bundled archive may have been extracted');
const archiveSha256 = await digestFile(bundledArchive);
requireHash(archiveSha256, expectedCandidateHashes.bundledBuildTgz, 'bundled build.tgz');

const builtDir = path.join(sourceRoot, 'libsodium-stable', 'libsodium-android-armv8-a+crypto');
const sourceLibrary = path.join(builtDir, 'lib', 'libsodium.so');
const sourceInclude = path.join(builtDir, 'include');
const sourceHeader = path.join(sourceInclude, 'sodium.h');
const hashRecord = (await readFile(path.join(sourceRoot, 'library-sha256.txt'), 'utf8')).trim();
const recordedHash = hashRecord.match(/^([a-f0-9]{64})\s+/)?.[1];
const sourceSha256 = await digestFile(sourceLibrary);
if (!recordedHash || recordedHash !== sourceSha256) throw new Error('Source-built libsodium library does not match its builder SHA-256 record');
if (!(await exists(sourceHeader))) throw new Error('Source-built libsodium headers are missing');

await rm(bundledArchive);
if (await exists(bundledArchive)) throw new Error('Could not disable candidate build.tgz');
await mkdir(buildRoot, { recursive: false });
await mkdir(destination, { recursive: false });
await mkdir(path.join(destination, 'lib'));
await copyFile(sourceLibrary, path.join(destination, 'lib', 'libsodium.so'));
await cp(sourceInclude, path.join(destination, 'include'), { recursive: true, errorOnExist: true });
await writeFile(gradlePath, preparedGradle);
const preparedGradleBytes = await readFile(gradlePath);
if (!preparedGradleBytes.toString('utf8').includes('abiFilters "arm64-v8a"')) {
  throw new Error('Candidate Gradle ABI filter was not restricted to ARM64');
}

const installedLibrary = path.join(destination, 'lib', 'libsodium.so');
if ((await digestFile(installedLibrary)) !== sourceSha256) throw new Error('Prepared candidate library differs from source build');
if (!(await exists(path.join(destination, 'include', 'sodium.h')))) throw new Error('Prepared candidate headers are missing');

await mkdir(provenanceRoot, { recursive: true });
const provenance = {
  candidate: {
    name: manifest.name,
    version: manifest.version,
    packageJsonSha256: digest(manifestBytes),
    cmakeListsSha256: digest(cmakeBytes),
    androidGradleOriginalSha256: gradleSha256,
    androidGradlePreparedSha256: digest(preparedGradleBytes),
    androidGradleAbiFilters: ['arm64-v8a'],
    nativeCppSha256: await digestFile(cppPath),
    bundledBuildTgzSha256: archiveSha256,
    bundledBuildTgzDeletedWithoutExtraction: true,
  },
  sourceBuild: {
    librarySha256: sourceSha256,
    builderHashRecord: hashRecord,
    installedLibrarySha256: await digestFile(installedLibrary),
    libraryPath: 'libsodium/build/libsodium-android-armv8-a+crypto/lib/libsodium.so',
    headersPath: 'libsodium/build/libsodium-android-armv8-a+crypto/include',
  },
};
await writeFile(path.join(provenanceRoot, 'binding-preparation.json'), `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
console.log(`Prepared react-native-libsodium@1.7.0 ARM64 inputs from ${sourceSha256}`);
