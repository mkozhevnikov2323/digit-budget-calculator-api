/** Strict internal persistence boundary. Owner shape is never authorization evidence. */
import { Types, mongo } from 'mongoose';
import { STABLE_TAXONOMY_VERSION } from '../domain/classification';
import { validateStableClassificationDecision, type StableClassificationDecision } from '../domain/classification/stablePolicy';
import { validateSourceFingerprint } from '../domain/classification/sourceFingerprint';

export type PersistenceErrorCode = 'invalid_record' | 'unexpected_field' | 'invalid_identity'
  | 'invalid_decision' | 'unsupported_taxonomy' | 'invalid_fingerprint' | 'invalid_last_mutation' | 'invalid_timestamp';
export type PersistenceResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: PersistenceErrorCode }> }>;
export type LastMutation = Readonly<{ requestId: string; commandFingerprint: string; commandFingerprintVersion: 1 }>;
export type ClassificationRecord = StableClassificationDecision & Readonly<{
  _id: string; sourceFingerprint: string; sourceFingerprintVersion: 1;
  sourceObservedAt: Date; createdAt: Date; updatedAt: Date; lastMutation: LastMutation;
}>;
export type BsonClassification = Omit<ClassificationRecord, '_id' | 'owner' | 'operationId'> & {
  _id: Types.ObjectId; owner: Types.ObjectId; operationId: Types.ObjectId;
};
const fail = (code: PersistenceErrorCode): PersistenceResult<never> => ({ ok: false, error: { code } });
const success = <T>(value: T): PersistenceResult<T> => ({ ok: true, value });
const decisionFields = ['owner', 'dataset', 'operationId', 'taxonomyVersion', 'decisionOrigin', 'decisionRevision', 'state', 'assignment'];
const fields = ['_id', ...decisionFields, 'sourceFingerprint', 'sourceFingerprintVersion', 'sourceObservedAt',
  'lastMutation', 'createdAt', 'updatedAt'];

const record = (input: unknown, allowed: readonly string[]): PersistenceResult<Record<string, unknown>> => {
  if (input === null || typeof input !== 'object') return fail('invalid_record');
  try {
    if (Array.isArray(input)) return fail('invalid_record');
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return fail('invalid_record');
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return fail('unexpected_field');
      const d = Object.getOwnPropertyDescriptor(input, key);
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return fail('invalid_record');
      out[key] = d.value;
    }
    return success(out);
  } catch { return fail('invalid_record'); }
};
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 24 && /^[a-fA-F0-9]{24}$/.test(value);
const dateCopy = (value: unknown): Date | undefined => {
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length)
      return undefined;
    const ms: number = Date.prototype.getTime.call(value);
    return Number.isSafeInteger(ms) ? new Date(ms) : undefined;
  } catch { return undefined; }
};

/** Full string-identity record validation, before any Mongoose construction/casting. */
export const validateClassificationRecord = (input: unknown): PersistenceResult<ClassificationRecord> => {
  const read = record(input, fields);
  if (!read.ok) return read;
  const r = read.value;
  if (!id(r._id) || !id(r.owner) || !id(r.operationId)) return fail('invalid_identity');
  if (r.taxonomyVersion !== STABLE_TAXONOMY_VERSION) return fail('unsupported_taxonomy');
  const projection = Object.fromEntries(decisionFields.filter(key => Object.hasOwn(r, key)).map(key => [key, r[key]]));
  const decision = validateStableClassificationDecision(projection);
  if (!decision.ok) return fail('invalid_decision');
  const fingerprint = validateSourceFingerprint({ sourceFingerprint: r.sourceFingerprint,
    sourceFingerprintVersion: r.sourceFingerprintVersion });
  if (!fingerprint.ok) return fail('invalid_fingerprint');
  const mutation = record(r.lastMutation, ['requestId', 'commandFingerprint', 'commandFingerprintVersion']);
  if (!mutation.ok) return fail('invalid_last_mutation');
  const m = mutation.value;
  if (typeof m.requestId !== 'string' || m.requestId.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(m.requestId))
    return fail('invalid_last_mutation');
  if (!validateSourceFingerprint({ sourceFingerprint: m.commandFingerprint,
    sourceFingerprintVersion: m.commandFingerprintVersion }).ok) return fail('invalid_last_mutation');
  const observed = dateCopy(r.sourceObservedAt), created = dateCopy(r.createdAt), updated = dateCopy(r.updatedAt);
  if (!observed || !created || !updated || created.getTime() > updated.getTime()) return fail('invalid_timestamp');
  return success(Object.freeze({ ...decision.value, _id: r._id,
    ...fingerprint.value, sourceObservedAt: observed, createdAt: created, updatedAt: updated,
    lastMutation: Object.freeze({ requestId: m.requestId, commandFingerprint: m.commandFingerprint as string,
      commandFingerprintVersion: 1 as const }),
  }));
};

/** Only a trusted internal caller supplies server metadata. No HTTP write API. */
export const prepareClassificationDocument = (input: unknown): PersistenceResult<BsonClassification> => {
  const read = record(input, fields.filter(key => key !== '_id'));
  if (!read.ok) return read;
  const checked = validateClassificationRecord({ ...read.value, _id: new Types.ObjectId().toHexString() });
  if (!checked.ok) return checked;
  const r = checked.value;
  return success({ ...r, _id: new Types.ObjectId(r._id), owner: new Types.ObjectId(r.owner), operationId: new Types.ObjectId(r.operationId) });
};

/** Inspect native BSON data fields without calling caller-supplied conversion hooks. */
const bsonId = (input: unknown): string | undefined => {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Types.ObjectId.prototype) return undefined;
    if (Reflect.ownKeys(input).length !== 1) return undefined;
    const d = Object.getOwnPropertyDescriptor(input, 'buffer');
    if (!d || !Object.hasOwn(d, 'value')) return undefined;
    const bytes: unknown = d.value;
    if (!bytes || typeof bytes !== 'object' ||
      ![Buffer.prototype, Uint8Array.prototype].includes(Object.getPrototypeOf(bytes))) return undefined;
    if (Reflect.ownKeys(bytes).length !== 12) return undefined;
    let text = '';
    for (let i = 0; i < 12; i++) {
      const byte = Object.getOwnPropertyDescriptor(bytes, String(i));
      const value: unknown = byte && Object.hasOwn(byte, 'value') ? byte.value : undefined;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) return undefined;
      text += value.toString(16).padStart(2, '0');
    }
    return text;
  } catch { return undefined; }
};
const bsonNumber = (input: unknown): unknown => {
  if (typeof input === 'number') return input;
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== mongo.BSON.Long.prototype) return undefined;
    if (Reflect.ownKeys(input).length !== 3) return undefined;
    const data = ['low', 'high', 'unsigned'].map(key => Object.getOwnPropertyDescriptor(input, key));
    if (data.some(d => !d || !Object.hasOwn(d, 'value'))) return undefined;
    const [low, high, unsigned]: unknown[] = data.map(d => d?.value);
    if (typeof low !== 'number' || (low | 0) !== low || typeof high !== 'number' || (high | 0) !== high || typeof unsigned !== 'boolean')
      return undefined;
    let value = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
    if (!unsigned && high < 0) value -= 1n << 64n;
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(-Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  } catch { return undefined; }
};

/** Accept lean/driver objects, not hydrated documents or arbitrary toObject/toJSON. */
export const classificationFromBson = (input: unknown): PersistenceResult<ClassificationRecord> => {
  const read = record(input, fields);
  if (!read.ok) return read;
  const r = read.value;
  const mutation = record(r.lastMutation, ['requestId', 'commandFingerprint', 'commandFingerprintVersion']);
  if (!mutation.ok) return fail('invalid_last_mutation');
  return validateClassificationRecord({ ...r,
    _id: bsonId(r._id), owner: bsonId(r.owner), operationId: bsonId(r.operationId),
    decisionRevision: bsonNumber(r.decisionRevision), sourceFingerprintVersion: bsonNumber(r.sourceFingerprintVersion),
    lastMutation: { ...mutation.value, commandFingerprintVersion: bsonNumber(mutation.value.commandFingerprintVersion) },
  });
};
