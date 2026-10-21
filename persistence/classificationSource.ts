/** Owner-scoped native-driver projection only; never hydrate/cast financial facts. */
import { Types } from 'mongoose';
import { validateOperationIdentity } from '../domain/classification';
import { fingerprintSourceOperation } from '../domain/classification/sourceFingerprint';

const nativeId = (input: unknown): string | undefined => {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Types.ObjectId.prototype
    || Reflect.ownKeys(input).length !== 1) return undefined;
  const d = Object.getOwnPropertyDescriptor(input, 'buffer');
  const bytes: unknown = d && Object.hasOwn(d, 'value') ? d.value : undefined;
  if (!Buffer.isBuffer(bytes) || Object.getPrototypeOf(bytes) !== Buffer.prototype
    || Reflect.ownKeys(bytes).length !== 12) return undefined;
  let out = '';
  for (let i = 0; i < 12; i++) {
    const byte = Object.getOwnPropertyDescriptor(bytes, String(i));
    if (!byte || !Object.hasOwn(byte, 'value') || !Number.isInteger(byte.value)
      || byte.value < 0 || byte.value > 255) return undefined;
    out += (byte.value as number).toString(16).padStart(2, '0');
  }
  return out;
};

export const sourceFingerprintFromBson = (input: unknown, identityInput: unknown) => {
  const failure = { ok: false as const, error: { code: 'invalid_source' as const } };
  try {
    const checked = validateOperationIdentity(identityInput);
    if (!checked.ok || !input || typeof input !== 'object'
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return failure;
    const identity = checked.value;
    const fields = identity.dataset === 'expenses' ? ['category', 'title', 'recipient'] : ['source'];
    const allowed = ['_id', 'owner', 'amount', 'date', 'comment', ...fields];
    const row: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return failure;
      const d = Object.getOwnPropertyDescriptor(input, key);
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return failure;
      row[key] = d.value;
    }
    const owner = nativeId(row.owner), operationId = nativeId(row._id);
    if (owner !== identity.owner.toLowerCase() || operationId !== identity.operationId.toLowerCase()) return failure;
    const projection = { owner, operationId, dataset: identity.dataset, amount: row.amount, date: row.date,
      ...Object.fromEntries(fields.map(key => [key, row[key]])),
      ...(Object.hasOwn(row, 'comment') ? { comment: row.comment } : {}),
    };
    return fingerprintSourceOperation(projection, 1);
  } catch { return failure; }
};
