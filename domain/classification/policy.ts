/** Pure compatibility checks. No default policy, IO, authorization or interpretation. */
import {
  ECONOMIC_ROLES, isSupportedTaxonomyVersion, validateClassificationDecision,
  type ClassificationDecision, type Dataset, type EconomicRole, type TaxonomyVersion,
  type ValidationErrorCode,
} from '../classification';

/** Version of the policy structure, not approval of a particular matrix. */
export const POLICY_VERSION = 'dataset-role-compatibility-v1' as const;
export type CompatibilityPolicyDefinition = Readonly<{
  /** A trusted caller's explicit, versioned identity for this particular matrix. */
  policyId: string;
  policyVersion: typeof POLICY_VERSION;
  taxonomyVersion: TaxonomyVersion;
  /** Every role is explicit; an empty array deliberately denies both datasets. */
  allowedDatasets: Readonly<Record<EconomicRole, readonly Dataset[]>>;
}>;
export type PolicyErrorCode =
  | 'invalid_policy' | 'unexpected_policy_field' | 'invalid_policy_identity'
  | 'unsupported_policy_version' | 'unsupported_policy_taxonomy'
  | 'invalid_policy_matrix' | 'invalid_policy_dataset'
  | 'unvalidated_policy' | 'incompatible_assignment';
export type CompatibilityResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: PolicyErrorCode | ValidationErrorCode }> }>;
const failure = (code: PolicyErrorCode): CompatibilityResult<never> => ({ ok: false, error: { code } });
const success = <T>(value: T): CompatibilityResult<T> => ({ ok: true, value });

/** Policy data only. C2.1 remains authoritative for decision/layer validation. */
const readRecord = (input: unknown, keys: readonly string[]): CompatibilityResult<Record<string, unknown>> => {
  if (typeof input !== 'object' || input === null) return failure('invalid_policy');
  try {
    if (Array.isArray(input)) return failure('invalid_policy');
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return failure('invalid_policy');
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !keys.includes(key)) return failure('unexpected_policy_field');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return failure('invalid_policy');
      result[key] = descriptor.value;
    }
    return success(result);
  } catch {
    return failure('invalid_policy');
  }
};

const readDatasets = (input: unknown): CompatibilityResult<readonly Dataset[]> => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
      return failure('invalid_policy_matrix');
    const length: unknown = Object.getOwnPropertyDescriptor(input, 'length')?.value;
    if (typeof length !== 'number' || length < 0 || length > 2) return failure('invalid_policy_matrix');
    // Dense array with no extra own fields, symbols, accessors or hidden entries.
    const keys = Reflect.ownKeys(input);
    if (keys.length !== length + 1) return failure('invalid_policy_matrix');
    const result: Dataset[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        return failure('invalid_policy_matrix');
      const value: unknown = descriptor.value;
      if (value !== 'expenses' && value !== 'incomes') return failure('invalid_policy_dataset');
      if (result.includes(value)) return failure('invalid_policy_matrix');
      result.push(value);
    }
    return success(Object.freeze(result));
  } catch {
    return failure('invalid_policy_matrix');
  }
};

const validateDefinition = (input: unknown): CompatibilityResult<CompatibilityPolicyDefinition> => {
  const read = readRecord(input, ['policyId', 'policyVersion', 'taxonomyVersion', 'allowedDatasets']);
  if (!read.ok) return read;
  const record = read.value;
  if (typeof record.policyId !== 'string' || record.policyId.length < 1 || record.policyId.length > 80
    || /\s/.test(record.policyId) || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(record.policyId))
    return failure('invalid_policy_identity');
  if (record.policyVersion !== POLICY_VERSION) return failure('unsupported_policy_version');
  if (!isSupportedTaxonomyVersion(record.taxonomyVersion)) return failure('unsupported_policy_taxonomy');
  const matrix = readRecord(record.allowedDatasets, ECONOMIC_ROLES);
  if (!matrix.ok) return matrix;
  if (ECONOMIC_ROLES.some(role => !Object.hasOwn(matrix.value, role))) return failure('invalid_policy_matrix');
  const allowedDatasets = {} as Record<EconomicRole, readonly Dataset[]>;
  for (const role of ECONOMIC_ROLES) {
    const datasets = readDatasets(matrix.value[role]);
    if (!datasets.ok) return datasets;
    allowedDatasets[role] = datasets.value;
  }
  return success(Object.freeze({
    policyId: record.policyId, policyVersion: POLICY_VERSION,
    taxonomyVersion: record.taxonomyVersion,
    allowedDatasets: Object.freeze(allowedDatasets),
  }));
};

/** Opaque immutable value: no global registry or mutable policy selection.
 * Native private-field identity rejects raw objects, casts, clones and proxies.
 * This prevents accidental misuse; it is not a trust/authentication boundary. */
class CheckedPolicy {
  readonly #definition: CompatibilityPolicyDefinition;
  private constructor(definition: CompatibilityPolicyDefinition) {
    this.#definition = definition;
    Object.freeze(this);
  }
  static validate(input: unknown): CompatibilityResult<CheckedPolicy> {
    const checked = validateDefinition(input);
    return checked.ok ? success(new CheckedPolicy(checked.value)) : checked;
  }
  static definitionOf(input: unknown): CompatibilityPolicyDefinition | undefined {
    return typeof input === 'object' && input !== null && #definition in input ? input.#definition : undefined;
  }
}
export type ValidatedCompatibilityPolicy = CheckedPolicy;
export const validateCompatibilityPolicy = (input: unknown): CompatibilityResult<ValidatedCompatibilityPolicy> =>
  CheckedPolicy.validate(input);

export type CompatibleDecision = Readonly<{
  decision: ClassificationDecision;
  policy: Readonly<Pick<CompatibilityPolicyDefinition, 'policyId' | 'policyVersion' | 'taxonomyVersion'>>;
}>;

/** A compatible decision is neither an authorized write nor a financial interpretation.
 * Policy is mandatory, including for non-approved states; never falls back to the RFC. */
export const evaluateClassificationDecision = (
  input: unknown, policy: ValidatedCompatibilityPolicy,
): CompatibilityResult<CompatibleDecision> => {
  const definition = CheckedPolicy.definitionOf(policy);
  if (!definition) return failure('unvalidated_policy');
  const checked = validateClassificationDecision(input);
  if (!checked.ok) return checked;
  const decision = checked.value;
  // Exact match only. Supported versions are never aliases for one another.
  if (decision.taxonomyVersion !== definition.taxonomyVersion) return failure('unsupported_policy_taxonomy');
  if (decision.state === 'approved' && !definition.allowedDatasets[decision.assignment.economicRole].includes(decision.dataset))
    return failure('incompatible_assignment');
  return success(Object.freeze({ decision, policy: Object.freeze({
    policyId: definition.policyId, policyVersion: definition.policyVersion, taxonomyVersion: definition.taxonomyVersion,
  }) }));
};
