/** Read-only systemd credential-directory adapter. No environment secret, JWT,
 * auto-provisioning, plaintext fallback, subprocess or production bootstrap. */
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { validateRuntimeConfiguration, runtimePolicyDigest, plain, ownedArray } from '../../../domain/classification/runtimeConfiguration';
import { loadRuntimeKeyring } from '../../../domain/classification/runtimeKeyPolicy';
import type { EvidenceRequest, SecretProvider } from '../contracts';
const unavailable = () => Error('Ubuntu credentials unavailable');
const protectedOwner = (uid: number) => uid === 0 || uid === process.geteuid?.();
/** Shared bounded file boundary, no symlinks, hardlinks or group/world access. */
const readCredential = (directory: string, name: string, maximum: number): Buffer => {
  const dir = lstatSync(directory);
  if (realpathSync(directory) !== directory || !dir.isDirectory() || !protectedOwner(dir.uid)
    || ![0o500, 0o700].includes(dir.mode & 0o777)) throw unavailable();
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || !protectedOwner(s.uid) || ![0o400, 0o600].includes(s.mode & 0o777)
      || s.size < 1 || s.size > maximum) throw unavailable();
    const bytes = Buffer.alloc(s.size);
    let position = 0;
    while (position < bytes.length) {
      const n = readSync(fd, bytes, position, bytes.length - position, position);
      if (!n) throw unavailable(); position += n;
    }
    const after = fstatSync(fd);
    if (after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs) { bytes.fill(0); throw unavailable(); }
    return bytes;
  } finally { closeSync(fd); }
};
export const createSystemdCredentialProvider = (input: unknown, directory: unknown): SecretProvider | undefined => {
  const c = validateRuntimeConfiguration(input);
  if (!c.ok || process.platform !== 'linux' || typeof directory !== 'string' || !isAbsolute(directory)) return;
  const config = c.value, policyDigest = runtimePolicyDigest(config);
  const current = (q: EvidenceRequest) => {
    const r = plain(q, ['binding', 'requestId']);
    const b = r && plain(r.binding, ['version', 'deploymentId', 'revision', 'databaseName', 'policyDigest']);
    return !!r && Object.keys(r).length === 2 && typeof r.requestId === 'string' && r.requestId.length === 36 && !!b
      && Object.keys(b).length === 5 && b.version === 'classification-operational-binding-v1' && b.policyDigest === policyDigest
      && b.deploymentId === config.deploymentId && b.revision === config.revision && b.databaseName === config.databaseName;
  };
  const load = (q: EvidenceRequest, signal: AbortSignal) => {
    if (signal.aborted || !current(q)) throw unavailable();
    const keys: { kid: string; key: Buffer }[] = [];
    try {
      const bytes = readCredential(directory, 'classification-aead.json', 4096);
      let raw: unknown; try { raw = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
      const r = plain(raw, ['version', 'purpose', 'kids']);
      if (!r || Object.keys(r).length !== 3 || r.version !== 'classification-credential-manifest-v1' || r.purpose !== 'classification-review-aead-v1') throw unavailable();
      const rows = ownedArray(r.kids, 32), expected = config.keys.filter(k => k.state !== 'revoked');
      if (!rows || rows.length !== expected.length || rows.some(k => typeof k !== 'string') || new Set(rows).size !== rows.length
        || !expected.every(k => rows.includes(k.kid))) throw unavailable();
      // File names derive only from validated configured kids, never manifest paths.
      for (const k of expected) {
        const key = readCredential(directory, `classification-key-${k.kid}`, 32);
        if (key.length !== 32) { key.fill(0); throw unavailable(); }
        keys.push({ kid: k.kid, key });
      }
      const result = { version: 'classification-secrets-v1', purpose: 'classification-review-aead-v1', keys };
      if (!loadRuntimeKeyring(config, result)) throw unavailable();
      if (signal.aborted) throw unavailable(); return result;
    } catch { for (const k of keys) k.key.fill(0); throw unavailable(); }
  };
  return Object.freeze({
    async load(q: EvidenceRequest, signal: AbortSignal) { return load(q, signal); },
    async check(q: EvidenceRequest, signal: AbortSignal) {
      const result = load(q, signal);
      for (const k of result.keys) k.key.fill(0);
      return { version: 'classification-key-health-v1', requestId: q.requestId, policyDigest, available: true };
    },
  });
};
