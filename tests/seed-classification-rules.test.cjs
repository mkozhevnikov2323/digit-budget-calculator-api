const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const a = 'a'.repeat(24), b = 'b'.repeat(24);
const copy = doc => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(doc));

describe('initial classification seed: actual model/readiness with stub driver, no MongoDB', () => {
  let seed, parse, connection, rows, indexes, ownerExists, actor, failure, attempts, present;
  const guards = [];
  const find = filter => {
    assert.equal(filter.owner.toHexString(), actor); assert.equal(filter.dataset, 'expenses'); assert.equal(filter.title, null);
    return rows.find(row => row.owner.equals(filter.owner) && row.dataset === filter.dataset && row.category === filter.category && row.title == null);
  };
  const driver = {
    listIndexes: () => ({ toArray: async () => indexes }),
    findOne: async filter => { if (failure === 'read') throw new Error('Synthetic private read error'); const row = find(filter); return row ? { _id: row._id } : null; },
    insertOne: async doc => {
      attempts++; assert.equal(doc.owner.toHexString(), actor);
      assert.equal(doc.dataset, 'expenses'); assert.equal(Object.hasOwn(doc, 'title'), false);
      if (failure === 'write' || failure === 'second_write' && attempts === 2) throw new Error('Synthetic private write error');
      if (failure === 'race') { failure = null; rows.push(copy({ ...doc, layer: 'major_goals', enabled: false })); throw new mongoose.mongo.MongoServerError({ code: 11000, message: 'Synthetic duplicate' }); }
      rows.push(copy(doc));
      if (failure === 'lost_ack') throw new Error('Synthetic private acknowledgement error');
      return { acknowledged: true, insertedId: doc._id };
    },
  };
  const db = {
    listCollections: () => ({ toArray: async () => present ? [{ type: 'collection', options: {} }] : [] }),
    collection: name => {
      if (name === 'users') return { findOne: async filter => { assert.equal(filter._id.toHexString(), actor); return ownerExists ? { _id: filter._id } : null; } };
      assert.equal(name, 'classification_rules', 'Financial collections forbidden'); return driver;
    },
  };
  const run = async (owner = a, write) => { actor = owner; return seed(connection, owner, write); };
  before(() => {
    const forbidden = () => { throw new Error('Real connection or DDL forbidden'); };
    for (const [target, method] of [[mongoose, 'connect'], [mongoose, 'createConnection'],
      [mongoose.Connection.prototype, 'openUri'], [mongoose.Connection.prototype, 'createCollection'],
      [mongoose.Model, 'createIndexes'], [mongoose.mongo.MongoClient.prototype, 'connect']]) guards.push(mock.method(target, method, forbidden));
    ({ seedInitialClassificationRules: seed, parseSeedArguments: parse } = require('../dist/scripts/seedClassificationRules'));
  });
  beforeEach(() => {
    rows = []; attempts = 0; ownerExists = true; present = true; failure = null;
    connection = new mongoose.Mongoose().connection; connection.db = db; connection.readyState = 1;
    const { createClassificationRuleModel } = require('../dist/models/classificationRule');
    indexes = createClassificationRuleModel(connection).schema.indexes().map(([key, options]) => ({ key, ...structuredClone(options) }));
  });
  after(() => { for (const guard of guards) assert.equal(guard.mock.callCount(), 0); mock.restoreAll(); });
  it('requires explicit owner/db, defaults to dry-run and accepts only the explicit write flag', () => {
    assert.deepEqual(parse(['--owner', a, '--db', 'budget']), { owner: a, dbName: 'budget', confirmWrite: false });
    assert.equal(parse(['--owner', a, '--db', 'budget', '--dry-run']).confirmWrite, false);
    assert.equal(parse(['--owner', a, '--db', 'budget', '--confirm-write']).confirmWrite, true);
    const { spawnSync } = require('node:child_process');
    const cli = spawnSync(process.execPath, [require.resolve('../dist/scripts/seedClassificationRules'), '--owner', a, '--db', 'budget', '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, CLASSIFICATION_RULES_MONGODB_URI: '' } });
    assert.equal(cli.status, 1); assert.equal(JSON.parse(cli.stdout).errors, 8); assert.equal(JSON.parse(cli.stdout).created, 0);
    for (const args of [[], ['--db', 'budget'], ['--owner', 'bad', '--db', 'budget'], ['--owner', a],
      ['--owner', a, '--db', 'admin'], ['--owner', a, '--db', 'budget', '--confirm-write', '--dry-run'],
      ['--owner', a, '--db', 'budget', '--confirm-write=false'], ['--owner', a, '--owner', b, '--db', 'budget'],
      ['--owner', a, '--db', 'budget', '--unknown']]) assert.throws(() => parse(args));
  });
  it('dry-runs eight rules without any insert; reports planned separately from created', async () => {
    assert.deepEqual(await run(), { mode: 'dry-run', total: 8, created: 0, skipped: 0, wouldCreate: 8, errors: 0 });
    assert.equal(rows.length, 0); assert.equal(attempts, 0);
  });
  it('inserts exactly the eight normalized expenses, then skips all on repeated execution', async () => {
    assert.equal((await run(a, true)).created, 8);
    assert.deepEqual(rows.map(row => [row.category, row.layer]), [['продукты','everyday'],['аптеки','irregular'],['фастфуд','irregular'],['чаевые','irregular'],['подарки','irregular'],['бар','irregular'],['подписки','everyday'],['такси','everyday']]);
    assert.ok(rows.every(row => row.enabled === true && row.economicRole === 'ordinary_expense'));
    const before = JSON.stringify(rows);
    assert.deepEqual(await run(a, true), { mode: 'write', total: 8, created: 0, skipped: 8, wouldCreate: 0, errors: 0 });
    assert.equal(attempts, 8); assert.equal(JSON.stringify(rows), before);
  });
  it('preserves existing disabled/different and titled rules, and isolates owners', async () => {
    const Model = connection.models.ClassificationRule;
    const existing = new Model({ owner: new mongoose.Types.ObjectId(a), dataset: 'expenses', enabled: false, category: ' Продукты ', economicRole: 'ordinary_expense', layer: 'long_term_capital' });
    await existing.validate(); rows.push(copy(existing.toObject()));
    rows.push(copy(new Model({ ...existing.toObject(), _id: new mongoose.Types.ObjectId(), title: 'Особые' }).toObject()));
    const before = JSON.stringify(rows);
    assert.equal((await run()).skipped, 1); assert.equal(JSON.stringify(rows), before);
    const result = await run(a, true); assert.equal(result.created, 7); assert.equal(result.skipped, 1);
    assert.equal(JSON.stringify(rows.slice(0, 2)), before);
    assert.equal((await run(b, true)).created, 8); assert.equal(rows.filter(row => row.owner.toHexString() === a).length, 9);
  });
  it('handles a concurrent duplicate by rereading the exact owner key without overwriting', async () => {
    failure = 'race'; const result = await run(a, true);
    assert.equal(result.skipped, 1); assert.equal(result.created, 7); assert.equal(result.errors, 0);
    assert.equal(rows[0].enabled, false); assert.equal(rows[0].layer, 'major_goals');
  });
  it('blocks missing owner, unavailable connection, missing collection/indexes without writes', async () => {
    ownerExists = false; assert.equal((await run(a, true)).errorCode, 'owner_not_found'); ownerExists = true;
    connection.readyState = 0; assert.equal((await run(a, true)).errors, 8); connection.readyState = 1;
    present = false; assert.equal((await run(a, true)).errorCode, 'indexes_not_ready'); present = true;
    indexes.pop(); assert.equal((await run(a, true)).errors, 8);
    assert.equal(attempts, 0); assert.equal(rows.length, 0);
  });
  it('stops on read/write/unknown-ack errors, retains counters and never retries', async () => {
    for (const problem of ['read', 'write', 'lost_ack', 'second_write']) {
      failure = problem; attempts = 0; rows = [];
      const result = await run(a, true); assert.equal(result.errors, problem === 'second_write' ? 7 : 8); assert.equal(result.created, problem === 'second_write' ? 1 : 0);
      assert.equal(attempts, problem === 'read' ? 0 : problem === 'second_write' ? 2 : 1); assert.equal(rows.length, ['lost_ack', 'second_write'].includes(problem) ? 1 : 0);
      assert.equal(JSON.stringify(result).includes('Synthetic'), false);
    }
  });
});
