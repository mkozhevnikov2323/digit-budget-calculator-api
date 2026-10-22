import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { ownedArray, plain, uint, type RuntimeConfiguration, type RuntimeMode } from './runtimeConfiguration';
import type { ReviewProofKeyring, ReviewProofKey } from './reviewProof';

/** Key material enters only via an explicit purpose-specific secret provider.
 * No env/JWT fallback, key generation, logging or secret-infrastructure lookup. */
export const loadRuntimeKeyring = (config: RuntimeConfiguration, input: unknown): ReviewProofKeyring | undefined => {
  const r = plain(input, ['version', 'purpose', 'keys']);
  if (!r || Object.keys(r).length !== 3 || r.version !== 'classification-secrets-v1' || r.purpose !== 'classification-review-aead-v1') return;
  const rows = ownedArray(r.keys, 32), expected = config.keys.filter(k => k.state !== 'revoked');
  if (!rows || rows.length !== expected.length) return;
  const material = new Map<string, Buffer>();
  for (const row of rows) {
    const k = plain(row, ['kid', 'key']);
    if (!k || Object.keys(k).length !== 2 || typeof k.kid !== 'string' || material.has(k.kid)
      || !expected.some(e => e.kid === k.kid)) return;
    const inputKey = k.key;
    try {
      if (!inputKey || typeof inputKey !== 'object' || types.isProxy(inputKey) || Object.getPrototypeOf(inputKey) !== Buffer.prototype
        || !Buffer.isBuffer(inputKey) || Reflect.ownKeys(inputKey).length !== 32) return;
      const key = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) {
        const d = Object.getOwnPropertyDescriptor(inputKey, String(i));
        if (!d || !d.enumerable || !Object.hasOwn(d, 'value') || !uint(d.value) || d.value > 255) return;
        key[i] = d.value;
      }
      if (createHash('sha256').update(key).digest('hex') !== expected.find(e => e.kid === k.kid)?.materialId) return;
      material.set(k.kid, key);
    } catch { return; }
  }
  const keys: ReviewProofKey[] = config.keys.map(k => k.state === 'revoked' ? { kid: k.kid, state: 'disabled' }
    : { kid: k.kid, state: k.state, key: material.get(k.kid)! });
  return { activeKid: config.issuingKid, keys };
};
/** Evaluated at issuance and AFTER authenticated decryption for verification.
 * Token timestamps must stay inside the approved issuing interval of that material. */
export const runtimeKeyAllowed = (config: RuntimeConfiguration, kid: string, use: RuntimeMode, issuedAt: number, now: number): boolean => {
  const k = config.keys.find(k => k.kid === kid);
  if (!k || k.state === 'revoked' || !uint(issuedAt) || !uint(now) || issuedAt < k.issueFrom || issuedAt >= k.issueUntil
    || now >= k.verifyUntil) return false;
  return use === 'prepare' ? k.state === 'active' && config.issuingKid === kid && now >= k.issueFrom && now < k.issueUntil
    : use === 'apply' ? now < k.issueUntil + 300 : use === 'reconcile';
};
