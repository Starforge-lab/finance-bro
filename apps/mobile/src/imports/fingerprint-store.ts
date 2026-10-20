import type { FingerprintKeyPolicy, FingerprintKeyProvider } from './fingerprint';

export const getFingerprinter: FingerprintKeyProvider = async (_policy?: FingerprintKeyPolicy) => {
  throw new Error('Fingerprinting is unavailable on this platform');
};
