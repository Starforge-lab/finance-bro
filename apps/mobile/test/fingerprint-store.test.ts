import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import {
  FingerprintKeyUnavailableError,
  type FingerprintKeyProvider,
} from '../src/imports/fingerprint';

function sourceText(path: string) {
  return ts.transpileModule(readFileSync(resolve(path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const nativeSource = sourceText('src/imports/fingerprint-store.native.ts');
const webSource = sourceText('src/imports/fingerprint-store.web.ts');

function loadNativeStore(options: {
  readError?: Error;
  writeError?: Error;
  readGate?: Promise<void>;
} = {}) {
  let readError = options.readError;
  let writeError = options.writeError;
  let stored: string | null = null;
  let randomCalls = 0;
  let readCalls = 0;
  let writeCalls = 0;
  const crypto = {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    async getRandomBytesAsync(length: number) {
      randomCalls += 1;
      return new Uint8Array(length).fill(randomCalls);
    },
    async digest(_algorithm: string, bytes: Uint8Array) {
      return Uint8Array.from(createHash('sha256').update(bytes).digest());
    },
  };
  const secureStore = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async getItemAsync() {
      readCalls += 1;
      if (options.readGate) await options.readGate;
      if (readError) throw readError;
      return stored;
    },
    async setItemAsync(_key: string, value: string) {
      writeCalls += 1;
      if (writeError) throw writeError;
      stored = value;
    },
  };
  const exports: { getFingerprinter?: FingerprintKeyProvider } = {};
  runInNewContext(nativeSource, {
    exports,
    require(name: string) {
      if (name === 'expo-crypto') return crypto;
      if (name === 'expo-secure-store') return secureStore;
      if (name === './fingerprint') return require('../src/imports/fingerprint');
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  assert.ok(exports.getFingerprinter);
  return {
    getFingerprinter: exports.getFingerprinter,
    counts: () => ({ randomCalls, readCalls, writeCalls }),
    clear: () => { stored = null; },
    setReadError: (error?: Error) => { readError = error; },
    setWriteError: (error?: Error) => { writeError = error; },
    setStored: (value: string | null) => { stored = value; },
  };
}

function loadWebStore(options: { readError?: Error; writeError?: Error } = {}) {
  let readError = options.readError;
  let writeError = options.writeError;
  type FakeKey = { type: string; extractable: boolean; algorithm: { name: string; hash: { name: string } }; usages: string[] };
  let stored: FakeKey | undefined;
  let generateCalls = 0;
  let readCalls = 0;
  let writeCalls = 0;
  let lockCalls = 0;
  const fakeKey = (): FakeKey => ({
    type: 'secret',
    extractable: false,
    algorithm: { name: 'HMAC', hash: { name: 'SHA-256' } },
    usages: ['sign'],
  });
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    close() {},
    transaction(_name: string, _mode: string) {
      let aborted = false;
      const transaction: {
        oncomplete?: () => void;
        onabort?: () => void;
        error?: Error;
        objectStore: () => {
          get: (key: string) => { result?: FakeKey; error?: Error; onsuccess?: () => void; onerror?: () => void };
          put: (value: FakeKey, key: string) => void;
        };
        abort: () => void;
      } = {
        objectStore: () => ({
          get: () => {
            const request: { result?: FakeKey; error?: Error; onsuccess?: () => void; onerror?: () => void } = {};
            queueMicrotask(() => {
              if (readError) {
                request.error = readError;
                request.onerror?.();
                queueMicrotask(() => transaction.onabort?.());
                return;
              }
              readCalls += 1;
              request.result = stored;
              request.onsuccess?.();
              queueMicrotask(() => { if (!aborted) transaction.oncomplete?.(); });
            });
            return request;
          },
          put: (value) => {
            writeCalls += 1;
            if (writeError) throw writeError;
            stored = value;
          },
        }),
        abort() {
          aborted = true;
          queueMicrotask(() => transaction.onabort?.());
        },
      };
      return transaction;
    },
  };
  const indexedDB = {
    open() {
      const request: { result?: typeof database; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void; error?: Error } = {};
      queueMicrotask(() => {
        request.result = database;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  const crypto = {
    subtle: {
      async generateKey() {
        generateCalls += 1;
        return fakeKey();
      },
      async sign(_algorithm: string, _key: FakeKey, _data: ArrayBuffer) {
        return new Uint8Array(32).fill(0x42);
      },
    },
  };
  const navigator = {
    locks: {
      async request<T>(_name: string, task: () => Promise<T>) {
        lockCalls += 1;
        return task();
      },
    },
  };
  const exports: { getFingerprinter?: FingerprintKeyProvider } = {};
  runInNewContext(webSource, {
    exports,
    crypto,
    indexedDB,
    navigator,
    require(name: string) {
      if (name === './fingerprint') return require('../src/imports/fingerprint');
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  assert.ok(exports.getFingerprinter);
  return {
    getFingerprinter: exports.getFingerprinter,
    counts: () => ({ generateCalls, readCalls, writeCalls, lockCalls }),
    clear: () => { stored = undefined; },
    setReadError: (error?: Error) => { readError = error; },
    setWriteError: (error?: Error) => { writeError = error; },
  };
}

it('native key storage fails closed after key loss and never generates for protected history', async () => {
  const store = loadNativeStore();
  await assert.rejects(store.getFingerprinter({ allowCreate: false }), FingerprintKeyUnavailableError);
  assert.deepEqual(store.counts(), { randomCalls: 0, readCalls: 1, writeCalls: 0 });

  const first = await store.getFingerprinter({ allowCreate: true });
  assert.equal(first.keyId.length, 64);
  assert.deepEqual(store.counts(), { randomCalls: 1, readCalls: 2, writeCalls: 1 });
  store.clear();
  await assert.rejects(store.getFingerprinter({ allowCreate: false }), FingerprintKeyUnavailableError);
  assert.deepEqual(store.counts(), { randomCalls: 1, readCalls: 3, writeCalls: 1 });
});

it('native read and write errors reject and a later storage retry can succeed', async () => {
  const readError = new Error('fictional secure-store read failure');
  const store = loadNativeStore({ readError });
  await assert.rejects(store.getFingerprinter({ allowCreate: true }), (error) => error === readError);
  assert.deepEqual(store.counts(), { randomCalls: 0, readCalls: 1, writeCalls: 0 });
  store.setReadError();
  assert.equal((await store.getFingerprinter({ allowCreate: true })).keyId.length, 64);
  assert.deepEqual(store.counts(), { randomCalls: 1, readCalls: 2, writeCalls: 1 });

  const writeError = new Error('fictional secure-store write failure');
  const retry = loadNativeStore({ writeError });
  await assert.rejects(retry.getFingerprinter({ allowCreate: true }), (error) => error === writeError);
  assert.deepEqual(retry.counts(), { randomCalls: 1, readCalls: 1, writeCalls: 1 });
  retry.setWriteError();
  const recovered = await retry.getFingerprinter({ allowCreate: true });
  assert.equal(recovered.keyId.length, 64);
  assert.deepEqual(retry.counts(), { randomCalls: 2, readCalls: 2, writeCalls: 2 });

  const malformed = loadNativeStore();
  malformed.setStored('not-a-valid-key');
  await assert.rejects(malformed.getFingerprinter({ allowCreate: true }), /malformed/);
  assert.deepEqual(malformed.counts(), { randomCalls: 0, readCalls: 1, writeCalls: 0 });
});

it('coalesces concurrent native first use but rechecks the store after completion', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = loadNativeStore({ readGate: gate });
  const first = store.getFingerprinter({ allowCreate: true });
  const second = store.getFingerprinter({ allowCreate: true });
  assert.equal(first, second);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.keyId, right.keyId);
  assert.deepEqual(store.counts(), { randomCalls: 1, readCalls: 1, writeCalls: 1 });
  await store.getFingerprinter({ allowCreate: true });
  assert.deepEqual(store.counts(), { randomCalls: 1, readCalls: 2, writeCalls: 1 });
});

it('browser key storage forbids generateKey for protected history and detects loss after success', async () => {
  const store = loadWebStore();
  await assert.rejects(store.getFingerprinter({ allowCreate: false }), FingerprintKeyUnavailableError);
  assert.deepEqual(store.counts(), { generateCalls: 0, readCalls: 1, writeCalls: 0, lockCalls: 1 });

  const first = await store.getFingerprinter({ allowCreate: true });
  assert.equal(first.keyId.length, 64);
  assert.deepEqual(store.counts(), { generateCalls: 1, readCalls: 3, writeCalls: 1, lockCalls: 2 });
  store.clear();
  await assert.rejects(store.getFingerprinter({ allowCreate: false }), FingerprintKeyUnavailableError);
  assert.deepEqual(store.counts(), { generateCalls: 1, readCalls: 4, writeCalls: 1, lockCalls: 3 });
});

it('browser storage read/write failures reject and retry without an ephemeral key', async () => {
  const readError = new Error('fictional IndexedDB read failure');
  const failedRead = loadWebStore({ readError });
  await assert.rejects(failedRead.getFingerprinter({ allowCreate: true }), (error) => error === readError);
  assert.equal(failedRead.counts().generateCalls, 0);
  failedRead.setReadError();
  assert.equal((await failedRead.getFingerprinter({ allowCreate: true })).keyId.length, 64);

  const writeError = new Error('fictional IndexedDB write failure');
  const failedWrite = loadWebStore({ writeError });
  await assert.rejects(failedWrite.getFingerprinter({ allowCreate: true }), /fictional IndexedDB write failure/);
  assert.equal(failedWrite.counts().generateCalls, 1);
  assert.equal(failedWrite.counts().writeCalls, 1);
  failedWrite.setWriteError();
  assert.equal((await failedWrite.getFingerprinter({ allowCreate: true })).keyId.length, 64);
});
