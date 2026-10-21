const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { testConfiguration, openTestDatabase, assertOwnedDatabase } = require('./helpers/mongodb-integration.cjs');
const { input, omit, invalidCases } = require('./helpers/classification-fixtures.cjs');

describe('real MongoDB isolated classification persistence foundation', { concurrency:false, timeout:120000 }, () => {
  let mongoose, database, Model, collection, manifest, prepare, fromBson, sourceSnapshot;
  const guard = () => assertOwnedDatabase(database.connection, database.name);
  const prepared = (value = input()) => {
    const result = prepare(value); assert.equal(result.ok,true,'Expected valid synthetic record'); return result.value;
  };
  const snapshotSources = async () => {
    guard();
    return Promise.all(['expenses','incomes'].map(async name =>
      (await database.connection.db.collection(name).find({}).sort({_id:1}).toArray()).map(x=>mongoose.mongo.BSON.serialize(x))));
  };
  before(async () => {
    // Validate exact disposable-only configuration before importing persistence/Mongoose.
    testConfiguration(process.env);
    mongoose = require('mongoose');
    database = await openTestDatabase(mongoose,process.env);
    ({ CLASSIFICATION_MANIFEST:manifest } = require('../dist/persistence/classificationManifest.js'));
    ({ prepareClassificationDocument:prepare, classificationFromBson:fromBson } = require('../dist/persistence/classification.js'));
    const { createOperationClassificationModel } = require('../dist/models/operationClassification.js');
    Model = createOperationClassificationModel(database.connection);
    await Model.init();
    guard();
    assert.equal((await database.connection.db.listCollections({ name:manifest.collectionName }).toArray()).length,0,
      'Ordinary model import/init must not create collection');
    // Explicit installation ONLY after the existing generated database ownership guard.
    guard(); collection = await database.connection.db.createCollection(manifest.collectionName,manifest.options);
    guard(); await collection.createIndex(manifest.index.key,manifest.index.options);
    for (const name of ['expenses','incomes']) {
      guard(); await database.connection.db.collection(name).insertOne({
        _id:new mongoose.Types.ObjectId(input().operationId), owner:new mongoose.Types.ObjectId(input().owner),
        amount:12.34, date:new Date(1736942400000), ...(name==='expenses'
          ? {category:'Транспорт',title:'Fuel',recipient:'Fictional station'} : {source:'Synthetic salary'}),
        __v:0, createdAt:new Date(1736942400001), updatedAt:new Date(1736942400001),
      });
    }
    sourceSnapshot = await snapshotSources();
  });
  beforeEach(async () => { guard(); await collection.deleteMany({}); });
  after(async () => {
    if (!database) return;
    try {
      if (sourceSnapshot) assert.equal(isDeepStrictEqual(await snapshotSources(),sourceSnapshot),true,'Source BSON changed');
    } finally {
      assert.deepEqual(await database.dispose(),{dropped:true,disconnected:true});
    }
    console.info('Classification test-owned MongoDB dropped and verified empty; connection released.');
  });

  for (const layer of ['everyday','irregular']) {
    it(`creates and reads an approved expense with ${layer}`, async () => {
      guard();
      const stored = await Model.create(prepared(input({assignment:{economicRole:'ordinary_expense',layer}})));
      const lean = await Model.findOne({_id:stored._id,owner:new mongoose.Types.ObjectId(input().owner)}).lean();
      const checked = fromBson(lean);
      assert.equal(checked.ok,true); assert.equal(checked.value.assignment.layer,layer);
      assert.equal(checked.value.taxonomyVersion,'financial-classification-v1');
      assert.equal(Object.hasOwn(lean,'__v'),false);
    });
  }
  it('creates approved income with explicit null layer', async () => {
    guard(); const doc = prepared(input({dataset:'incomes',assignment:{economicRole:'ordinary_income',layer:null}}));
    await Model.create(doc);
    assert.equal(fromBson(await collection.findOne({_id:doc._id})).value.assignment.layer,null);
  });
  for (const state of ['explicit_unclassified','cleared']) {
    it(`stores ${state} with no assignment property`, async () => {
      guard(); const doc = prepared(omit(input({state}),'assignment')); await Model.create(doc);
      const saved = await collection.findOne({_id:doc._id});
      assert.equal(saved.state,state); assert.equal(Object.hasOwn(saved,'assignment'),false);
      assert.equal(fromBson(saved).ok,true);
    });
  }
  for (const [name,change] of invalidCases) {
    it(`database validator independently rejects ${name}`, async () => {
      guard();
      const bad = change(prepared());
      await assert.rejects(collection.insertOne(bad), error => error.code===121);
      assert.equal(await collection.countDocuments({}),0);
    });
  }
  it('enforces document validation on raw updates as well as inserts', async () => {
    guard(); const doc=prepared(); await collection.insertOne(doc);
    await assert.rejects(collection.updateOne({_id:doc._id},{$set:{state:'cleared'}}),error=>error.code===121);
    assert.equal((await collection.findOne({_id:doc._id})).state,'approved');
  });
  it('prevents duplicate tuple even for cleared and ObjectId case aliases', async () => {
    guard(); await Model.create(prepared());
    const duplicate=prepared(omit(input({state:'cleared',owner:input().owner.toUpperCase()}),'assignment'));
    await assert.rejects(collection.insertOne(duplicate),error=>error.code===11000);
    assert.equal(await collection.countDocuments({}),1);
  });
  it('allows same operation ID in separate datasets and for different owners', async () => {
    guard();
    await Model.create(prepared());
    await Model.create(prepared(input({dataset:'incomes',assignment:{economicRole:'ordinary_income',layer:null}})));
    await Model.create(prepared(input({owner:'bbbbbbbbbbbbbbbbbbbbbbbb'})));
    assert.equal(await collection.countDocuments({}),3);
    assert.equal(await Model.countDocuments({owner:new mongoose.Types.ObjectId(input().owner)}),2);
    assert.equal(await Model.countDocuments({owner:new mongoose.Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb')}),1);
  });
  it('preserves safe integer bounds and exact BSON Long reads', async () => {
    guard(); const doc=prepared(input({decisionRevision:Number.MAX_SAFE_INTEGER}));
    doc.decisionRevision=mongoose.mongo.BSON.Long.fromString('9007199254740991');
    await collection.insertOne(doc);
    const saved=await collection.findOne({_id:doc._id},{promoteLongs:false});
    assert.equal(fromBson(saved).value.decisionRevision,Number.MAX_SAFE_INTEGER);
    const bad=prepared(); bad.decisionRevision=mongoose.mongo.BSON.Long.fromString('9007199254740992');
    await assert.rejects(collection.insertOne(bad),error=>error.code===121);
  });
  it('installed manifest has strict validator and full unique tuple index only', async () => {
    guard();
    const info=await database.connection.db.listCollections({name:manifest.collectionName}).next();
    assert.equal(isDeepStrictEqual(info.options.validator,manifest.options.validator),true,'Installed validator differs');
    assert.equal(info.options.validationLevel,'strict'); assert.equal(info.options.validationAction,'error');
    const indexes=await collection.listIndexes().toArray();
    assert.equal(indexes.length,2);
    const tuple=indexes.find(index=>index.name===manifest.index.options.name);
    assert.deepEqual(tuple.key,manifest.index.key); assert.equal(tuple.unique,true);
    assert.equal(Boolean(tuple.sparse),false); assert.equal(Object.hasOwn(tuple,'partialFilterExpression'),false);
    assert.equal(Object.hasOwn(tuple,'expireAfterSeconds'),false);
  });
  it('never changes the existing expense/income BSON documents', async () => {
    guard(); await Model.create(prepared());
    assert.equal(isDeepStrictEqual(await snapshotSources(),sourceSnapshot),true);
  });
});
