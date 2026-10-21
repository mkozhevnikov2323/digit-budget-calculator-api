const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVISIONAL_TAXONOMY_VERSION, ECONOMIC_ROLES, FINANCIAL_LAYERS,
  validateOperationIdentity, validateDecisionRevision,
  validateClassificationAssignment, validateClassificationDecision: validate,
} = require('../dist/domain/classification.js');

const owner = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const otherOwner = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const operationId = '111111111111111111111111';
const identity = (extra = {}) => ({ owner, dataset: 'expenses', operationId, ...extra });
const decision = (extra = {}) => ({
  ...identity(), taxonomyVersion: PROVISIONAL_TAXONOMY_VERSION,
  decisionOrigin: 'manual', decisionRevision: 1, state: 'approved',
  assignment: { economicRole: 'ordinary_expense', layer: 'everyday' }, ...extra,
});
const without = (value, key) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};
const accepted = (input) => {
  const result = validate(input);
  assert.equal(result.ok, true, 'Expected a valid synthetic decision');
  return result.value;
};
const rejected = (input, code) => {
  // Never include raw inputs, IDs or arbitrary exception messages in assertion output.
  assert.deepEqual(validate(input), { ok: false, error: { code } });
};

describe('classification domain foundation (synthetic, pure, no persistence)', () => {
  for (const layer of FINANCIAL_LAYERS) {
    it(`accepts an approved ordinary expense with ${layer}`, () => {
      const input = decision({ assignment: { economicRole: 'ordinary_expense', layer } });
      assert.deepEqual(accepted(input), input);
    });
  }
  it('allows two Transport expenses to have independent approved layers', () => {
    const source = [
      { ...identity(), category: 'Транспорт', title: 'Fuel purchase' },
      { ...identity({ operationId: '222222222222222222222222' }), category: 'Транспорт', title: 'Car repair' },
    ];
    const decisions = [
      accepted(decision()),
      accepted(decision({ operationId: source[1].operationId,
        assignment: { economicRole: 'ordinary_expense', layer: 'irregular' } })),
    ];
    assert.equal(source[0].category, source[1].category);
    assert.notEqual(decisions[0].operationId, decisions[1].operationId);
    assert.deepEqual(decisions.map(x => x.assignment.layer), ['everyday', 'irregular']);
    assert.equal(decisions.every(x => !Object.hasOwn(x, 'category')), true);
  });
  it('accepts ordinary income without a spending layer', () => {
    const value = accepted(decision({ dataset: 'incomes',
      assignment: { economicRole: 'ordinary_income', layer: null } }));
    assert.equal(value.assignment.layer, null);
  });
  for (const role of ECONOMIC_ROLES.filter(x => x !== 'ordinary_expense')) {
    it(`accepts ${role} only with explicit null layer`, () => {
      assert.equal(accepted(decision({ assignment: { economicRole: role, layer: null } }))
        .assignment.economicRole, role);
      for (const layer of [...FINANCIAL_LAYERS, undefined, '', [], 'unknown']) {
        rejected(decision({ assignment: { economicRole: role, layer } }), 'invalid_financial_layer');
      }
      rejected(decision({ assignment: { economicRole: role } }), 'invalid_financial_layer');
    });
  }
  for (const state of ['explicit_unclassified', 'cleared']) {
    it(`preserves the distinct ${state} decision without an assignment`, () => {
      const input = without(decision({ state, decisionRevision: 2 }), 'assignment');
      const value = accepted(input);
      assert.deepEqual(value, input);
      assert.equal(Object.hasOwn(value, 'assignment'), false);
    });
    it(`rejects any own assignment on ${state}, including undefined`, () => {
      for (const assignment of [decision().assignment, null, undefined, {}, '']) {
        rejected(decision({ state, assignment }), 'unexpected_assignment');
      }
    });
  }
  it('requires an assignment on approved, without an implicit default', () => {
    rejected(without(decision(), 'assignment'), 'missing_assignment');
    for (const assignment of [undefined, null, [], 'ordinary_expense', 1]) {
      rejected(decision({ assignment }), 'invalid_object');
    }
  });
  it('requires exactly one supported layer for an ordinary expense', () => {
    for (const layer of [undefined, null, 'unknown', 'regular', '', ['everyday'], ['everyday', 'irregular'], 1]) {
      rejected(decision({ assignment: { economicRole: 'ordinary_expense', layer } }), 'invalid_financial_layer');
    }
    rejected(decision({ assignment: { economicRole: 'ordinary_expense' } }), 'invalid_financial_layer');
  });
  it('rejects unknown roles, including the unapproved unknown sentinel', () => {
    for (const economicRole of ['unknown', 'automatic', '', 'Ordinary_expense', undefined, null, {}, 1]) {
      rejected(decision({ assignment: { economicRole, layer: null } }), 'invalid_economic_role');
    }
  });
  it('does not finalize a dataset/role matrix as structural validation policy', () => {
    // Deliberately shape-only. These combinations MUST NOT be used by a future
    // write API before separate compatibility policy and owner checks are approved.
    assert.equal(accepted(decision({ dataset: 'incomes' })).dataset, 'incomes');
    assert.equal(accepted(decision({ assignment: { economicRole: 'ordinary_income', layer: null } }))
      .dataset, 'expenses');
  });
  it('keeps the exact owner + dataset + operation ID tuple', () => {
    const original = accepted(decision());
    for (const extra of [
      { owner: otherOwner }, { dataset: 'incomes' }, { operationId: '222222222222222222222222' },
    ]) {
      const different = accepted(decision(extra));
      assert.notDeepEqual([original.owner, original.dataset, original.operationId],
        [different.owner, different.dataset, different.operationId]);
    }
    assert.equal(accepted(decision({ dataset: 'incomes' })).operationId, original.operationId);
  });
  it('accepts uppercase ObjectId syntax without normalizing it or proving ownership', () => {
    const input = decision({ owner: owner.toUpperCase(), operationId: 'ABCDEF0123456789ABCDEF01' });
    assert.deepEqual(accepted(input), input);
  });
  for (const [field, code] of [['owner', 'invalid_owner'], ['operationId', 'invalid_operation_id']]) {
    it(`rejects malformed ${field} without coercion or trimming`, () => {
      for (const value of [undefined, null, '', 123, {}, [], new String(owner),
        'a'.repeat(23), 'a'.repeat(25), 'g'.repeat(24), 'а'.repeat(24),
        `${owner}\n`, ` ${owner}`, `${owner} `, `${owner.slice(0, 23)}\n`]) {
        rejected(decision({ [field]: value }), code);
      }
      rejected(without(decision(), field), code);
    });
  }
  it('rejects missing, unknown and coerced datasets', () => {
    for (const dataset of [undefined, null, '', 'expense', 'Incomes', ['expenses'], 1]) {
      rejected(decision({ dataset }), 'invalid_dataset');
    }
  });
  it('fails closed on missing or unsupported taxonomy versions', () => {
    for (const taxonomyVersion of [undefined, null, 1, '', 'financial-layers-v1',
      'financial-layers-v2-provisional', `${PROVISIONAL_TAXONOMY_VERSION} `]) {
      rejected(decision({ taxonomyVersion }), 'unsupported_taxonomy');
    }
  });
  it('accepts positive safe integer decision revisions, including the safe upper bound', () => {
    for (const decisionRevision of [1, 2, Number.MAX_SAFE_INTEGER]) {
      assert.equal(accepted(decision({ decisionRevision })).decisionRevision, decisionRevision);
    }
  });
  it('rejects invalid decision revisions and never substitutes other revision fields', () => {
    for (const decisionRevision of [undefined, null, 0, -0, -1, 1.5, NaN, Infinity,
      -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', 1n, new Number(1), 'caller_local']) {
      rejected(decision({ decisionRevision }), 'invalid_decision_revision');
    }
    for (const key of ['__v', 'updatedAt', 'revision', 'sessionGeneration', 'algorithmVersion']) {
      rejected({ ...without(decision(), 'decisionRevision'), [key]: 1 }, 'unexpected_field');
    }
  });
  it('rejects every unsupported state, including unreviewed and proposed', () => {
    for (const state of [undefined, null, '', 'unreviewed', 'unclassified', 'proposed', 'unknown', 'Approved', 1]) {
      rejected(decision({ state }), 'invalid_state');
    }
  });
  it('never accepts recommendations, rule origins or recurrence evidence as manual decisions', () => {
    for (const decisionOrigin of [undefined, null, 'automatic', 'recommendation', 'category_rule', {}, 1]) {
      rejected(decision({ decisionOrigin }), 'invalid_decision_origin');
    }
    rejected({ ...decision(), observation: { activeMonthCount: 12 } }, 'unexpected_field');
    rejected({ ...decision(), recommendation: decision().assignment }, 'unexpected_field');
    rejected({ version: 'observations-v0', observations: [] }, 'unexpected_field');
    rejected(decision({ assignment: { activeMonthCount: 12 } }), 'unexpected_field');
  });
  it('rejects unexpected fields at both decision and assignment boundaries', () => {
    for (const key of ['category', 'amount', 'comment', 'sourceFingerprint', 'sourceFingerprintVersion',
      'toJSON', '__proto__', 'constructor', 'prototype', '$set', 'owner.name', '']) {
      const extra = Object.fromEntries([[key, 'synthetic-private-marker']]);
      rejected({ ...decision(), ...extra }, 'unexpected_field');
      rejected(decision({ assignment: { ...decision().assignment, ...extra } }), 'unexpected_field');
    }
    rejected({ ...decision(), [Symbol('private')]: 'synthetic-private-marker' }, 'unexpected_field');
    rejected(decision({ assignment: { ...decision().assignment, [Symbol('private')]: true } }), 'unexpected_field');
  });
  it('rejects null, arrays, primitives and non-plain objects without throwing', () => {
    for (const input of [null, undefined, [], [decision()], 1, 1n, true, 'approved',
      () => decision(), new Date(0), new Map(), new Set(), Object.create(decision()),
      new (class Decision { constructor() { Object.assign(this, decision()); } })()]) {
      rejected(input, 'invalid_object');
    }
    rejected({}, 'invalid_owner');
    rejected(decision({ assignment: {} }), 'invalid_economic_role');
  });
  it('rejects inherited fields and prototype pollution payloads', () => {
    rejected(Object.assign(Object.create({ owner }), without(decision(), 'owner')), 'invalid_object');
    rejected(decision({ assignment: Object.create(decision().assignment) }), 'invalid_object');
    const parsed = JSON.parse('{"__proto__":{"polluted":true}}');
    rejected({ ...decision(), ...parsed }, 'unexpected_field');
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  });
  it('does not execute getters, coercion hooks or toJSON methods', () => {
    let calls = 0;
    const getter = Object.defineProperty(decision(), 'owner', {
      enumerable: true, get() { calls++; throw new Error('synthetic-private-marker'); },
    });
    rejected(getter, 'invalid_object');
    const assignment = Object.defineProperty({}, 'economicRole', {
      enumerable: true, get() { calls++; throw new Error('synthetic-private-marker'); },
    });
    rejected(decision({ assignment }), 'invalid_object');
    const hooks = { toString() { calls++; return owner; }, toJSON() { calls++; return owner; } };
    rejected(decision({ owner: hooks }), 'invalid_owner');
    rejected({ ...decision(), toJSON() { calls++; return decision(); } }, 'unexpected_field');
    assert.equal(calls, 0);
  });
  it('rejects hidden fields and safely contains throwing or revoked proxies', () => {
    rejected(Object.defineProperty(decision(), 'owner', { enumerable: false }), 'invalid_object');
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('synthetic-private-marker'); } });
    rejected(proxy, 'invalid_object');
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    rejected(revoked.proxy, 'invalid_object');
  });
  it('accepts own data fields on null-prototype objects and frozen fixtures', () => {
    const input = Object.assign(Object.create(null), decision({
      assignment: Object.assign(Object.create(null), decision().assignment),
    }));
    Object.freeze(input.assignment);
    Object.freeze(input);
    assert.equal(accepted(input).state, 'approved');
  });
  it('does not mutate inputs or return mutable aliases to them', () => {
    const input = decision();
    const before = structuredClone(input);
    Object.freeze(input.assignment);
    Object.freeze(input);
    const output = accepted(input);
    assert.deepEqual(input, before);
    assert.notEqual(output, input);
    assert.notEqual(output.assignment, input.assignment);
    assert.equal(Object.isFrozen(output), true);
    assert.equal(Object.isFrozen(output.assignment), true);
    const mutable = decision();
    const snapshot = accepted(mutable);
    mutable.owner = otherOwner;
    mutable.assignment.layer = 'emergency';
    assert.equal(snapshot.owner, owner);
    assert.equal(snapshot.assignment.layer, 'everyday');
    const bad = decision({ state: 'cleared' });
    const badBefore = structuredClone(bad);
    rejected(bad, 'unexpected_assignment');
    assert.deepEqual(bad, badBefore);
  });
  it('returns deterministic safe errors with no partial objects or private metadata', () => {
    const bad = decision({ assignment: { economicRole: 'synthetic-private-marker', layer: null } });
    const first = validate(bad);
    assert.deepEqual(first, { ok: false, error: { code: 'invalid_economic_role' } });
    for (let i = 0; i < 3; i++) assert.deepEqual(validate(bad), first);
    const good = decision();
    assert.deepEqual(validate(good), validate(good));
    assert.deepEqual(validate(Object.fromEntries(Object.entries(good).reverse())), validate(good));
  });
  it('validates standalone identity, assignment and revision boundaries strictly', () => {
    assert.deepEqual(validateOperationIdentity(identity()), { ok: true, value: identity() });
    assert.deepEqual(validateOperationIdentity({ ...identity(), category: 'Transport' }),
      { ok: false, error: { code: 'unexpected_field' } });
    assert.deepEqual(validateClassificationAssignment(decision().assignment),
      { ok: true, value: decision().assignment });
    assert.deepEqual(validateClassificationAssignment({ economicRole: 'ordinary_income', layer: 'everyday' }),
      { ok: false, error: { code: 'invalid_financial_layer' } });
    assert.deepEqual(validateDecisionRevision(1), { ok: true, value: 1 });
    assert.deepEqual(validateDecisionRevision('1'), { ok: false, error: { code: 'invalid_decision_revision' } });
  });
});
