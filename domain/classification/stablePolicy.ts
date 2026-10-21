/** Approved D3/D4 contract. Explicit stable policy, never a provisional fallback. */
import { STABLE_TAXONOMY_VERSION, type ClassificationDecision, type Dataset, type EconomicRole } from '../classification';
import { POLICY_VERSION, validateCompatibilityPolicy, evaluateClassificationDecision,
  type CompatibilityResult } from './policy';

export const STABLE_ROLE_DATASETS: Readonly<Record<EconomicRole, readonly Dataset[]>> = Object.freeze({
  ordinary_expense: Object.freeze(['expenses'] as const),
  ordinary_income: Object.freeze(['incomes'] as const),
  loan_issuance: Object.freeze(['expenses'] as const),
  loan_repayment: Object.freeze(['incomes'] as const),
  refund: Object.freeze(['incomes'] as const),
  internal_transfer: Object.freeze(['expenses', 'incomes'] as const),
  capital_movement: Object.freeze(['expenses', 'incomes'] as const),
});
export const STABLE_POLICY_DEFINITION = Object.freeze({
  policyId: 'financial-classification-v1-d3', policyVersion: POLICY_VERSION,
  taxonomyVersion: STABLE_TAXONOMY_VERSION, allowedDatasets: STABLE_ROLE_DATASETS,
});
const policy = validateCompatibilityPolicy(STABLE_POLICY_DEFINITION);
export type StableClassificationDecision = ClassificationDecision & Readonly<{ taxonomyVersion: typeof STABLE_TAXONOMY_VERSION }>;

export const validateStableClassificationDecision = (input: unknown): CompatibilityResult<StableClassificationDecision> => {
  if (!policy.ok) return policy;
  const checked = evaluateClassificationDecision(input, policy.value);
  if (!checked.ok) return checked;
  // evaluate requires an exact taxonomy match with the explicit stable policy.
  return { ok: true, value: checked.value.decision as StableClassificationDecision };
};
