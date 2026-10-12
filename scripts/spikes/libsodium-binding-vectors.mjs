// Fixed salts/nonces are fictional test fixtures, never production encryption.
const password = 'fictional recovery binding check';
const plaintext = 'Fictional INR 12.34 \u20b9 \ud83d\udd12';
const aad = 'finance-bro/crypto-qa';
const expectedKey = '6203f0f952a07c6b5183f7cfc45698e38b39e8d64785452363d7867112ce30c9';
const expectedCiphertext = 'a499a7238493902dc2cc093ac46957ef0d39d8d70ced2a00649cdc132dffe442a9c0d93042e32383623248f5';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function rejects(action, message) {
  let rejected = false;
  try { action(); } catch { rejected = true; }
  assert(rejected, message);
}

export async function runLibsodiumBindingVectors(sodium) {
  await sodium.ready;
  assert(sodium.crypto_pwhash_ALG_ARGON2ID13 === 2, 'Argon2id algorithm unavailable');
  const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
  const nonce = Uint8Array.from({ length: 24 }, (_, i) => i + 16);
  const started = performance.now();
  const timer = new Promise((resolve) => setTimeout(() => resolve(performance.now() - started), 0));
  const key = sodium.crypto_pwhash(32, password, salt, 2, 67108864, 2);
  const kdfMs = performance.now() - started;
  const eventLoopDelayMs = await timer;
  assert(sodium.to_hex(key) === expectedKey, 'Argon2id differs from independent Node WASM fixture');
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
  assert(sodium.to_hex(ciphertext) === expectedCiphertext, 'XChaCha ciphertext differs from Node WASM fixture');
  const decrypt = (bytes, context = aad, decryptKey = key) =>
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes, context, nonce, decryptKey);
  assert(sodium.to_string(decrypt(ciphertext)) === plaintext, 'UTF-8 round trip failed');
  const tampered = new Uint8Array(ciphertext);
  tampered[0] ^= 1;
  rejects(() => decrypt(tampered), 'Tampered ciphertext accepted');
  rejects(() => decrypt(ciphertext.subarray(0, ciphertext.length - 1)), 'Truncated ciphertext accepted');
  rejects(() => decrypt(ciphertext, 'different-fictional-context'), 'Changed AAD accepted');
  const wrongKey = sodium.crypto_pwhash(32, 'wrong fictional password', salt, 2, 67108864, 2);
  rejects(() => decrypt(ciphertext, aad, wrongKey), 'Wrong password accepted');
  const random = sodium.randombytes_buf(32);
  assert(random instanceof Uint8Array && random.length === 32, 'Native random bytes unavailable');
  key.fill(0);
  wrongKey.fill(0);
  return {
    status: 'pass', reference: 'libsodium-wrappers-sumo@0.8.4 Node WASM',
    checks: ['argon2id-vector', 'xchacha-vector', 'utf8-round-trip', 'tamper', 'truncation', 'aad', 'wrong-password', 'random-bytes'],
    kdf: { algorithm: 2, opsLimit: 2, memLimit: 67108864, kdfMs, eventLoopDelayMs },
  };
}
