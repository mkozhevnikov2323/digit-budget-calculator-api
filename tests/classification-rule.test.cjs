const { it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { FINANCIAL_LAYERS } = require('../dist/domain/classification.js');
const { createClassificationRuleModel, CLASSIFICATION_RULE_COLLECTION,
  normalizeRuleMatch } = require('../dist/models/classificationRule.js');
const owner = () => new mongoose.Types.ObjectId('a'.repeat(24));
const expense = (extra = {}) => ({ owner: owner(), dataset: 'expenses', enabled: true,
  category: ' Транспорт ', economicRole: 'ordinary_expense', layer: 'emergency', ...extra });
const income = (extra = {}) => ({ owner: owner(), dataset: 'incomes', enabled: false,
  source: ' Зарплата ', economicRole: 'ordinary_income', layer: null, ...extra });
let Model;
const guards = [];
before(() => {
  const forbidden = () => { throw new Error('Database IO forbidden'); };
  for (const [target, method] of [[mongoose, 'connect'], [mongoose.Connection.prototype, 'openUri'],
    [mongoose.Connection.prototype, 'createCollection'], [mongoose.Model, 'createIndexes'],
    [mongoose.mongo.MongoClient.prototype, 'connect']]) guards.push(mock.method(target, method, forbidden));
  Model = createClassificationRuleModel(new mongoose.Mongoose().connection);
});
after(() => { for (const guard of guards) assert.equal(guard.mock.callCount(), 0); mock.restoreAll(); });
const valid = async input => { const doc = new Model(input); await doc.validate(); return doc; };
const invalid = async input => assert.rejects(async () => { await new Model(input).validate(); }, () => true);

it('validates expense groups, optional title, explicit enabled and generated identity/timestamps', async () => {
  for (const layer of FINANCIAL_LAYERS) {
    const doc = await valid(expense({ layer }));
    assert.equal(doc.category, 'транспорт'); assert.equal(Object.hasOwn(doc.toObject(), 'title'), false);
    assert.ok(doc._id instanceof mongoose.Types.ObjectId); assert.ok(doc.createdAt instanceof Date);
    assert.ok(doc.updatedAt instanceof Date); assert.equal(doc.enabled, true);
  }
  assert.equal((await valid(expense({ title: ' БЕНЗИН ' }))).title, 'бензин');
});
it('accepts exactly the v2-compatible income roles with an explicit null layer', async () => {
  for (const economicRole of ['ordinary_income', 'loan_repayment', 'refund', 'internal_transfer', 'capital_movement']) {
    const doc = await valid(income({ economicRole }));
    assert.equal(doc.source, 'зарплата'); assert.equal(doc.layer, null); assert.equal(doc.enabled, false);
  }
});
it('rejects cross-dataset fields, invalid assignments and new/retired roles', async () => {
  for (const data of [expense({ source: 'Зарплата' }), income({ category: 'Еда' }), income({ title: 'Еда' }),
    expense({ economicRole: 'internal_transfer', layer: null }), expense({ economicRole: 'loan_issuance', layer: null }),
    expense({ layer: null }), expense({ layer: 'unknown' }), income({ layer: 'everyday' }),
    income({ layer: undefined }), income({ economicRole: 'ordinary_expense' }), income({ economicRole: 'loan_issuance' }),
    income({ economicRole: 'unknown' })]) await invalid(data);
});
it('rejects missing/blank fields, coercion, invalid identities/dates and unknown fields', async () => {
  for (const data of [expense({ owner: undefined }), expense({ owner: 'a'.repeat(24) }), expense({ _id: null }),
    expense({ enabled: undefined }), expense({ enabled: 'true' }), expense({ dataset: 'other' }),
    expense({ category: undefined }), expense({ category: '  ' }), expense({ category: 123 }),
    expense({ title: '' }), expense({ title: '  ' }), expense({ title: null }), expense({ title: 123 }),
    income({ source: undefined }), income({ source: ' \t ' }), income({ source: 123 }),
    expense({ createdAt: new Date(NaN) }), expense({ updatedAt: '2026-01-01' }),
    expense({ createdAt: new Date(2), updatedAt: new Date(1) }), expense({ unknown: true })]) await invalid(data);
});
it('canonicalizes matching values without collapsing internal spaces or changing source data', async () => {
  const data = expense({ category: '  ВЫДАЧА ЗАЙМА  ', title: '  Личный  Заём  ' });
  const before = { ...data }, a = await valid(data);
  const b = await valid(expense({ category: 'выдача займа', title: 'личный  заём' }));
  assert.equal(a.category, b.category); assert.equal(a.title, b.title); assert.deepEqual(data, before);
  assert.equal(normalizeRuleMatch('  ЗАРПЛАТА  '), 'зарплата');
  assert.equal((await valid(income({ source: 'зАрПлАтА' }))).source, (await valid(income())).source);
});
it('declares owner-scoped unique partial indexes covering enabled/disabled and untitled rules', async () => {
  const indexes = Model.schema.indexes(); assert.equal(indexes.length, 2);
  assert.deepEqual(indexes.map(([key]) => key), [
    { owner: 1, dataset: 1, category: 1, title: 1 }, { owner: 1, dataset: 1, source: 1 },
  ]);
  for (const [i, [, options]] of indexes.entries()) {
    assert.equal(options.unique, true); assert.equal(options.sparse, undefined);
    assert.deepEqual(options.partialFilterExpression, { dataset: i === 0 ? 'expenses' : 'incomes' });
    assert.deepEqual(options.collation, { locale: 'simple' });
  }
  // These are index-key assertions, not a simulation of MongoDB duplicate rejection.
  const key = (doc, fields) => fields.map(field => doc.get(field)?.toString() ?? null);
  for (const [i, make] of [expense, income].entries()) {
    const fields = Object.keys(indexes[i][0]), a = await valid(make()), b = await valid(make({ enabled: false }));
    assert.deepEqual(key(a, fields), key(b, fields));
    const other = await valid(make({ owner: new mongoose.Types.ObjectId('b'.repeat(24)) }));
    assert.notDeepEqual(key(a, fields), key(other, fields));
  }
  assert.notEqual((await valid(expense())).title, (await valid(expense({ title: 'бензин' }))).title);
});
it('keeps the model disconnected with no automatic collection/index creation', () => {
  assert.equal(Model.collection.collectionName, CLASSIFICATION_RULE_COLLECTION);
  assert.equal(CLASSIFICATION_RULE_COLLECTION, 'classification_rules');
  assert.equal(Model.db.readyState, 0); assert.equal(Model.schema.options.autoCreate, false);
  assert.equal(Model.schema.options.autoIndex, false); assert.equal(Model.schema.options.strict, 'throw');
  assert.equal(Model.schema.options.strictQuery, 'throw'); assert.equal(Model.schema.options.versionKey, false);
});
