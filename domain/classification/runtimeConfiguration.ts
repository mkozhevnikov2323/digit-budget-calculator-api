/** P11 trusted configuration DATA only. No env, IO, key generation or activation. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { readWriteFields } from './writeCommand';

export const ISSUANCE_LIMIT = 2 ** 20;
export const MAX_KEY_ISSUANCE_SECONDS = 30 * 86400;
export const RECOVERY_SECONDS = 86400;
export type RuntimeMode = 'prepare' | 'apply' | 'reconcile';
export type RuntimeKey = Readonly<{ kid: string; materialId: string; state: 'active' | 'verify_only' | 'revoked';
  issueFrom: number; issueUntil: number; verifyUntil: number }>;
export type RuntimeConfiguration = Readonly<{ version: 'classification-runtime-v1'; deploymentId: string;
  revision: number; databaseName: string; issuingKid: string | null; keys: readonly RuntimeKey[] }>;
export type SafeResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: 'invalid_configuration' }>;
const invalid = (): SafeResult<never> => ({ ok: false, code: 'invalid_configuration' });
export const plain = (x: unknown, fields: readonly string[]): Record<string, unknown> | undefined => {
  try { return types.isProxy(x) ? undefined : readWriteFields(x, fields); } catch { return undefined; }
};
export const uint = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0);
export const digest = (x: unknown): x is string => typeof x === 'string' && x.length === 64 && /^[a-f0-9]{64}$/.test(x);
export const kid = (x: unknown): x is string => typeof x === 'string' && x.length >= 1 && x.length <= 32 && /^[a-z0-9]/.test(x) && !/[^a-z0-9_-]/.test(x);
const deployment = (x: unknown): x is string => typeof x === 'string' && x.length >= 1 && x.length <= 128 && /^[A-Za-z0-9]/.test(x) && !/[^A-Za-z0-9._:-]/.test(x);
export const ownedArray = (x: unknown, max: number): readonly unknown[] | undefined => {
  try {
    if (!x || typeof x !== 'object' || types.isProxy(x) || !Array.isArray(x) || Object.getPrototypeOf(x) !== Array.prototype) return;
    const length: unknown = Object.getOwnPropertyDescriptor(x, 'length')?.value;
    if (!uint(length) || length > max || Reflect.ownKeys(x).length !== length + 1) return;
    const values: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const d = Object.getOwnPropertyDescriptor(x, String(i));
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return;
      values.push(d.value);
    }
    return values;
  } catch { return undefined; }
};
export const validateRuntimeConfiguration = (input: unknown): SafeResult<RuntimeConfiguration> => {
  const r = plain(input, ['version', 'deploymentId', 'revision', 'databaseName', 'issuingKid', 'keys']);
  if (!r || Object.keys(r).length !== 6 || r.version !== 'classification-runtime-v1' || !deployment(r.deploymentId)
    || !uint(r.revision) || r.revision === 0 || typeof r.databaseName !== 'string' || r.databaseName.length > 63
    || !/^[A-Za-z0-9]/.test(r.databaseName) || /[^A-Za-z0-9_-]/.test(r.databaseName) || ['admin', 'local', 'config'].includes(r.databaseName.toLowerCase())
    || !(r.issuingKid === null || kid(r.issuingKid))) return invalid();
  const inputKeys = ownedArray(r.keys, 32);
  if (!inputKeys?.length) return invalid();
  const keys: RuntimeKey[] = [], ids = new Set<string>(), materials = new Set<string>();
  let active: string | null = null;
  for (const inputKey of inputKeys) {
    const k = plain(inputKey, ['kid', 'materialId', 'state', 'issueFrom', 'issueUntil', 'verifyUntil']);
    if (!k || Object.keys(k).length !== 6 || !kid(k.kid) || !digest(k.materialId) || ids.has(k.kid) || materials.has(k.materialId)
      || (k.state !== 'active' && k.state !== 'verify_only' && k.state !== 'revoked')
      || !uint(k.issueFrom) || !uint(k.issueUntil) || !uint(k.verifyUntil) || k.issueUntil <= k.issueFrom
      || k.verifyUntil > 253402300799 || k.issueUntil - k.issueFrom > MAX_KEY_ISSUANCE_SECONDS || k.verifyUntil < k.issueUntil
      || k.verifyUntil - k.issueUntil > RECOVERY_SECONDS) return invalid();
    if (k.state === 'active') { if (active !== null) return invalid(); active = k.kid; }
    ids.add(k.kid); materials.add(k.materialId);
    keys.push(Object.freeze({ kid: k.kid, materialId: k.materialId, state: k.state,
      issueFrom: k.issueFrom, issueUntil: k.issueUntil, verifyUntil: k.verifyUntil }));
  }
  if (active !== r.issuingKid) return invalid();
  return { ok: true, value: Object.freeze({ version: 'classification-runtime-v1', deploymentId: r.deploymentId,
    revision: r.revision, databaseName: r.databaseName, issuingKid: r.issuingKid, keys: Object.freeze(keys) }) };
};
/** Private operational binding; never an HTTP DTO or telemetry label. */
export const runtimePolicyDigest = (c: RuntimeConfiguration): string => createHash('sha256').update(JSON.stringify([
  'classification-runtime-policy', 1, c.deploymentId, c.revision, c.databaseName, c.issuingKid,
  c.keys.map(k => [k.kid, k.materialId, k.state, k.issueFrom, k.issueUntil, k.verifyUntil]),
])).digest('hex');

/** Only a durable authority may supply `previous`; process memory is not rollback protection. */
export const validateRuntimeTransition = (previous: unknown, next: unknown, incompatibleRestore = false): boolean => {
  if (typeof incompatibleRestore !== 'boolean') return false;
  const p = validateRuntimeConfiguration(previous), n = validateRuntimeConfiguration(next);
  if (!p.ok || !n.ok || n.value.revision <= p.value.revision || n.value.databaseName !== p.value.databaseName
    || (incompatibleRestore ? n.value.deploymentId === p.value.deploymentId : n.value.deploymentId !== p.value.deploymentId)) return false;
  // Tombstones are retained. Retired keys cannot become issuers, nor get a new
  // identity/window to reset a lifetime budget. Authority must retain this across restore.
  return p.value.keys.every(old => {
    const k = n.value.keys.find(k => k.kid === old.kid);
    return !!k && k.materialId === old.materialId && k.issueFrom === old.issueFrom && k.issueUntil <= old.issueUntil
      && k.verifyUntil <= old.verifyUntil && (old.state !== 'revoked' || k.state === 'revoked')
      && (old.state !== 'verify_only' || k.state !== 'active');
  }) && n.value.keys.every(k => !p.value.keys.some(old => old.materialId === k.materialId && old.kid !== k.kid));
};
