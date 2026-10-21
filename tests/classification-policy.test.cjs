const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ECONOMIC_ROLES, PROVISIONAL_TAXONOMY_VERSION, validateClassificationDecision } =
  require('../dist/domain/classification.js');
const { POLICY_VERSION, validateCompatibilityPolicy: validatePolicy, evaluateClassificationDecision: evaluate } =
  require('../dist/domain/classification/policy.js');

// Synthetic RFC candidate ONLY. Neither registered nor approved as backend policy.
const candidate = () => ({
  policyId: 'synthetic-rfc17-candidate-v1', policyVersion: POLICY_VERSION,
  taxonomyVersion: PROVISIONAL_TAXONOMY_VERSION,
  allowedDatasets: {
    ordinary_expense: ['expenses'], ordinary_income: ['incomes'],
    loan_issuance: ['expenses'], loan_repayment: ['incomes'], refund: ['incomes'],
    internal_transfer: ['expenses', 'incomes'], capital_movement: ['expenses', 'incomes'],
  },
});
const decision = (extra = {}) => ({
  owner: 'aaaaaaaaaaaaaaaaaaaaaaaa', dataset: 'expenses', operationId: '111111111111111111111111',
  taxonomyVersion: PROVISIONAL_TAXONOMY_VERSION, decisionOrigin: 'manual',
  decisionRevision: 1, state: 'approved',
  assignment: { economicRole: 'ordinary_expense', layer: 'everyday' }, ...extra,
});
const assignment = (economicRole, layer = null) => ({ economicRole, layer });
const without = (value, key) => {
  const result = { ...value };
  delete result[key];
  return result;
};
const checkedPolicy = (input = candidate()) => {
  const result = validatePolicy(input);
  assert.equal(result.ok, true, 'Expected valid synthetic policy structure');
  return result.value;
};
const accepted = (input, policy) => {
  const result = evaluate(input, policy);
  assert.equal(result.ok, true, 'Expected compatibility under explicit synthetic policy');
  return result.value;
};
// Safe result-only assertions: never attach private input/exception values to failures.
const rejected = (input, policy, code) =>
  assert.deepEqual(evaluate(input, policy), { ok: false, error: { code } });
const invalidPolicy = (input, code) =>
  assert.deepEqual(validatePolicy(input), { ok: false, error: { code } });

describe('explicit synthetic classification compatibility policy', () => {
  for (const layer of ['everyday', 'irregular']) {
    it(`accepts ordinary expenses with ${layer} under the supplied candidate`, () => {
      const input = decision({ assignment: assignment('ordinary_expense', layer) });
      const value = accepted(input, checkedPolicy());
      assert.deepEqual(value.decision, input);
      assert.deepEqual(value.policy, {
        policyId: candidate().policyId, policyVersion: POLICY_VERSION, taxonomyVersion: PROVISIONAL_TAXONOMY_VERSION,
      });
    });
  }
  it('accepts ordinary income with explicit null layer', () => {
    const input = decision({ dataset: 'incomes', assignment: assignment('ordinary_income') });
    assert.deepEqual(accepted(input, checkedPolicy()).decision, input);
  });
  for (const [role, dataset] of [
    ['ordinary_income', 'expenses'], ['ordinary_expense', 'incomes'],
    ['loan_issuance', 'incomes'], ['loan_repayment', 'expenses'], ['refund', 'expenses'],
  ]) {
    it(`rejects structurally valid ${role} on ${dataset} under this candidate`, () => {
      const input = decision({ dataset,
        assignment: assignment(role, role === 'ordinary_expense' ? 'everyday' : null) });
      assert.equal(validateClassificationDecision(input).ok, true);
      rejected(input, checkedPolicy(), 'incompatible_assignment');
    });
  }
  for (const role of ['internal_transfer', 'capital_movement']) {
    for (const dataset of ['expenses', 'incomes']) {
      it(`accepts ${role} on ${dataset} without inventing a spending layer`, () => {
        const input = decision({ dataset, assignment: assignment(role) });
        assert.deepEqual(accepted(input, checkedPolicy()).decision.assignment, assignment(role));
      });
    }
  }
  for (const [role, dataset] of [
    ['loan_issuance', 'expenses'], ['loan_repayment', 'incomes'], ['refund', 'incomes'],
  ]) {
    it(`accepts the candidate direction ${role} on ${dataset}`, () => {
      const input = decision({ dataset, assignment: assignment(role) });
      assert.equal(accepted(input, checkedPolicy()).decision.assignment.economicRole, role);
    });
  }
  it('keeps different layers for two Transport expenses independent of their category', () => {
    const source = [
      { category: 'Транспорт', id: '111111111111111111111111', title: 'Fuel purchase' },
      { category: 'Транспорт', id: '222222222222222222222222', title: 'Car repair' },
    ];
    const policy = checkedPolicy();
    const values = source.map((row, index) => accepted(decision({ operationId: row.id,
      assignment: assignment('ordinary_expense', index === 0 ? 'everyday' : 'irregular') }), policy));
    assert.equal(source[0].category, source[1].category);
    assert.notEqual(values[0].decision.operationId, values[1].decision.operationId);
    assert.deepEqual(values.map(x => x.decision.assignment.layer), ['everyday', 'irregular']);
    assert.equal(values.every(x => !Object.hasOwn(x.decision, 'category')), true);
    rejected({ ...decision(), category: 'Транспорт' }, policy, 'unexpected_field');
  });
  for (const state of ['explicit_unclassified', 'cleared']) {
    it(`preserves ${state} with no assignment, even under an explicit deny-all matrix`, () => {
      const definition = candidate();
      for (const role of ECONOMIC_ROLES) definition.allowedDatasets[role] = [];
      const policy = checkedPolicy(definition);
      const input = without(decision({ state }), 'assignment');
      const output = accepted(input, policy).decision;
      assert.deepEqual(output, input);
      assert.equal(Object.hasOwn(output, 'assignment'), false);
      rejected(decision({ state }), policy, 'unexpected_assignment');
      rejected(input, undefined, 'unvalidated_policy');
    });
  }
  it('does not infer or select a candidate matrix from its identity or the RFC', () => {
    const first = candidate();
    const second = candidate();
    second.policyId = 'synthetic-alternate-v1';
    second.allowedDatasets.ordinary_expense = ['incomes'];
    const policyA = checkedPolicy(first), policyB = checkedPolicy(second);
    accepted(decision(), policyA);
    rejected(decision(), policyB, 'incompatible_assignment');
    accepted(decision({ dataset: 'incomes' }), policyB);
    rejected(decision({ dataset: 'incomes' }), policyA, 'incompatible_assignment');
    // Validation checks shape, not whether product has approved this matrix.
    second.policyId = first.policyId;
    rejected(decision(), checkedPolicy(second), 'incompatible_assignment');
  });
  it('requires explicit validated policy at runtime; raw objects and copies are insufficient', () => {
    const policy = checkedPolicy();
    const fakeValues = [undefined, null, candidate(), Object.freeze(candidate()), {}, [],
      'synthetic-rfc17-candidate-v1', 1, () => policy, { ok: true, value: policy },
      { ...policy }, structuredClone(policy), Object.create(Object.getPrototypeOf(policy)), new Proxy(policy, {})];
    for (const value of fakeValues) rejected(decision(), value, 'unvalidated_policy');
    assert.deepEqual(evaluate(decision()), { ok: false, error: { code: 'unvalidated_policy' } });
    accepted(decision(), policy);
  });
  it('rejects missing, malformed, inherited and non-data policy structures', () => {
    for (const input of [undefined, null, [], 1, 1n, true, 'policy', new Date(0), new Map(),
      Object.create(candidate()), new (class Definition { constructor() { Object.assign(this, candidate()); } })()]) {
      invalidPolicy(input, 'invalid_policy');
    }
    invalidPolicy({}, 'invalid_policy_identity');
    invalidPolicy(without(candidate(), 'allowedDatasets'), 'invalid_policy');
    invalidPolicy({ ...candidate(), allowedDatasets: null }, 'invalid_policy');
    invalidPolicy({ ...candidate(), allowedDatasets: [] }, 'invalid_policy');
    invalidPolicy({ ...candidate(), allowedDatasets: Object.create(candidate().allowedDatasets) }, 'invalid_policy');
  });
  it('rejects malformed identities without coercion, trimming or case normalization', () => {
    for (const policyId of [undefined, null, '', ' ', 1, {}, ['candidate'], new String('candidate'),
      'Candidate', ' candidate', 'candidate ', 'candidate\n', 'candidate..v1', '-candidate', 'a'.repeat(81), 'кандидат']) {
      invalidPolicy({ ...candidate(), policyId }, 'invalid_policy_identity');
    }
  });
  it('rejects missing/unsupported policy versions and taxonomy combinations', () => {
    for (const policyVersion of [undefined, null, '', 1, POLICY_VERSION + ' ', 'dataset-role-compatibility-v2']) {
      invalidPolicy({ ...candidate(), policyVersion }, 'unsupported_policy_version');
    }
    for (const taxonomyVersion of [undefined, null, '', 1, 'financial-classification-v2',
      PROVISIONAL_TAXONOMY_VERSION + ' ', 'financial-layers-v2-provisional']) {
      invalidPolicy({ ...candidate(), taxonomyVersion }, 'unsupported_policy_taxonomy');
    }
    rejected(decision({ taxonomyVersion: 'financial-classification-v1' }), checkedPolicy(), 'unsupported_policy_taxonomy');
    rejected(decision({ taxonomyVersion: 'unknown' }), checkedPolicy(), 'unsupported_taxonomy');
  });
  it('requires an explicit dataset list for all seven roles', () => {
    for (const role of ECONOMIC_ROLES) {
      invalidPolicy({ ...candidate(), allowedDatasets: without(candidate().allowedDatasets, role) }, 'invalid_policy_matrix');
      for (const list of [undefined, null, 'expenses', {}, ['expenses', 'expenses'],
        ['expenses', 'incomes', 'expenses'], new Array(1)]) {
        const input = candidate(); input.allowedDatasets[role] = list;
        invalidPolicy(input, 'invalid_policy_matrix');
      }
      for (const item of ['expense', 'Expenses', 'incomes ', 'unknown', undefined, null, 1, ['expenses']]) {
        const input = candidate(); input.allowedDatasets[role] = [item];
        invalidPolicy(input, 'invalid_policy_dataset');
      }
    }
  });
  it('rejects unexpected policy and matrix properties, including special keys and symbols', () => {
    for (const key of ['unknown', 'constructor', '__proto__', 'prototype', '$set', 'toJSON', 'default', 'category']) {
      const extra = Object.fromEntries([[key, 'synthetic-private-marker']]);
      invalidPolicy({ ...candidate(), ...extra }, 'unexpected_policy_field');
      invalidPolicy({ ...candidate(), allowedDatasets: { ...candidate().allowedDatasets, ...extra } }, 'unexpected_policy_field');
    }
    invalidPolicy({ ...candidate(), [Symbol('private')]: true }, 'unexpected_policy_field');
  });
  it('does not invoke getters, toJSON, coercion hooks or array accessors', () => {
    let calls = 0;
    const get = () => { calls++; throw new Error('synthetic-private-marker'); };
    invalidPolicy(Object.defineProperty(candidate(), 'policyId', { enumerable: true, get }), 'invalid_policy');
    invalidPolicy({ ...candidate(), allowedDatasets: Object.defineProperty({}, 'ordinary_expense',
      { enumerable: true, get }) }, 'invalid_policy');
    const list = Object.defineProperty(['expenses'], '0', { enumerable: true, get });
    const input = candidate(); input.allowedDatasets.ordinary_expense = list;
    invalidPolicy(input, 'invalid_policy_matrix');
    invalidPolicy({ ...candidate(), toJSON: get }, 'unexpected_policy_field');
    invalidPolicy({ ...candidate(), policyId: { toString: get } }, 'invalid_policy_identity');
    invalidPolicy(Object.defineProperty(candidate(), 'policyId', { enumerable: false }), 'invalid_policy');
    assert.equal(calls, 0);
  });
  it('rejects nonstandard arrays and reflection failures without exposing exceptions', () => {
    for (const list of [Object.assign(['expenses'], { extra: true }),
      Object.assign(['expenses'], { [Symbol('private')]: true }), new (class List extends Array {})('expenses'),
      Object.defineProperty(['expenses'], '0', { enumerable: false })]) {
      const input = candidate(); input.allowedDatasets.ordinary_expense = list;
      invalidPolicy(input, 'invalid_policy_matrix');
    }
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('synthetic-private-marker'); } });
    invalidPolicy(proxy, 'invalid_policy');
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    invalidPolicy(revoked.proxy, 'invalid_policy');
    rejected(decision(), revoked.proxy, 'unvalidated_policy');
  });
  it('reuses C2.1 errors for malformed decisions before dataset/role evaluation', () => {
    const policy = checkedPolicy();
    for (const [input, code] of [
      [null, 'invalid_object'], [[], 'invalid_object'], [{}, 'invalid_owner'],
      [decision({ owner: 'invalid' }), 'invalid_owner'],
      [decision({ operationId: 'invalid' }), 'invalid_operation_id'],
      [decision({ dataset: 'unknown' }), 'invalid_dataset'],
      [decision({ assignment: assignment('unknown') }), 'invalid_economic_role'],
      [decision({ assignment: { economicRole: 'ordinary_expense' } }), 'invalid_financial_layer'],
      [decision({ assignment: assignment('ordinary_expense', null) }), 'invalid_financial_layer'],
      [decision({ assignment: assignment('ordinary_income', 'everyday') }), 'invalid_financial_layer'],
      [decision({ assignment: assignment('ordinary_expense', 'unknown') }), 'invalid_financial_layer'],
      [without(decision(), 'assignment'), 'missing_assignment'],
      [decision({ decisionRevision: 0 }), 'invalid_decision_revision'],
      [decision({ decisionOrigin: 'automatic' }), 'invalid_decision_origin'],
      [decision({ state: 'proposed' }), 'invalid_state'],
      [{ ...decision(), recurrence: { activeMonthCount: 12 } }, 'unexpected_field'],
    ]) {
      assert.deepEqual(evaluate(input, policy), validateClassificationDecision(input));
      rejected(input, policy, code);
    }
  });
  it('owns frozen snapshots without mutating or freezing caller objects', () => {
    const definition = candidate(), definitionBefore = structuredClone(definition);
    const input = decision(), inputBefore = structuredClone(input);
    const policy = checkedPolicy(definition);
    const output = accepted(input, policy);
    assert.deepEqual(definition, definitionBefore);
    assert.deepEqual(input, inputBefore);
    assert.equal(Object.isFrozen(definition), false);
    assert.equal(Object.isFrozen(input), false);
    definition.allowedDatasets.ordinary_expense[0] = 'incomes';
    definition.policyId = 'changed';
    input.assignment.layer = 'emergency';
    accepted(decision(), policy);
    rejected(decision({ dataset: 'incomes' }), policy, 'incompatible_assignment');
    assert.equal(output.policy.policyId, definitionBefore.policyId);
    assert.equal(output.decision.assignment.layer, 'everyday');
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(output), true);
    assert.equal(Object.isFrozen(output.policy), true);
    assert.equal(Object.isFrozen(output.decision.assignment), true);
  });
  it('accepts null-prototype policy maps and deeply frozen inputs', () => {
    const input = candidate();
    for (const list of Object.values(input.allowedDatasets)) Object.freeze(list);
    Object.freeze(input.allowedDatasets);
    Object.freeze(input);
    accepted(Object.freeze(decision({ assignment: Object.freeze(assignment('ordinary_expense', 'irregular')) })),
      checkedPolicy(input));
    const plain = candidate();
    plain.allowedDatasets = Object.assign(Object.create(null), plain.allowedDatasets);
    accepted(decision(), checkedPolicy(Object.assign(Object.create(null), plain)));
  });
  it('is deterministic and independent of previous policy validation/evaluation calls', () => {
    const policy = checkedPolicy();
    const input = decision({ dataset: 'incomes' });
    const expected = { ok: false, error: { code: 'incompatible_assignment' } };
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(evaluate(input, policy), expected);
      invalidPolicy({ policyId: 'synthetic-private-marker' }, 'unsupported_policy_version');
      rejected(decision(), undefined, 'unvalidated_policy');
      assert.deepEqual(evaluate(input, checkedPolicy()), expected);
    }
    assert.deepEqual(evaluate(decision(), policy), evaluate(decision(), policy));
    const reversed = candidate();
    reversed.allowedDatasets = Object.fromEntries(Object.entries(reversed.allowedDatasets).reverse());
    reversed.allowedDatasets.internal_transfer.reverse();
    assert.deepEqual(evaluate(decision(), checkedPolicy(reversed)), evaluate(decision(), policy));
  });
});
