/** Experimental source-facts observation only. No IO, persistence or classification. */
import { createHash } from 'node:crypto';
import { validateOperationIdentity, type OperationIdentity, type ValidationErrorCode } from '../classification';

export const SOURCE_FINGERPRINT_VERSION = 1 as const;
type FactsBase = OperationIdentity & Readonly<{ amount: number; date: Date; comment?: string | null }>;
/** Explicit facts projection, never a raw Mongoose/BSON document. */
export type SourceOperationFacts = FactsBase & (
  | Readonly<{ dataset: 'expenses'; category: string; title: string; recipient: string }>
  | Readonly<{ dataset: 'incomes'; source: string }>
);
export type SourceFingerprint = Readonly<{
  sourceFingerprint: string;
  sourceFingerprintVersion: typeof SOURCE_FINGERPRINT_VERSION;
}>;
export type FingerprintErrorCode = ValidationErrorCode
  | 'unsupported_fingerprint_version' | 'invalid_amount' | 'invalid_date'
  | 'invalid_source_string' | 'invalid_comment' | 'invalid_fingerprint' | 'fingerprint_failed';
export type FingerprintResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: FingerprintErrorCode }> }>;
const failure = (code: FingerprintErrorCode): FingerprintResult<never> => ({ ok: false, error: { code } });
const success = <T>(value: T): FingerprintResult<T> => ({ ok: true, value });

const readRecord = (input: unknown, allowed: readonly string[]): FingerprintResult<Record<string, unknown>> => {
  if (typeof input !== 'object' || input === null) return failure('invalid_object');
  try {
    if (Array.isArray(input)) return failure('invalid_object');
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return failure('invalid_object');
    const record: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return failure('unexpected_field');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return failure('invalid_object');
      record[key] = descriptor.value;
    }
    return success(record);
  } catch {
    return failure('invalid_object');
  }
};

const epochMilliseconds = (input: unknown): FingerprintResult<number> => {
  if (typeof input !== 'object' || input === null) return failure('invalid_date');
  try {
    // No subclasses, overridden methods, own metadata or proxies of Date objects.
    if (Object.getPrototypeOf(input) !== Date.prototype || Reflect.ownKeys(input).length !== 0)
      return failure('invalid_date');
    const milliseconds: number = Date.prototype.getTime.call(input);
    return Number.isSafeInteger(milliseconds) ? success(milliseconds) : failure('invalid_date');
  } catch {
    return failure('invalid_date');
  }
};

type CanonicalValue = string | number | null | readonly CanonicalValue[];
const tuple = (...values: CanonicalValue[]): readonly CanonicalValue[] => {
  // Fresh owned arrays only: inherited toJSON hooks cannot inspect private facts.
  Object.setPrototypeOf(values, null);
  return values;
};
const commonFields = ['owner', 'dataset', 'operationId', 'amount', 'date', 'comment'] as const;
const expenseFields = ['category', 'title', 'recipient'] as const;
const incomeFields = ['source'] as const;

/** Version is explicit; missing/unsupported versions never fall back to v1. */
export const fingerprintSourceOperation = (input: unknown, version: unknown): FingerprintResult<SourceFingerprint> => {
  if (version !== SOURCE_FINGERPRINT_VERSION) return failure('unsupported_fingerprint_version');
  const checked = readRecord(input, [...commonFields, ...expenseFields, ...incomeFields]);
  if (!checked.ok) return checked;
  const record = checked.value;
  const identity = validateOperationIdentity({ owner: record.owner, dataset: record.dataset, operationId: record.operationId });
  if (!identity.ok) return identity;
  const fields = identity.value.dataset === 'expenses' ? expenseFields : incomeFields;
  if (Object.keys(record).some(key => ![...commonFields, ...fields].some(allowed => allowed === key)))
    return failure('unexpected_field');
  if (typeof record.amount !== 'number' || !Number.isFinite(record.amount) || record.amount < 0)
    return failure('invalid_amount');
  const date = epochMilliseconds(record.date);
  if (!date.ok) return date;
  const strings: Record<string, string> = Object.create(null);
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== 'string') return failure('invalid_source_string');
    strings[field] = value;
  }
  let comment: readonly CanonicalValue[] = tuple('absent');
  if (Object.hasOwn(record, 'comment')) {
    if (record.comment === null) comment = tuple('null');
    else if (typeof record.comment === 'string') comment = tuple('string', record.comment);
    else return failure('invalid_comment');
  }
  try {
    const amount = Buffer.alloc(8);
    amount.writeDoubleBE(record.amount);
    const slots = fields.map(field => tuple(field, tuple('string', strings[field])));
    const canonical = tuple('budget-classification-source', SOURCE_FINGERPRINT_VERSION,
      identity.value.owner.toLowerCase(), identity.value.dataset, identity.value.operationId.toLowerCase(),
      tuple('amount', tuple('number64', amount.toString('hex'))),
      tuple('date', tuple('date-ms', String(date.value))), ...slots, tuple('comment', comment));
    const sourceFingerprint = createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
    return success(Object.freeze({ sourceFingerprint, sourceFingerprintVersion: SOURCE_FINGERPRINT_VERSION }));
  } catch {
    return failure('fingerprint_failed');
  }
};

export const validateSourceFingerprint = (input: unknown): FingerprintResult<SourceFingerprint> => {
  const checked = readRecord(input, ['sourceFingerprint', 'sourceFingerprintVersion']);
  if (!checked.ok) return checked;
  const record = checked.value;
  if (record.sourceFingerprintVersion !== SOURCE_FINGERPRINT_VERSION) return failure('unsupported_fingerprint_version');
  if (typeof record.sourceFingerprint !== 'string' || record.sourceFingerprint.length !== 64
    || !/^[a-f0-9]{64}$/.test(record.sourceFingerprint)) return failure('invalid_fingerprint');
  return success(Object.freeze({ sourceFingerprint: record.sourceFingerprint,
    sourceFingerprintVersion: SOURCE_FINGERPRINT_VERSION }));
};

/** Matching digests concern observed facts only, never freshness or edit history. */
export const compareSourceFingerprints = (
  left: unknown, right: unknown,
): FingerprintResult<Readonly<{ matches: boolean }>> => {
  const a = validateSourceFingerprint(left);
  if (!a.ok) return a;
  const b = validateSourceFingerprint(right);
  if (!b.ok) return b;
  return success(Object.freeze({ matches: a.value.sourceFingerprint === b.value.sourceFingerprint }));
};
