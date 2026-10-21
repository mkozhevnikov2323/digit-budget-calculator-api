/** Internal manual intent and canonical RFC §5 hash. Shape is NOT authentication. */
import { createHash } from 'node:crypto';
import { STABLE_TAXONOMY_VERSION, validateOperationIdentity, validateDecisionRevision,
  type Dataset, type ClassificationState, type ClassificationAssignment } from '../classification';
import { validateStableClassificationDecision } from './stablePolicy';
import { validateSourceFingerprint, type SourceFingerprint } from './sourceFingerprint';

export const COMMAND_FINGERPRINT_VERSION = 1 as const;
export type WriteValidationCode = 'invalid_command' | 'invalid_review' | 'review_mismatch'
  | 'unsupported_fingerprint_version';
export type Checked<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: { code: WriteValidationCode } }>;
export type ManualCommand = Readonly<{
  kind: 'manual_classification'; dataset: Dataset; operationId: string;
  state: ClassificationState; assignment?: ClassificationAssignment;
  expectedRevision: number | null; requestId: string;
}>;
export type VerifiedReview = SourceFingerprint & Readonly<{
  kind: 'verified_manual_review'; owner: string; dataset: Dataset; operationId: string;
}>;
export const failValidation = (code: WriteValidationCode): Checked<never> => ({ ok: false, error: { code } });
const success = <T>(value: T): Checked<T> => ({ ok: true, value });

/** Closed plain data snapshots only. No getters, coercion, inherited fields or hooks. */
export const readWriteFields = (input: unknown, allowed: readonly string[]): Record<string, unknown> | undefined => {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return undefined;
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
      const d = Object.getOwnPropertyDescriptor(input, key);
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return undefined;
      out[key] = d.value;
    }
    return out;
  } catch { return undefined; }
};
export const validateManualCommand = (input: unknown): Checked<ManualCommand> => {
  const r = readWriteFields(input, ['kind', 'dataset', 'operationId', 'state', 'assignment', 'expectedRevision', 'requestId']);
  if (!r || r.kind !== 'manual_classification' || !Object.hasOwn(r, 'expectedRevision')
    || (r.expectedRevision !== null && !validateDecisionRevision(r.expectedRevision).ok)
    || typeof r.requestId !== 'string' || r.requestId.length !== 36
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.requestId))
    return failValidation('invalid_command');
  // This dummy identity supplies no authority. Actual owner is resolved separately.
  const checked = validateStableClassificationDecision({ owner: '000000000000000000000000',
    dataset: r.dataset, operationId: r.operationId, state: r.state,
    ...(Object.hasOwn(r, 'assignment') ? { assignment: r.assignment } : {}),
    taxonomyVersion: STABLE_TAXONOMY_VERSION, decisionOrigin: 'manual', decisionRevision: 1 });
  if (!checked.ok) return failValidation('invalid_command');
  const decision = checked.value;
  return success(Object.freeze({ kind: 'manual_classification', dataset: decision.dataset,
    operationId: decision.operationId.toLowerCase(), state: decision.state,
    ...(decision.state === 'approved' ? { assignment: decision.assignment } : {}),
    expectedRevision: r.expectedRevision as number | null, requestId: r.requestId }));
};

/** Validate only AFTER trusted proof verification. This function proves shape, not review. */
export const validateVerifiedReview = (input: unknown): Checked<VerifiedReview> => {
  const r = readWriteFields(input, ['kind', 'owner', 'dataset', 'operationId', 'sourceFingerprint', 'sourceFingerprintVersion']);
  if (!r || r.kind !== 'verified_manual_review') return failValidation('invalid_review');
  const identity = validateOperationIdentity({ owner: r.owner, dataset: r.dataset, operationId: r.operationId });
  if (!identity.ok) return failValidation('invalid_review');
  const fingerprint = validateSourceFingerprint({ sourceFingerprint: r.sourceFingerprint, sourceFingerprintVersion: r.sourceFingerprintVersion });
  if (!fingerprint.ok) return failValidation(fingerprint.error.code === 'unsupported_fingerprint_version'
    ? 'unsupported_fingerprint_version' : 'invalid_review');
  return success(Object.freeze({ kind: 'verified_manual_review', owner: identity.value.owner.toLowerCase(),
    dataset: identity.value.dataset, operationId: identity.value.operationId.toLowerCase(), ...fingerprint.value }));
};

/** Pure helper: no evidence is authenticated here; never use its output as review proof. */
export const fingerprintClassificationCommand = (
  owner: unknown, commandInput: unknown, reviewInput: unknown, version: unknown,
): Checked<Readonly<{ commandFingerprint: string; commandFingerprintVersion: 1 }>> => {
  if (version !== COMMAND_FINGERPRINT_VERSION) return failValidation('unsupported_fingerprint_version');
  const command = validateManualCommand(commandInput), review = validateVerifiedReview(reviewInput);
  if (!command.ok) return command;
  if (!review.ok) return review;
  const c = command.value, r = review.value;
  const identity = validateOperationIdentity({ owner, dataset: c.dataset, operationId: c.operationId });
  if (!identity.ok || identity.value.owner.toLowerCase() !== r.owner || c.dataset !== r.dataset || c.operationId !== r.operationId)
    return failValidation('review_mismatch');
  try {
    const tuple = (...values: unknown[]): unknown[] => { Object.setPrototypeOf(values, null); return values; };
    const assignment = c.state === 'approved' && c.assignment
      ? tuple('assignment', c.assignment.economicRole, c.assignment.layer) : tuple('absent');
    const canonical = tuple('budget-classification-command', 1, r.owner, c.dataset, c.operationId, c.requestId,
      c.expectedRevision, tuple('source', r.sourceFingerprintVersion, r.sourceFingerprint),
      STABLE_TAXONOMY_VERSION, 'manual', c.state, assignment);
    return success(Object.freeze({ commandFingerprint: createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex'),
      commandFingerprintVersion: COMMAND_FINGERPRINT_VERSION }));
  } catch { return failValidation('invalid_command'); }
};
