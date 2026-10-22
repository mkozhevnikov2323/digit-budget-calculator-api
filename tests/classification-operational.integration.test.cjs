const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash, randomBytes } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createHarness, testConfiguration } = require('./helpers/mongodb-integration.cjs');
const { fixtureConfiguration, createSyntheticAuthority } = require('./helpers/operational-runtime.cjs');
const { installSecureClassificationRuntime: install } = require('../dist/services/classificationRuntime/install');
const { classificationOperationalPreflight: preflight } = require('../dist/services/classificationRuntime/preflight');
const { deploymentEvidence } = require('../dist/services/classificationRuntime/contracts');
const { validateRuntimeConfiguration } = require('../dist/domain/classification/runtimeConfiguration');
const { CLASSIFICATION_MANIFEST: manifest } = require('../dist/persistence/classificationManifest');
const owner = 'a'.repeat(24), foreign = 'b'.repeat(24), id = '1'.repeat(24);
const gates = ['CLASSIFICATION_READ_ENABLED', 'CLASSIFICATION_REVIEW_ENABLED', 'CLASSIFICATION_WRITE_ENABLED', 'CLASSIFICATION_RECONCILE_ENABLED'];
const completeEvidence = deploymentEvidence({ mongoMajor: 7, fcvMajor: 7, privilegesReviewed: true, ownerLifecycleReviewed: true,
  backupsRestoreReviewed: true, privateTelemetryReviewed: true, unshardedReviewed: true, ddlExcluded: true, restoreExcluded: true, fleetPolicyCurrent: true });
const valid = r => { assert.equal(r.ok, true, 'Expected isolated runtime success'); return r.value; };

describe('P11 managed runtime through real Express/JWT/CAS/disposable MongoDB (synthetic operational infrastructure)', { concurrency: false, timeout: 120000 }, () => {
  let h, db, runtime, authority, fixture, bearer, saved, beforeBson;
  const oid = value => new h.mongoose.Types.ObjectId(value);
  const snapshots = async collection => { h.assertDatabase(); return JSON.stringify((await db.collection(collection).find({}).sort({ _id: 1 }).toArray())
    .map(row => h.mongoose.mongo.BSON.serialize(row).toString('hex'))); };
  const body = (extra = {}) => ({ version: 'classification-review-request-v1', browserReviewContext: randomUUID(), requestId: randomUUID(),
    expectedRevision: null, state: 'approved', assignment: { economicRole: 'ordinary_expense', layer: 'everyday' }, ...extra });
  const call = (action, payload, token = bearer) => h.request('POST', `/classifications/expenses/${id}/${action}`, payload, token);
  const prepare = async (extra = {}) => { const command = body(extra), r = await call('reviews', command);
    assert.equal(r.status, 200, 'Real synthetic preparation must succeed'); return { command, proof: r.body.reviewProof, response: r.body }; };
  const apply = p => call('commands', { ...p.command, version: 'classification-command-v1', reviewProof: p.proof });
  const reconcile = p => call('commands/reconcile', { ...p.command, version: 'classification-reconcile-request-v1', reviewProof: p.proof });
  const installCurrent = async () => { if (runtime) assert.equal(await runtime.shutdown(), true);
    runtime = valid(await install(require('../dist/app'), h.mongoose.connection, authority.state.config, authority.providers(), 'isolated-test')); };
  const decisionCount = async () => { h.assertDatabase(); return db.collection(manifest.collectionName).countDocuments({}); };
  before(async () => {
    testConfiguration(process.env); saved = Object.fromEntries(gates.map(g => [g, process.env[g]]));
    h = await createHarness(process.env); db = h.mongoose.connection.db;
  });
  beforeEach(async () => {
    if (runtime) { assert.equal(await runtime.shutdown(), true); runtime = undefined; }
    mock.restoreAll(); h.assertDatabase();
    for (const name of ['expenses', 'incomes', 'users']) await db.collection(name).deleteMany({});
    if (await db.listCollections({ name: manifest.collectionName }).hasNext()) await db.collection(manifest.collectionName).drop();
    await db.createCollection(manifest.collectionName, manifest.options); await db.collection(manifest.collectionName).createIndex(manifest.index.key, manifest.index.options);
    await db.collection('users').insertMany([{ _id: oid(owner) }, { _id: oid(foreign) }]);
    await db.collection('expenses').insertOne({ _id: oid(id), owner: oid(owner), amount: 12.34, date: new Date('2025-01-15T12:00:00Z'), category: 'Транспорт', title: 'Fictional fuel', recipient: 'Fictional station', comment: '' });
    for (const gate of gates) process.env[gate] = '1';
    bearer = jwt.sign({ _id: owner, iat: Math.floor(Date.now() / 1000), exp: 4102444800 }, 'super-secret-key');
    fixture = fixtureConfiguration(h.databaseName); authority = createSyntheticAuthority(fixture.config, fixture.materials);
    beforeBson = await snapshots('expenses');
  });
  after(async () => {
    mock.restoreAll(); if (runtime) assert.equal(await runtime.shutdown(), true);
    for (const gate of gates) { if (saved[gate] === undefined) delete process.env[gate]; else process.env[gate] = saved[gate]; }
    if (h) { assert.equal((await h.close()).dropped, true); console.info('Operational runtime test-owned MongoDB dropped and verified empty; HTTP/log/environment resources closed.'); }
  });
  it('keeps flags-only and invalid/missing dependencies unavailable while legacy routes work', async () => {
    assert.equal((await call('reviews', body())).status, 503);
    for (const [configuration, providers, scope] of [[{}, authority.providers(), 'isolated-test'], [fixture.config, {}, 'isolated-test'],
      [fixture.config, authority.providers(), 'operational']]) {
      assert.equal((await install(require('../dist/app'), h.mongoose.connection, configuration, providers, scope)).ok, false);
      assert.equal((await call('reviews', body())).status, 503);
    }
    assert.equal((await h.request('GET', '/expenses', undefined, bearer)).status, 200); assert.equal(await decisionCount(), 0);
  });
  it('requires the existing READ gate for all managed modes without changing legacy GET/auth', async () => {
    await installCurrent(); const p = await prepare(); delete process.env.CLASSIFICATION_READ_ENABLED;
    assert.equal((await call('reviews', body())).status, 503); assert.equal((await apply(p)).status, 503);
    assert.equal((await reconcile(p)).status, 503); assert.equal(await decisionCount(), 0);
    process.env.CLASSIFICATION_READ_ENABLED = '1'; assert.equal((await apply(p)).status, 201);
  });
  it('prepares and persists only after real explicit apply; source BSON stays exact', async () => {
    await installCurrent(); const p = await prepare(); assert.equal(await decisionCount(), 0);
    assert.equal((await apply(p)).status, 201); assert.equal(await decisionCount(), 1);
    assert.equal((await h.request('GET', `/classifications/expenses/${id}`, undefined, bearer)).body.decisionRevision, 1);
    assert.equal(await snapshots('expenses') === beforeBson, true);
  });
  it('denies another owner and preserves CAS conflicts and identical replay', async () => {
    await installCurrent(); const p = await prepare(), q = await prepare({ assignment: { economicRole: 'ordinary_expense', layer: 'irregular' } });
    const other = jwt.sign({ _id: foreign, exp: 4102444800 }, 'super-secret-key');
    assert.equal((await call('reviews', body(), other)).status, 404);
    assert.equal((await call('commands', { ...p.command, version: 'classification-command-v1', reviewProof: p.proof }, other)).status, 403);
    assert.equal((await apply(p)).status, 201); assert.equal((await apply(q)).status, 409); assert.equal((await apply(p)).status, 200);
    assert.equal(await decisionCount(), 1); assert.equal(await snapshots('expenses') === beforeBson, true);
  });
  it('leaves the consumed reservation spent when real encryption fails', async () => {
    await installCurrent(); const crypto = require('node:crypto');
    const spy = mock.method(crypto, 'createCipheriv', () => { throw Error('Fictional private crypto failure'); });
    assert.equal((await call('reviews', body())).status, 503); spy.mock.restore();
    assert.equal([...authority.state.quota.values()][0], 1); assert.equal(await decisionCount(), 0);
    const p = await prepare(); assert.equal((await apply(p)).status, 201);
    assert.equal([...authority.state.quota.values()][0], 2);
  });
  for (const dependency of ['available', 'secretsAvailable', 'clockAvailable', 'reviewed'])
    it('denies real new requests after dependency loss: ' + dependency, async () => {
      await installCurrent(); const p = await prepare(); authority.state[dependency] = false;
      assert.equal((await call('reviews', body())).status, 503); assert.equal((await apply(p)).status, 503);
      assert.equal(await decisionCount(), 0); authority.state[dependency] = true;
    });
  it('rejects source edits as stale without changing classification or financial source again', async () => {
    await installCurrent(); const p = await prepare(); h.assertDatabase();
    await db.collection('expenses').updateOne({ _id: oid(id), owner: oid(owner) }, { $set: { amount: 13 } });
    const changed = await snapshots('expenses'); assert.equal((await apply(p)).status, 409);
    assert.equal(await decisionCount(), 0); assert.equal(await snapshots('expenses') === changed, true);
  });
  it('uses verification-only rotation for old valid proof without allowing the old issuer', async () => {
    await installCurrent(); const p = await prepare(); const bytes = randomBytes(32), now = Math.floor(Date.now() / 1000);
    const next = { ...fixture.config, revision: 2, issuingKid: 'new-synthetic', keys: [
      { ...fixture.config.keys[0], state: 'verify_only', issueUntil: now + 1, verifyUntil: now + 86401 }, { kid: 'new-synthetic', state: 'active', materialId: createHash('sha256').update(bytes).digest('hex'),
        issueFrom: now - 1, issueUntil: now + 2591999, verifyUntil: now + 2678399 }] };
    authority.state.materials.set('new-synthetic', bytes); assert.equal(authority.publish(next), true);
    assert.equal((await apply(p)).status, 503); // Old installed instance cannot use a stale policy snapshot.
    await installCurrent(); assert.equal((await apply(p)).status, 201);
    assert.equal(await decisionCount(), 1);
  });
  it('revokes old proofs and refuses material resurrection through restored configuration', async () => {
    await installCurrent(); const p = await prepare(); const next = { ...fixture.config, revision: 2, issuingKid: null,
      keys: fixture.config.keys.map(k => ({ ...k, state: 'revoked' })) };
    assert.equal(authority.publish(next), true); assert.equal((await apply(p)).status, 503);
    await installCurrent(); assert.equal((await apply(p)).status, 403);
    assert.equal(authority.publish({ ...fixture.config, revision: 3 }), false); assert.equal(await decisionCount(), 0);
  });
  it('invalidates old proof era after incompatible restore into an isolated environment', async () => {
    await installCurrent(); const p = await prepare(); const next = { ...fixture.config, revision: 2, deploymentId: 'new-disposable-restore-era' };
    assert.equal(authority.publish(next, true), true); await installCurrent();
    assert.equal((await apply(p)).status, 403); assert.equal(await decisionCount(), 0);
  });
  it('preserves exact 300s apply and 24h recovery expiration', async () => {
    await installCurrent(); const p = await prepare(); assert.equal((await apply(p)).status, 201);
    authority.advance(300); assert.equal((await apply(p)).status, 410);
    assert.equal((await reconcile(p)).body.result, 'latest_applied'); authority.advance(86400);
    assert.equal((await reconcile(p)).status, 410); assert.equal(await decisionCount(), 1);
  });
  it('blocks new prepare/apply while permitting real read-only recovery after drain', async () => {
    await installCurrent(); const p = await prepare(); assert.equal((await apply(p)).status, 201);
    assert.equal(await runtime.drain(), true);
    assert.equal((await call('reviews', body())).status, 503); assert.equal((await apply(p)).status, 503);
    const before = await snapshots(manifest.collectionName); assert.equal((await reconcile(p)).body.result, 'latest_applied');
    assert.equal(await snapshots(manifest.collectionName) === before, true);
  });
  it('holds drain through an admitted real commit and never calls disablement a rollback', async () => {
    await installCurrent(); const p = await prepare(), original = h.mongoose.mongo.Collection.prototype.insertOne;
    let releaseWrite, notifyStarted; const started = new Promise(resolve => { notifyStarted = resolve; });
    const pause = new Promise(resolve => { releaseWrite = resolve; });
    const spy = mock.method(h.mongoose.mongo.Collection.prototype, 'insertOne', async function (...args) {
      if (this.collectionName === manifest.collectionName) { notifyStarted(); await pause; }
      return Reflect.apply(original, this, args);
    });
    const applying = apply(p); await started;
    assert.equal(runtime.localState().active, 1); assert.equal(await runtime.drain(0), false);
    authority.state.gates = { prepare: false, apply: false, reconcile: false }; assert.equal(authority.enterMaintenance(), false);
    releaseWrite(); assert.equal((await applying).status, 201); spy.mock.restore();
    assert.equal(await runtime.drain(), true); assert.equal(authority.enterMaintenance(), true);
    assert.equal(await decisionCount(), 1); assert.equal(await snapshots('expenses') === beforeBson, true);
  });
  it('keeps unknown-commit semantics and reconciles read-only without any DML/DDL', async () => {
    await installCurrent(); const p = await prepare(), original = h.mongoose.mongo.Collection.prototype.insertOne;
    const loss = mock.method(h.mongoose.mongo.Collection.prototype, 'insertOne', async function (...args) {
      const r = await Reflect.apply(original, this, args); if (this.collectionName === manifest.collectionName) throw Error('Fictional lost acknowledgement'); return r;
    });
    const r = await apply(p); assert.equal(r.status, 503); assert.equal(r.body.persistence, 'unknown'); loss.mock.restore();
    const before = await snapshots(manifest.collectionName);
    const traps = ['insertOne', 'updateOne', 'deleteOne', 'deleteMany', 'drop', 'createIndex'].map(method =>
      mock.method(h.mongoose.mongo.Collection.prototype, method, () => { throw Error('Recovery mutation forbidden'); }));
    assert.equal((await reconcile(p)).body.result, 'latest_applied'); traps.forEach(spy => spy.mock.restore());
    assert.equal(await snapshots(manifest.collectionName) === before, true); assert.equal(await snapshots('expenses') === beforeBson, true);
    assert.equal(authority.state.events.some(e => e.type === 'write_unknown'), true);
  });
  it('refuses missing/mismatched/extra-index manifest without repair or startup DDL', async () => {
    const config = validateRuntimeConfiguration(fixture.config).value;
    h.assertDatabase(); await db.collection(manifest.collectionName).dropIndex(manifest.index.options.name);
    const state = await db.listCollections({ name: manifest.collectionName }).toArray();
    assert.equal((await preflight(h.mongoose.connection, config, completeEvidence)).ok, false);
    assert.equal((await install(require('../dist/app'), h.mongoose.connection, fixture.config, authority.providers(), 'isolated-test')).ok, false);
    assert.equal((await db.collection(manifest.collectionName).listIndexes().toArray()).length, 1);
    assert.equal((await db.listCollections({ name: manifest.collectionName }).toArray()).length, state.length);
    await db.collection(manifest.collectionName).createIndex(manifest.index.key, manifest.index.options);
    await db.collection(manifest.collectionName).createIndex({ state: 1 }, { name: 'synthetic_unapproved_extra' });
    assert.equal((await preflight(h.mongoose.connection, config, completeEvidence)).ok, false);
    assert.equal((await db.collection(manifest.collectionName).listIndexes().toArray()).length, 3);
  });
  it('rejects wrong namespace and unverified privileges/backup/erasure without financial reads', async () => {
    const config = validateRuntimeConfiguration(fixture.config).value;
    assert.equal((await preflight(h.mongoose.connection, { ...config, databaseName: 'other_synthetic' }, completeEvidence)).ok, false);
    assert.equal((await preflight(h.mongoose.connection, config, {})).ok, false);
    authority.state.reviewed = false;
    assert.equal((await install(require('../dist/app'), h.mongoose.connection, fixture.config, authority.providers(), 'isolated-test')).ok, false);
    assert.equal(await decisionCount(), 0);
  });
  it('fails closed if operational health changes during real source observation', async () => {
    await installCurrent(); const original = h.mongoose.mongo.Collection.prototype.findOne; let changed = false;
    const spy = mock.method(h.mongoose.mongo.Collection.prototype, 'findOne', async function (...args) {
      const r = await Reflect.apply(original, this, args);
      if (this.collectionName === 'expenses' && !changed) { changed = true; authority.state.secretsAvailable = false; }
      return r;
    });
    try { assert.equal((await call('reviews', body())).status, 503); assert.equal(await decisionCount(), 0); }
    finally { spy.mock.restore(); authority.state.secretsAvailable = true; }
    assert.equal([...authority.state.quota.values()].length, 0);
  });
  it('startup and preflight use metadata only with financial reads and all DDL trapped', async () => {
    const traps = ['find', 'findOne', 'insertOne', 'updateOne', 'deleteOne', 'deleteMany', 'drop', 'createIndex'].map(method =>
      mock.method(h.mongoose.mongo.Collection.prototype, method, () => { throw Error('Startup source read or mutation forbidden'); }));
    const ddl = mock.method(h.mongoose.mongo.Db.prototype, 'createCollection', () => { throw Error('Startup DDL forbidden'); });
    try { await installCurrent(); } finally { traps.forEach(t => t.mock.restore()); ddl.mock.restore(); }
    assert.equal(await decisionCount(), 0); assert.equal(await snapshots('expenses') === beforeBson, true);
  });
  it('rejects disconnected metadata and unsupported server version without repair', async () => {
    const c = validateRuntimeConfiguration(fixture.config).value;
    assert.equal((await preflight({ readyState: 0 }, c, completeEvidence)).ok, false);
    const proto = Object.getPrototypeOf(db.admin()), original = proto.command;
    const spy = mock.method(proto, 'command', function (command, ...rest) {
      return command.buildInfo ? Promise.resolve({ versionArray: [8, 0, 0] }) : Reflect.apply(original, this, [command, ...rest]);
    });
    try { assert.equal((await preflight(h.mongoose.connection, c, completeEvidence)).ok, false); }
    finally { spy.mock.restore(); }
    assert.equal(await decisionCount(), 0);
  });
  it('rehearses owned BSON backup/restore with drained writers, new era and no quota resurrection', async () => {
    await installCurrent(); const p = await prepare(); assert.equal((await apply(p)).status, 201);
    const names = ['users', 'expenses', 'incomes', manifest.collectionName], backup = new Map();
    authority.state.gates = { prepare: false, apply: false, reconcile: false };
    assert.equal(await runtime.shutdown(), true); runtime = undefined;
    assert.equal(authority.enterMaintenance(), true); h.assertDatabase();
    for (const name of names) backup.set(name, (await db.collection(name).find({}).toArray()).map(row => h.mongoose.mongo.BSON.serialize(row)));
    // Only this helper-generated DB, no external backup files or application DB.
    await db.dropDatabase();
    await db.createCollection(manifest.collectionName, manifest.options);
    await db.collection(manifest.collectionName).createIndex(manifest.index.key, manifest.index.options);
    for (const [name, buffers] of backup) if (buffers.length) await db.collection(name).insertMany(buffers.map(bytes => h.mongoose.mongo.BSON.deserialize(bytes)));
    assert.equal(await snapshots('expenses') === beforeBson, true);
    const spent = [...authority.state.quota.values()][0];
    assert.equal(authority.publish({ ...fixture.config, revision: 2, deploymentId: 'isolated-restored-proof-era' }, true), true);
    authority.state.maintenance = false; authority.state.gates = { prepare: true, apply: true, reconcile: true };
    await installCurrent(); assert.equal((await apply(p)).status, 403);
    assert.equal([...authority.state.quota.values()][0], spent); assert.equal(await decisionCount(), 1);
    const next = await prepare({ expectedRevision: 1 }); assert.equal((await apply(next)).status, 200);
    await db.collection('users').deleteOne({ _id: oid(owner) });
    assert.equal((await reconcile(next)).status, 401); assert.equal(await snapshots('expenses') === beforeBson, true);
  });
  it('prevents concurrent optional installers replacing a live runtime', async () => {
    const results = await Promise.all([1, 2].map(() => install(require('../dist/app'), h.mongoose.connection, fixture.config, authority.providers(), 'isolated-test')));
    assert.equal(results.filter(r => r.ok).length, 1); runtime = valid(results.find(r => r.ok));
    assert.equal((await install(require('../dist/app'), h.mongoose.connection, fixture.config, authority.providers(), 'isolated-test')).ok, false);
  });
});
