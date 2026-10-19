import {
  createFingerprinter,
  FingerprintKeyUnavailableError,
  type FingerprintKeyPolicy,
  type FingerprintKeyProvider,
  type FingerprintSigner,
} from './fingerprint';

const databaseName = 'finance-bro-key-store';
const objectStoreName = 'keys';
const storedKeyId = 'transaction-fingerprint-v1';
const lockName = 'finance-bro:transaction-fingerprint-v1';
let databaseLoading: Promise<IDBDatabase> | undefined;

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || typeof indexedDB === 'undefined') {
    throw new Error('Browser fingerprint storage requires WebCrypto and IndexedDB');
  }
  return globalThis.crypto;
}

function openDatabase(): Promise<IDBDatabase> {
  databaseLoading ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(objectStoreName)) {
        request.result.createObjectStore(objectStoreName);
      }
    };
    request.onerror = () => fail(request.error ?? new Error('Could not open browser key storage'));
    request.onblocked = () => fail(new Error('Browser key storage upgrade is blocked'));
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
  }).catch((error: unknown) => {
    databaseLoading = undefined;
    throw error;
  });
  return databaseLoading;
}

function storedHmacKey(value: unknown): CryptoKey {
  if (typeof value !== 'object' || value === null) throw new Error('Stored fingerprint key is malformed');
  const key = value as CryptoKey;
  const algorithm = key.algorithm as HmacKeyAlgorithm;
  if (
    key.type !== 'secret' || key.extractable !== false || key.algorithm?.name !== 'HMAC'
    || algorithm.hash?.name !== 'SHA-256' || !key.usages.includes('sign')
  ) throw new Error('Stored fingerprint key is malformed');
  return key;
}

async function readStoredKey(): Promise<CryptoKey | undefined> {
  const database = await openDatabase();
  return new Promise<CryptoKey | undefined>((resolve, reject) => {
    const transaction = database.transaction(objectStoreName, 'readonly');
    const request = transaction.objectStore(objectStoreName).get(storedKeyId);
    let key: CryptoKey | undefined;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        key = request.result === undefined ? undefined : storedHmacKey(request.result);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    request.onerror = () => { failure = request.error; };
    transaction.oncomplete = () => resolve(key);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Could not read browser fingerprint key'));
  });
}

async function storeIfMissing(candidate: CryptoKey): Promise<CryptoKey> {
  const database = await openDatabase();
  return new Promise<CryptoKey>((resolve, reject) => {
    const transaction = database.transaction(objectStoreName, 'readwrite');
    const store = transaction.objectStore(objectStoreName);
    const request = store.get(storedKeyId);
    let selected: CryptoKey | undefined;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        if (request.result === undefined) {
          selected = candidate;
          store.put(candidate, storedKeyId);
        } else {
          selected = storedHmacKey(request.result);
        }
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    request.onerror = () => { failure = request.error; };
    transaction.oncomplete = () => {
      if (selected) resolve(selected);
      else reject(new Error('Browser fingerprint key was not saved'));
    };
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Could not save browser fingerprint key'));
  });
}

async function createKey(subtle: SubtleCrypto): Promise<CryptoKey> {
  return subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

async function getOrCreateKey(subtle: SubtleCrypto, policy: FingerprintKeyPolicy): Promise<CryptoKey> {
  const locks = (globalThis.navigator as Navigator & {
    locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
  } | undefined)?.locks;
  const getUnderLock = async () => {
    const existing = await readStoredKey();
    if (existing) return existing;
    if (!policy.allowCreate) throw new FingerprintKeyUnavailableError();
    return storeIfMissing(await createKey(subtle));
  };
  if (locks) return locks.request(lockName, getUnderLock);

  const existing = await readStoredKey();
  if (existing) return existing;
  if (!policy.allowCreate) throw new FingerprintKeyUnavailableError();
  return storeIfMissing(await createKey(subtle));
}

async function loadSigner(policy: FingerprintKeyPolicy): Promise<FingerprintSigner> {
  const subtle = webCrypto().subtle;
  const key = await getOrCreateKey(subtle, policy);
  return async (message) => {
    const data = new Uint8Array(message.byteLength);
    data.set(message);
    return new Uint8Array(await subtle.sign('HMAC', key, data.buffer));
  };
}

export const getFingerprinter: FingerprintKeyProvider = createFingerprinter(loadSigner);
