/** Compile-only regression contracts. This function is never invoked. */
import {
  evaluateClassificationDecision, type CompatibilityPolicyDefinition,
  type ValidatedCompatibilityPolicy,
} from '../../domain/classification/policy';

const policyArgumentContracts = (
  decision: unknown, policy: ValidatedCompatibilityPolicy, raw: CompatibilityPolicyDefinition,
): void => {
  evaluateClassificationDecision(decision, policy);
  // @ts-expect-error Evaluation must always require an explicit validated policy.
  evaluateClassificationDecision(decision);
  // @ts-expect-error A valid-looking raw definition has not passed policy validation.
  evaluateClassificationDecision(decision, raw);
  // @ts-expect-error No permissive undefined/default policy overload is allowed.
  evaluateClassificationDecision(decision, undefined);
};
