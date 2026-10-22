const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createHarness, testConfiguration } = require('./helpers/mongodb-integration.cjs');
const { createLocalRuntimeFixture } = require('./helpers/ubuntu-runtime.cjs');
const { installSecureClassificationRuntime: install } = require('../dist/services/classificationRuntime/install');
const { inspectUbuntuMongo } = require('../dist/services/classificationRuntime/ubuntu/preflight');
const { CLASSIFICATION_MANIFEST: manifest } = require('../dist/persistence/classificationManifest');
const { evidence } = require('./helpers/ubuntu-ledger.cjs');
const owner = 'a'.repeat(24), other = 'b'.repeat(24), id = '1'.repeat(24);
const gates = ['CLASSIFICATION_READ_ENABLED', 'CLASSIFICATION_REVIEW_ENABLED', 'CLASSIFICATION_WRITE_ENABLED', 'CLASSIFICATION_RECONCILE_ENABLED'];
const allOff = { prepare: false, apply: false, reconcile: false };
describe('P11.1 real local providers with real HTTP/MongoDB; external trust remains synthetic', { concurrency: false, timeout: 120000 }, () => {
  let h, db, local, runtime, saved, bearer, beforeBson;
  const oid = x => new h.mongoose.Types.ObjectId(x);
  const snapshot = async name => { h.assertDatabase(); return JSON.stringify((await db.collection(name).find({}).sort({ _id: 1 }).toArray()).map(r => h.mongoose.mongo.BSON.serialize(r).toString('hex'))); };
  const count = () => db.collection(manifest.collectionName).countDocuments({});
  const body = () => ({ version: 'classification-review-request-v1', browserReviewContext: randomUUID(), requestId: randomUUID(), expectedRevision: null,
    state: 'approved', assignment: { economicRole: 'ordinary_expense', layer: 'everyday' } });
  const call = (action, payload, token = bearer) => h.request('POST', `/classifications/expenses/${id}/${action}`, payload, token);
  const prepare = async () => { const command = body(), r = await call('reviews', command); assert.equal(r.status, 200, 'Isolated prepare'); return { command, proof: r.body.reviewProof }; };
  const apply = p => call('commands', { ...p.command, version: 'classification-command-v1', reviewProof: p.proof });
  const reconcile = p => call('commands/reconcile', { ...p.command, version: 'classification-reconcile-request-v1', reviewProof: p.proof });
  const start = async () => { const r = await install(require('../dist/app'), h.mongoose.connection, local.config, local.providers(), 'isolated-test');
    assert.equal(r.ok, true, 'Local provider installation'); runtime = r.value; };
  const close = async () => {
    mock.restoreAll(); if (runtime) { assert.equal(await runtime.shutdown(), true, 'Known local admissions drain'); runtime = undefined; }
    if (local) { local.cleanup(); local = undefined; }
  };
  before(async () => { testConfiguration(process.env); saved = Object.fromEntries(gates.map(g => [g, process.env[g]])); h = await createHarness(process.env); db = h.mongoose.connection.db; });
  beforeEach(async () => {
    await close(); h.assertDatabase();
    for (const name of ['users', 'expenses', 'incomes']) await db.collection(name).deleteMany({});
    if (await db.listCollections({ name: manifest.collectionName }).hasNext()) await db.collection(manifest.collectionName).drop();
    await db.createCollection(manifest.collectionName, manifest.options); await db.collection(manifest.collectionName).createIndex(manifest.index.key, manifest.index.options);
    await db.collection('users').insertMany([{ _id: oid(owner) }, { _id: oid(other) }]);
    await db.collection('expenses').insertOne({ _id: oid(id), owner: oid(owner), amount: 12.34, date: new Date('2025-01-15T12:00:00Z'), category: 'Транспорт', title: 'Fictional fuel', recipient: 'Fictional station', comment: '' });
    for (const g of gates) process.env[g] = '1';
    bearer = jwt.sign({ _id: owner, exp: 4102444800 }, 'super-secret-key'); beforeBson = await snapshot('expenses');
    local = await createLocalRuntimeFixture(h.databaseName);
  });
  after(async () => {
    try { await close(); } finally {
      for (const g of gates) if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g];
      if (h) { assert.equal((await h.close()).dropped, true); console.info('Ubuntu provider test-owned MongoDB dropped and verified empty; SQLite/credentials/HTTP/log resources closed.'); }
    }
  });
  it('preserves default-off production wiring and refuses synthetic operational assurance', async () => {
    assert.equal((await call('reviews', body())).status, 503);
    assert.equal((await install(require('../dist/app'), h.mongoose.connection, local.config, local.providers(), 'operational')).ok, false);
    assert.equal(await count(), 0);
  });
  it('persists exact manual decision, enforces owner/CAS and leaves source BSON untouched', async () => {
    await start(); const p = await prepare(), q = await prepare(); assert.equal(await count(), 0);
    const otherBearer = jwt.sign({ _id: other, exp: 4102444800 }, 'super-secret-key');
    assert.equal((await call('reviews', body(), otherBearer)).status, 404);
    assert.equal((await apply(p)).status, 201); assert.equal((await apply(q)).status, 409); assert.equal((await apply(p)).status, 200);
    const stored = await db.collection(manifest.collectionName).findOne({ owner: oid(owner), operationId: oid(id) });
    assert.equal(stored.decisionRevision, 1); assert.equal(stored.assignment.layer, 'everyday'); assert.equal(stored.decisionOrigin, 'manual');
    assert.equal(await snapshot('expenses') === beforeBson, true); assert.equal(await count(), 1);
  });
  it('keeps real encryption failures spent in SQLite and never refunds', async () => {
    await start(); const crypto = require('node:crypto'); const spy = mock.method(crypto, 'createCipheriv', () => { throw Error('Private synthetic failure'); });
    assert.equal((await call('reviews', body())).status, 503); spy.mock.restore();
    const p = await prepare(); assert.equal((await apply(p)).status, 201);
    const { DatabaseSync } = require('node:sqlite'); const sql = new DatabaseSync(require('node:path').join(local.f.directory, 'authority.sqlite'), { readOnly: true });
    assert.equal(sql.prepare('SELECT used FROM materials').get().used, 2); sql.close();
  });
  for (const dependency of ['available', 'secretsAvailable', 'clockAvailable', 'reviewed'])
    it('fails closed during real HTTP on provider loss: ' + dependency, async () => {
      await start(); const p = await prepare(); local.state[dependency] = false;
      assert.equal((await call('reviews', body())).status, 503); assert.equal((await apply(p)).status, 503);
      assert.equal(await count(), 0); assert.equal(await snapshot('expenses') === beforeBson, true);
    });
  for (const phase of ['before', 'after']) it('holds durable admission ' + phase + ' real commit and blocks early maintenance', async () => {
    await start(); const p = await prepare(), original = h.mongoose.mongo.Collection.prototype.insertOne;
    let release, begun; const started = new Promise(r => { begun = r; }), pause = new Promise(r => { release = r; });
    const spy = mock.method(h.mongoose.mongo.Collection.prototype, 'insertOne', async function (...args) {
      if (this.collectionName === manifest.collectionName && phase === 'before') { begun(); await pause; }
      const result = await Reflect.apply(original, this, args);
      if (this.collectionName === manifest.collectionName && phase === 'after') { begun(); await pause; } return result;
    });
    const applying = apply(p); await started;
    assert.equal((await local.ledger.status()).active, 1); assert.equal(await runtime.drain(0), false);
    assert.equal(await local.ledger.setGates(allOff), true); assert.equal(await local.ledger.enterMaintenance(), false);
    release(); assert.equal((await applying).status, 201); spy.mock.restore();
    assert.equal(await runtime.shutdown(), true); runtime = undefined;
    assert.equal(await local.ledger.enterMaintenance(), true); assert.equal(await local.ledger.releaseWriter(), true);
    assert.equal(await snapshot('expenses') === beforeBson, true);
  });
  it('preserves unknown committed outcome and read-only reconciliation with DML/DDL trapped', async () => {
    await start(); const p = await prepare(), original = h.mongoose.mongo.Collection.prototype.insertOne;
    const loss = mock.method(h.mongoose.mongo.Collection.prototype, 'insertOne', async function (...args) {
      const result = await Reflect.apply(original, this, args); if (this.collectionName === manifest.collectionName) throw Error('Synthetic response lost'); return result;
    });
    const result = await apply(p); loss.mock.restore(); assert.equal(result.status, 503); assert.equal(result.body.persistence, 'unknown');
    const before = await snapshot(manifest.collectionName);
    const spies = ['insertOne', 'updateOne', 'deleteOne', 'deleteMany', 'drop', 'createIndex'].map(m => mock.method(h.mongoose.mongo.Collection.prototype, m, () => { throw Error('Read-only recovery mutation forbidden'); }));
    assert.equal((await reconcile(p)).body.result, 'latest_applied'); spies.forEach(s => s.mock.restore());
    assert.equal(await snapshot(manifest.collectionName) === before, true); assert.equal(await snapshot('expenses') === beforeBson, true);
    assert.equal(local.state.events.some(e => e.type === 'write_unknown'), true);
  });
  it('drains read-only reconciliation and prepare requests without permitting maintenance early', async () => {
    await start(); const p = await prepare(); assert.equal((await apply(p)).status, 201);
    for (const action of ['reviews', 'commands/reconcile']) {
      const original = h.mongoose.mongo.Collection.prototype.findOne; let release, begun, once = false;
      const started = new Promise(r => { begun = r; }), pause = new Promise(r => { release = r; });
      const spy = mock.method(h.mongoose.mongo.Collection.prototype, 'findOne', async function (...args) {
        if (!once && this.collectionName === 'expenses') { once = true; begun(); await pause; } return Reflect.apply(original, this, args);
      });
      const response = call(action, action === 'reviews' ? body() : { ...p.command, version: 'classification-reconcile-request-v1', reviewProof: p.proof });
      await started; assert.equal(await runtime.shutdown(0), false); assert.equal((await local.ledger.status()).active, 1);
      release(); assert.equal((await response).status, 503); spy.mock.restore();
      assert.equal(await runtime.shutdown(), true); runtime = undefined;
      if (action === 'reviews') await start();
    }
  });
  it('reports absent manifest as migration required without any DDL or source reads', async () => {
    await db.collection(manifest.collectionName).drop();
    const spies = ['find', 'findOne', 'insertOne', 'updateOne', 'deleteOne', 'deleteMany', 'drop', 'createIndex'].map(m => mock.method(h.mongoose.mongo.Collection.prototype, m, () => { throw Error('Preflight DML/DDL forbidden'); }));
    const create = mock.method(h.mongoose.mongo.Db.prototype, 'createCollection', () => { throw Error('Preflight DDL forbidden'); });
    const result = await inspectUbuntuMongo(h.mongoose.connection, local.config, evidence);
    assert.deepEqual(result, { code: 'migration_required', message: 'MIGRATION REQUIRED — NOT EXECUTED' });
    spies.forEach(s => s.mock.restore()); create.mock.restore(); assert.equal(await db.listCollections({ name: manifest.collectionName }).hasNext(), false);
  });
  it('inspects exact metadata, rejects FCV evidence gaps and wrong namespace without mutation', async () => {
    assert.equal((await inspectUbuntuMongo(h.mongoose.connection, local.config, evidence)).code, 'metadata_ready');
    assert.equal((await inspectUbuntuMongo(h.mongoose.connection, local.config, {})).code, 'operator_evidence_missing');
    assert.equal((await inspectUbuntuMongo(h.mongoose.connection, { ...local.config, databaseName: 'other_fixture' }, evidence)).code, 'namespace_mismatch');
    await db.collection(manifest.collectionName).createIndex({ state: 1 }, { name: 'unapproved_fixture' });
    assert.equal((await inspectUbuntuMongo(h.mongoose.connection, local.config, evidence)).code, 'metadata_mismatch');
  });
  it('fails on real MongoDB connection shutdown without starting or repairing a service', async () => {
    await start(); const p = await prepare();
    // Close this suite's actual driver connection, then reconnect ONLY the guarded
    // generated database so teardown can verify/drop it. No system service access.
    const config = testConfiguration(process.env);
    await h.mongoose.disconnect();
    assert.equal((await call('reviews', body())).status, 503); assert.equal((await apply(p)).status, 503);
    assert.equal((await inspectUbuntuMongo(h.mongoose.connection, local.config, evidence)).code, 'connection_unavailable');
    await h.mongoose.connect(config.baseUri, { dbName: h.databaseName, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 5000, autoCreate: false, autoIndex: false }); db = h.mongoose.connection.db;
    h.assertDatabase(); assert.equal(await count(), 0); assert.equal(await snapshot('expenses') === beforeBson, true);
  });
});
