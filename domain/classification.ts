/** Pure provisional domain contract. No IO, authorization, persistence or inference. */
export const PROVISIONAL_TAXONOMY_VERSION = 'financial-layers-v1-provisional' as const;
export type TaxonomyVersion = typeof PROVISIONAL_TAXONOMY_VERSION;

export const ECONOMIC_ROLES = Object.freeze([
  'ordinary_expense', 'ordinary_income', 'loan_issuance', 'loan_repayment',
  'refund', 'internal_transfer', 'capital_movement',
] as const);
export type EconomicRole = typeof ECONOMIC_ROLES[number];
export const FINANCIAL_LAYERS = Object.freeze([
  'everyday', 'irregular', 'emergency', 'major_goals', 'long_term_capital',
] as const);
export type FinancialLayer = typeof FINANCIAL_LAYERS[number];
export type Dataset = 'expenses' | 'incomes';

declare const objectIdBrand: unique symbol;
/** Structural 24-character ASCII hex representation, NOT ownership evidence. */
export type ObjectIdRepresentation = string & { readonly [objectIdBrand]: true };
export type OwnerIdentity = ObjectIdRepresentation;
export type OperationIdentity = Readonly<{
  owner: OwnerIdentity;
  dataset: Dataset;
  operationId: ObjectIdRepresentation;
}>;

declare const revisionBrand: unique symbol;
/** Positive safe integer supplied by a future trusted server decision boundary. */
export type DecisionRevision = number & { readonly [revisionBrand]: true };
export type ClassificationAssignment =
  | Readonly<{ economicRole: 'ordinary_expense'; layer: FinancialLayer }>
  | Readonly<{ economicRole: Exclude<EconomicRole, 'ordinary_expense'>; layer: null }>;
export type ClassificationState = 'approved' | 'explicit_unclassified' | 'cleared';
/** Conceptual absence of a decision; never a persisted decision state. */
export type UnreviewedState = 'unreviewed';
type DecisionBase = OperationIdentity & Readonly<{
  taxonomyVersion: TaxonomyVersion;
  decisionOrigin: 'manual';
  decisionRevision: DecisionRevision;
}>;
export type ClassificationDecision = DecisionBase & (
  | Readonly<{ state: 'approved'; assignment: ClassificationAssignment }>
  | Readonly<{ state: 'explicit_unclassified' | 'cleared'; assignment?: never }>
);

export type ValidationErrorCode =
  | 'invalid_object' | 'unexpected_field' | 'invalid_owner' | 'invalid_dataset'
  | 'invalid_operation_id' | 'unsupported_taxonomy' | 'invalid_decision_origin'
  | 'invalid_decision_revision' | 'invalid_state' | 'missing_assignment'
  | 'unexpected_assignment' | 'invalid_economic_role' | 'invalid_financial_layer';
export type ValidationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: ValidationErrorCode }> }>;
const failure = (code: ValidationErrorCode): ValidationResult<never> =>
  ({ ok: false, error: { code } });
const success = <T>(value: T): ValidationResult<T> => ({ ok: true, value });

/** Read only own enumerable data fields. Never evaluate getters or toJSON.
 * Descriptor inspection also rejects inherited fields, symbols and class instances.
 * Throwing proxy traps fail closed without returning their exception data. */
const readRecord = (input: unknown, allowed: readonly string[]): ValidationResult<Record<string, unknown>> => {
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
const objectId = (input: unknown): input is ObjectIdRepresentation =>
  typeof input === 'string' && input.length === 24 && /^[a-fA-F0-9]{24}$/.test(input);
const dataset = (input: unknown): input is Dataset => input === 'expenses' || input === 'incomes';
const economicRole = (input: unknown): input is EconomicRole =>
  ECONOMIC_ROLES.some(role => role === input);
const financialLayer = (input: unknown): input is FinancialLayer =>
  FINANCIAL_LAYERS.some(layer => layer === input);

const identityFrom = (record: Record<string, unknown>): ValidationResult<OperationIdentity> => {
  if (!objectId(record.owner)) return failure('invalid_owner');
  if (!dataset(record.dataset)) return failure('invalid_dataset');
  if (!objectId(record.operationId)) return failure('invalid_operation_id');
  return success(Object.freeze({ owner: record.owner, dataset: record.dataset, operationId: record.operationId }));
};
export const validateOperationIdentity = (input: unknown): ValidationResult<OperationIdentity> => {
  const record = readRecord(input, ['owner', 'dataset', 'operationId']);
  return record.ok ? identityFrom(record.value) : record;
};

export const validateDecisionRevision = (input: unknown): ValidationResult<DecisionRevision> => {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1)
    return failure('invalid_decision_revision');
  // This brand proves shape only, never server authority or a successful CAS.
  return success(input as DecisionRevision);
};

export const validateClassificationAssignment = (input: unknown): ValidationResult<ClassificationAssignment> => {
  const checked = readRecord(input, ['economicRole', 'layer']);
  if (!checked.ok) return checked;
  const { economicRole: role, layer } = checked.value;
  if (!economicRole(role)) return failure('invalid_economic_role');
  if (role === 'ordinary_expense') {
    if (!financialLayer(layer)) return failure('invalid_financial_layer');
    return success(Object.freeze({ economicRole: role, layer }));
  }
  // Explicit null distinguishes a deliberate non-spending assignment from missing data.
  if (layer !== null) return failure('invalid_financial_layer');
  return success(Object.freeze({ economicRole: role, layer: null }));
};

/** Structural invariants only. Does NOT approve dataset/role compatibility,
 * prove a manual action occurred, verify owner access or establish source freshness. */
export const validateClassificationDecision = (input: unknown): ValidationResult<ClassificationDecision> => {
  const checked = readRecord(input, [
    'owner', 'dataset', 'operationId', 'taxonomyVersion', 'decisionOrigin',
    'decisionRevision', 'state', 'assignment',
  ]);
  if (!checked.ok) return checked;
  const record = checked.value;
  const identity = identityFrom(record);
  if (!identity.ok) return identity;
  if (record.taxonomyVersion !== PROVISIONAL_TAXONOMY_VERSION) return failure('unsupported_taxonomy');
  if (record.decisionOrigin !== 'manual') return failure('invalid_decision_origin');
  const revision = validateDecisionRevision(record.decisionRevision);
  if (!revision.ok) return revision;
  if (record.state !== 'approved' && record.state !== 'explicit_unclassified' && record.state !== 'cleared')
    return failure('invalid_state');
  const base: DecisionBase = {
    ...identity.value, taxonomyVersion: PROVISIONAL_TAXONOMY_VERSION,
    decisionOrigin: 'manual', decisionRevision: revision.value,
  };
  if (record.state === 'approved') {
    if (!Object.hasOwn(record, 'assignment')) return failure('missing_assignment');
    const assignment = validateClassificationAssignment(record.assignment);
    if (!assignment.ok) return assignment;
    return success(Object.freeze({ ...base, state: 'approved', assignment: assignment.value }));
  }
  if (Object.hasOwn(record, 'assignment')) return failure('unexpected_assignment');
  return success(Object.freeze({ ...base, state: record.state }));
};
