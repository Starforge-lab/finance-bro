import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  createFingerprinter,
  createHmacSha256,
  decodeKeyHex,
  encodeKeyHex,
  FingerprintKeyUnavailableError,
  type FingerprintSigner,
  type FingerprintKeyPolicy,
  type FingerprintKeyProvider,
} from './fingerprint';

const storageKey = 'finance-bro.transaction-fingerprint-key.v1';

async function loadKey(policy: FingerprintKeyPolicy): Promise<Uint8Array> {
  const stored = await SecureStore.getItemAsync(storageKey);
  if (stored !== null) return decodeKeyHex(stored);
  if (!policy.allowCreate) throw new FingerprintKeyUnavailableError();

  const key = await Crypto.getRandomBytesAsync(32);
  if (key.length !== 32) throw new Error('Could not generate a valid fingerprint key');
  await SecureStore.setItemAsync(storageKey, encodeKeyHex(key), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return key;
}

async function loadSigner(policy: FingerprintKeyPolicy): Promise<FingerprintSigner> {
  const key = await loadKey(policy);
  return createHmacSha256(key, async (bytes) => {
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    return new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, input));
  });
}

export const getFingerprinter: FingerprintKeyProvider = createFingerprinter(loadSigner);
