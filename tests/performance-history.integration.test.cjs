const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createHarness, testConfiguration } = require('./helpers/mongodb-integration.cjs');
const { installFixture, blueprint, sourceDigest, OWNER, FOREIGN, START, END } = require('./helpers/performance-history.cjs');
const { CLASSIFICATION_MANIFEST: manifest } = require('../dist/persistence/classificationManifest');
const selected = blueprint(4), income = blueprint(5);
const requestBody = rows => ({ version: 'classification-history-read-request-v1', startInclusive: START, endExclusive: END,
  operations: rows.map(x => ({ dataset: x.dataset, operationId: x.id })) });
const batch = Array.from({ length: 100 }, (_, i) => blueprint(i));
const guard = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Controlled barrier deadline')), 5000); })]); } finally { clearTimeout(timer); } };
describe('P12 deterministic history, real query budgets and bounded mutation/load drills', { concurrency: false, timeout: 120000 }, () => {
  let h, db, token, foreignToken, fixture, saved, baseline, originalExpense, originalIncome, originalDecision;
  const oid = x => new h.mongoose.Types.ObjectId(x);
  const read = (rows = batch, bearer = token) => h.request('POST', '/classifications/history/read', requestBody(rows), bearer);
  const source = () => db.collection('expenses').findOne({ _id: oid(selected.id), owner: oid(OWNER) });
  before(async () => {
    testConfiguration(process.env); saved = process.env.CLASSIFICATION_HISTORY_READ_ENABLED;
    h = await createHarness(process.env, true); db = h.mongoose.connection.db; fixture = await installFixture(h, 1000);
    process.env.CLASSIFICATION_HISTORY_READ_ENABLED = '1';
    token = jwt.sign({ _id: OWNER, exp: 4102444800 }, 'super-secret-key'); foreignToken = jwt.sign({ _id: FOREIGN, exp: 4102444800 }, 'super-secret-key');
    baseline = await sourceDigest(h); originalExpense = await source(); originalIncome = await db.collection('incomes').findOne({ _id: oid(income.id), owner: oid(OWNER) });
    originalDecision = await db.collection(manifest.collectionName).findOne({ owner: oid(OWNER), dataset: 'expenses', operationId: oid(selected.id) });
  });
  afterEach(async () => {
    mock.restoreAll(); h.assertDatabase();
    await db.collection('expenses').replaceOne({ _id: originalExpense._id }, originalExpense, { upsert: true });
    await db.collection('incomes').replaceOne({ _id: originalIncome._id }, originalIncome, { upsert: true });
    await db.collection(manifest.collectionName).replaceOne({ _id: originalDecision._id }, originalDecision, { upsert: true });
  });
  after(async () => {
    mock.restoreAll();
    try { assert.equal((await sourceDigest(h)) === baseline, true, 'All controlled mutations must restore exact original financial BSON'); }
    finally {
      if (saved === undefined) delete process.env.CLASSIFICATION_HISTORY_READ_ENABLED; else process.env.CLASSIFICATION_HISTORY_READ_ENABLED = saved;
      if (h) { assert.equal((await h.close()).dropped, true); console.info('P12 test-owned MongoDB dropped and verified empty; BSON restored, HTTP/log/process resources closed.'); }
    }
  });
  it('uses only actually installed source _id indexes and the approved classification manifest', async () => {
    for (const name of ['expenses', 'incomes']) assert.deepEqual((await db.collection(name).listIndexes().toArray()).map(i => i.name), ['_id_']);
    assert.equal((await db.collection(manifest.collectionName).listIndexes().toArray()).length, 2);
  });
  it('loads deterministic complete membership with compatible ordering and no foreign or outside-window rows', async () => {
    for (const dataset of ['expenses', 'incomes']) {
      const rows = [];
      for (let page = 1; rows.length < fixture.reference.counts[dataset]; page++) {
        const r = await h.request('GET', `/${dataset}?startDate=2025-01-01T00:00:00.000Z&endDate=2025-12-31T23:59:59.999Z&page=${page}&limit=100`, undefined, token);
        assert.equal(r.status, 200); assert.equal(r.body.total, fixture.reference.counts[dataset]);
        assert.equal(r.body[dataset].every(x => x.owner === OWNER && Date.parse(x.date) >= START && Date.parse(x.date) < END), true); rows.push(...r.body[dataset]);
      }
      assert.equal(new Set(rows.map(r => r._id)).size, rows.length);
      assert.equal(rows.every((r, i) => !i || Date.parse(rows[i - 1].date) <= Date.parse(r.date)), true);
    }
  });
  it('returns all requested status/role facts with no-store and no private metadata', async () => {
    const r = await read(); assert.equal(r.status, 200); assert.equal(r.body.returnedCount, 100);
    assert.equal(/no-store/.test(r.headers['cache-control']), true);
    assert.equal(/sourceFingerprint|lastMutation|credentialBinding|reviewProof/.test(r.text), false);
    assert.equal(new Set(r.body.operations.map(x => x.dataset + '/' + x.operationId)).size, 100);
    assert.equal(r.body.operations.some(x => x.classification.status === 'stale'), true);
  });
  it('keeps fixed <=8 MongoDB commands per mixed batch instead of a source/decision N+1', async () => {
    const observed = []; const listener = e => observed.push(e.commandName); const client = h.mongoose.connection.getClient();
    client.on('commandStarted', listener); try { assert.equal((await read()).status, 200); } finally { client.off('commandStarted', listener); }
    assert.equal(observed.filter(n => n === 'find').length, 4); assert.equal(observed.filter(n => n === 'listCollections').length, 2);
    assert.equal(observed.filter(n => n === 'listIndexes').length, 2); assert.equal(observed.length, 8);
  });
  it('rejects cross-owner identities uniformly, while the foreign owner can read its own cohort', async () => {
    assert.equal((await read([selected], foreignToken)).status, 404);
    assert.equal((await read([blueprint(4, FOREIGN)], token)).status, 404);
    assert.equal((await read(Array.from({ length: 100 }, (_, i) => blueprint(i, FOREIGN)), foreignToken)).status, 200);
  });
  it('observes a controlled amount edit as exact new facts/stale decision and does not mutate BSON itself', async () => {
    await db.collection('expenses').updateOne({ _id: oid(selected.id), owner: oid(OWNER) }, { $set: { amount: 77.31 } }); const changed = await sourceDigest(h);
    const r = await read([selected]); assert.equal(r.status, 200); assert.equal(r.body.operations[0].facts.amount.value, '77.31');
    assert.equal(r.body.operations[0].classification.status, 'stale'); assert.equal((await sourceDigest(h)) === changed, true);
  });
  it('observes an income edit through the same exact source and stale classification', async () => {
    await db.collection('incomes').updateOne({ _id: oid(income.id), owner: oid(OWNER) }, { $set: { amount: 65.43 } });
    const r = await read([income]); assert.equal(r.status, 200); assert.equal(r.body.operations[0].facts.amount.value, '65.43'); assert.equal(r.body.operations[0].classification.status, 'stale');
  });
  it('rejects an operation moved outside the period rather than publishing partial batch coverage', async () => {
    await db.collection('expenses').updateOne({ _id: oid(selected.id), owner: oid(OWNER) }, { $set: { date: new Date(END) } });
    assert.equal((await read()).status, 409);
  });
  it('fails the whole batch when an owned source was deleted, without implicit repair', async () => {
    await db.collection('expenses').deleteOne({ _id: oid(selected.id), owner: oid(OWNER) });
    assert.equal((await read()).status, 404); assert.equal(await source(), null);
  });
  it('keeps the documented after-observation race visible instead of claiming transactional consistency', async () => {
    const original = h.mongoose.mongo.Collection.prototype.find; let changed = false;
    mock.method(h.mongoose.mongo.Collection.prototype, 'find', function (...args) {
      const cursor = Reflect.apply(original, this, args), array = cursor.toArray.bind(cursor);
      if (this.collectionName === 'expenses') cursor.toArray = async () => {
        const rows = await array(); if (!changed) { changed = true; await db.collection('expenses').updateOne({ _id: oid(selected.id), owner: oid(OWNER) }, { $set: { amount: 88.22 } }); } return rows;
      };
      return cursor;
    });
    const r = await read([selected]); assert.equal(r.status, 200); assert.equal(r.body.consistency, 'observed_only_non_atomic');
    assert.equal(r.body.operations[0].facts.amount.value === String(originalExpense.amount), true); assert.equal((await source()).amount, 88.22);
  });
  it('classification revision/state edits never change source financial BSON', async () => {
    const before = await sourceDigest(h); assert.equal((await read([selected])).body.operations[0].classification.status, 'approved');
    await db.collection(manifest.collectionName).updateOne({ _id: originalDecision._id }, { $set: { decisionRevision: 2, state: 'explicit_unclassified' }, $unset: { assignment: '' } });
    const r = await read([selected]); assert.equal(r.status, 200); assert.equal(r.body.operations[0].classification.status, 'explicit_unclassified');
    assert.equal(r.body.operations[0].classification.decisionRevision, 2); assert.equal((await sourceDigest(h)) === before, true);
  });
  it('bounds one owner to four active reads while another owner and a small GET still progress', async () => {
    const original = h.mongoose.mongo.Collection.prototype.find; let begun = 0, notify, release, released = false;
    const started = new Promise(r => { notify = r; }), pause = new Promise(r => { release = () => { released = true; r(); }; });
    mock.method(h.mongoose.mongo.Collection.prototype, 'find', function (...args) {
      const cursor = Reflect.apply(original, this, args), array = cursor.toArray.bind(cursor);
      if (this.collectionName === 'expenses' && args[0]?.owner?.toHexString() === OWNER) cursor.toArray = async () => {
        if (!released) { begun++; if (begun === 4) notify(); await pause; } return array();
      }; return cursor;
    });
    const inflight = Array.from({ length: 4 }, () => read());
    try {
      await guard(started); assert.equal((await read()).status, 429);
      assert.equal((await read([blueprint(4, FOREIGN)], foreignToken)).status, 200);
      assert.equal((await h.request('GET', '/incomes?page=1&limit=1', undefined, foreignToken)).status, 200);
    } finally { release(); }
    assert.equal((await Promise.all(inflight)).every(r => r.status === 200), true); mock.restoreAll(); assert.equal((await read()).status, 200);
  });
  it('bounds the process to sixteen active reads across owners and releases every admission', async () => {
    const owners = [OWNER, FOREIGN, 'c'.repeat(24), 'd'.repeat(24)], fifth = 'e'.repeat(24);
    await db.collection('users').insertMany([owners[2], owners[3], fifth].map(x => ({ _id: oid(x) })));
    const original = h.mongoose.mongo.Collection.prototype.find; let begun = 0, notify, release, released = false;
    const started = new Promise(r => { notify = r; }), pause = new Promise(r => { release = () => { released = true; r(); }; });
    mock.method(h.mongoose.mongo.Collection.prototype, 'find', function (...args) {
      const cursor = Reflect.apply(original, this, args), array = cursor.toArray.bind(cursor);
      if (this.collectionName === 'expenses') cursor.toArray = async () => { if (!released) { begun++; if (begun === 16) notify(); await pause; } return array(); }; return cursor;
    });
    const inflight = owners.flatMap(owner => Array.from({ length: 4 }, () => read(batch, jwt.sign({ _id: owner, exp: 4102444800 }, 'super-secret-key'))));
    try { await guard(started); assert.equal((await read(batch, jwt.sign({ _id: fifth, exp: 4102444800 }, 'super-secret-key'))).status, 429); }
    finally { release(); }
    const results = await Promise.all(inflight); assert.equal(results.filter(r => r.status === 200).length, 4); assert.equal(results.filter(r => r.status === 404).length, 12);
    mock.restoreAll(); assert.equal((await read()).status, 200);
  });
  it('rejects oversized source fields with bounded synthetic payloads and no financial error echo', async () => {
    await db.collection('expenses').updateOne({ _id: oid(selected.id), owner: oid(OWNER) }, { $set: { recipient: 'x'.repeat(8193) } });
    const r = await read([selected]); assert.equal(r.status, 503); assert.equal(r.text.includes('x'.repeat(32)), false);
  });
  it('preserves unsupported binary64 precision exactly for frontend rejection, never rounds source data', async () => {
    await db.collection('expenses').updateOne({ _id: oid(selected.id), owner: oid(OWNER) }, { $set: { amount: 0.1 + 0.2 } });
    const r = await read([selected]); assert.equal(r.status, 200); assert.equal(r.body.operations[0].facts.amount.value, '0.30000000000000004');
    assert.equal((await source()).amount === 0.1 + 0.2, true);
  });
  it('fails closed on a bounded injected MongoDB time-limit failure and releases owner admission', async () => {
    const original = h.mongoose.mongo.Collection.prototype.find; let bounded = false;
    mock.method(h.mongoose.mongo.Collection.prototype, 'find', function (...args) {
      const cursor = Reflect.apply(original, this, args);
      if (this.collectionName === 'expenses') {
        bounded = args[1]?.maxTimeMS === 3000;
        cursor.toArray = async () => { throw new h.mongoose.mongo.MongoServerError({ message: 'Fictional time limit', code: 50 }); };
      } return cursor;
    });
    assert.equal((await read()).status, 503); assert.equal(bounded, true); mock.restoreAll();
    assert.equal((await read()).status, 200);
  });
  it('handles an actual client abort during a bounded paused query without claiming MongoDB cancellation', async () => {
    const original = h.mongoose.mongo.Collection.prototype.find; let notify, release, finish;
    const started = new Promise(r => { notify = r; }), pause = new Promise(r => { release = r; }), finished = new Promise(r => { finish = r; });
    const admission = require('../dist/services/classificationAdmission'), admit = admission.admitClassificationRead;
    mock.method(admission, 'admitClassificationRead', (...args) => {
      const leave = admit(...args); return leave ? () => { leave(); finish(); } : null;
    });
    mock.method(h.mongoose.mongo.Collection.prototype, 'find', function (...args) {
      const cursor = Reflect.apply(original, this, args), array = cursor.toArray.bind(cursor);
      if (this.collectionName === 'expenses') cursor.toArray = async () => { notify(); await pause; return array(); };
      return cursor;
    });
    const controller = new AbortController();
    const pending = fetch(h.baseUrl + '/classifications/history/read', { method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody(batch)) }).then(() => false, e => e.name === 'AbortError');
    try { await guard(started); controller.abort(); assert.equal(await pending, true); }
    finally { release(); await guard(finished); mock.restoreAll(); }
    assert.equal((await Promise.all(Array.from({ length: 4 }, () => read()))).every(r => r.status === 200), true);
  });
  it('fails closed during real driver connection loss, then reconnects only the guarded generated DB', async () => {
    const config = testConfiguration(process.env); await h.mongoose.disconnect(); assert.equal((await read()).status, 503);
    await h.mongoose.connect(config.baseUri, { dbName: h.databaseName, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 5000, monitorCommands: true });
    db = h.mongoose.connection.db; h.assertDatabase(); assert.equal((await read()).status, 200);
  });
});
