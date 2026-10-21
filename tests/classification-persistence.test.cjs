const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const mongoose = require('mongoose');
const { input, omit, invalidCases, stable } = require('./helpers/classification-fixtures.cjs');
const { validateClassificationDecision, PROVISIONAL_TAXONOMY_VERSION } = require('../dist/domain/classification.js');
const { validateCompatibilityPolicy, evaluateClassificationDecision } = require('../dist/domain/classification/policy.js');
const { STABLE_POLICY_DEFINITION, STABLE_ROLE_DATASETS, validateStableClassificationDecision } = require('../dist/domain/classification/stablePolicy.js');
const { prepareClassificationDocument: prepare, classificationFromBson: fromBson,
  validateClassificationRecord: validate } = require('../dist/persistence/classification.js');
const { CLASSIFICATION_MANIFEST: manifest } = require('../dist/persistence/classificationManifest.js');

const prepared = (value = input()) => {
  const result = prepare(value); assert.equal(result.ok, true, 'Expected valid synthetic classification'); return result.value;
};
const decision = value => Object.fromEntries(['owner','dataset','operationId','state','assignment','taxonomyVersion',
  'decisionOrigin','decisionRevision'].filter(key => Object.hasOwn(value,key)).map(key => [key,value[key]]));

describe('stable classification and strict persistence boundary (no database)', () => {
  for (const taxonomyVersion of [stable, PROVISIONAL_TAXONOMY_VERSION]) {
    it(`preserves exact supported taxonomy ${taxonomyVersion} without conversion`, () => {
      const value = validateClassificationDecision(decision(input({ taxonomyVersion })));
      assert.equal(value.ok, true); assert.equal(value.value.taxonomyVersion, taxonomyVersion);
    });
  }
  it('does not alias stable and provisional policies or accept unknown versions', () => {
    const policy = validateCompatibilityPolicy(STABLE_POLICY_DEFINITION).value;
    assert.equal(evaluateClassificationDecision(decision(input()), policy).ok, true);
    assert.deepEqual(evaluateClassificationDecision(decision(input({ taxonomyVersion: PROVISIONAL_TAXONOMY_VERSION })), policy),
      { ok: false, error: { code: 'unsupported_policy_taxonomy' } });
    assert.equal(validateStableClassificationDecision(decision(input({ taxonomyVersion: 'future' }))).ok, false);
  });
  for (const [role, allowed] of Object.entries(STABLE_ROLE_DATASETS)) {
    for (const dataset of ['expenses', 'incomes']) {
      it(`enforces approved D3 mapping ${role} on ${dataset}`, () => {
        const value = decision(input({ dataset, assignment: { economicRole: role, layer: role === 'ordinary_expense' ? 'irregular' : null } }));
        assert.equal(validateStableClassificationDecision(value).ok, allowed.includes(dataset));
      });
    }
  }
  it('prepares server-generated IDs and round-trips exact stable metadata through BSON', () => {
    const source = input(), before = structuredClone(source);
    const a = prepared(source), b = prepared(source);
    assert.notEqual(a._id.toHexString(), b._id.toHexString());
    assert.equal(isDeepStrictEqual(source, before), true);
    const parsed = fromBson(mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(a)));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.owner, source.owner);
    assert.equal(parsed.value.taxonomyVersion, stable);
    assert.equal(parsed.value.createdAt.getTime(), source.createdAt.getTime());
    assert.equal(Object.hasOwn(parsed.value, '__v'), false);
    source.createdAt.setTime(0); source.lastMutation.requestId = 'changed';
    assert.notEqual(parsed.value.createdAt.getTime(), 0);
    assert.equal(parsed.value.lastMutation.requestId === 'changed', false);
  });
  for (const [name, change] of invalidCases) {
    it(`rejects before Mongoose coercion: ${name}`, () => {
      const bad = change(input());
      const checked = prepare(bad);
      assert.equal(checked.ok, false, 'Malformed synthetic record must fail');
      assert.deepEqual(Object.keys(checked).sort(), ['error', 'ok']);
      assert.deepEqual(Object.keys(checked.error), ['code']);
    });
  }
  it('rejects client _id, explicit undefined assignment, invalid dates and wrong prototypes', () => {
    for (const bad of [null, [], Object.create(input()), { ...input(), _id: 'a'.repeat(24) },
      omit({ ...input(), state: 'cleared', assignment: undefined }, 'unrelated'),
      input({ sourceObservedAt: new Date(NaN) }), input({ createdAt: new Number(1) })]) assert.equal(prepare(bad).ok, false);
  });
  it('does not execute getters, BSON conversion hooks or arbitrary document methods', () => {
    let calls = 0; const hook = () => { calls++; throw new Error('synthetic-private-marker'); };
    const getter = Object.defineProperty(input(), 'owner', { enumerable: true, get: hook });
    assert.equal(prepare(getter).ok, false);
    assert.equal(prepare({ ...input(), toJSON: hook }).ok, false);
    const doc = prepared();
    Object.defineProperty(doc.owner, 'toHexString', { value: hook });
    assert.equal(fromBson(doc).ok, false);
    assert.equal(fromBson({ toObject: hook }).ok, false);
    assert.equal(calls, 0);
  });
  it('supports exact safe BSON Long revisions and rejects loss of numeric precision', () => {
    const doc = prepared();
    doc.decisionRevision = mongoose.mongo.BSON.Long.fromString('9007199254740991');
    assert.equal(fromBson(doc).value.decisionRevision, Number.MAX_SAFE_INTEGER);
    doc.decisionRevision = mongoose.mongo.BSON.Long.fromString('9007199254740992');
    assert.equal(fromBson(doc).ok, false);
    doc.decisionRevision = mongoose.mongo.BSON.Decimal128.fromString('1');
    assert.equal(fromBson(doc).ok, false);
  });
  for (const state of ['explicit_unclassified','cleared']) {
    it(`round-trips ${state} without assignment`, () => {
      const value = fromBson(prepared(omit(input({ state }), 'assignment')));
      assert.equal(value.ok, true); assert.equal(value.value.state, state);
      assert.equal(Object.hasOwn(value.value,'assignment'), false);
    });
  }
  it('defines the exact full index and immutable strict validator manifest', () => {
    assert.equal(manifest.collectionName, 'operation_classifications');
    assert.deepEqual(manifest.index.key, { owner:1, dataset:1, operationId:1 });
    assert.deepEqual(manifest.index.options, { name:'ux_owner_dataset_operation', unique:true, sparse:false, collation:{locale:'simple'} });
    assert.equal(manifest.options.validationLevel,'strict'); assert.equal(manifest.options.validationAction,'error');
    assert.equal(Object.isFrozen(manifest.options.validator),true);
  });
  it('imports/compiles model without connection, index or collection IO', async () => {
    const forbidden = () => { throw new Error('Unexpected model import IO'); };
    const guards = [mock.method(mongoose,'connect',forbidden), mock.method(mongoose.Connection.prototype,'createCollection',forbidden),
      mock.method(mongoose.Model,'createIndexes',forbidden), mock.method(mongoose.Model,'ensureIndexes',forbidden)];
    try {
      const { createOperationClassificationModel } = require('../dist/models/operationClassification.js');
      const Model = createOperationClassificationModel(mongoose.connection);
      assert.equal(Model.schema.options.autoIndex,false); assert.equal(Model.schema.options.autoCreate,false);
      assert.equal(Model.schema.options.versionKey,false);
      await new Model(prepared()).validate();
      for (const value of [prepared(input({ decisionRevision: 2 })), prepared(omit(input({state:'cleared'}),'assignment'))])
        await new Model(value).validate();
      await assert.rejects(new Model({ ...prepared(), decisionRevision:'1' }).validate(), () => true);
      await assert.rejects(new Model({ ...prepared(), state:'cleared' }).validate(), () => true);
      assert.equal(mongoose.connection.readyState,0);
    } finally { guards.reverse().forEach(guard=>guard.mock.restore()); }
  });
});
