// IPC-only disposable browser fixture. Never imported by app.ts/server.ts.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mock } = require('node:test');
const { createHarness, testConfiguration } = require('../helpers/mongodb-integration.cjs');
const { fixtureConfiguration, createSyntheticAuthority } = require('../helpers/operational-runtime.cjs');

const flags = ['CLASSIFICATION_READ_ENABLED', 'CLASSIFICATION_HISTORY_READ_ENABLED',
  'CLASSIFICATION_REVIEW_ENABLED', 'CLASSIFICATION_WRITE_ENABLED', 'CLASSIFICATION_RECONCILE_ENABLED'];
const owners = { a: 'a'.repeat(24), b: 'b'.repeat(24) };
const primary = '1'.repeat(24), foreign = 'b1'.padStart(24, '0'), misc = '2'.repeat(24);
const password = 'Fictional-browser-account-42!';
let stage = 'guard';
let h, runtime, authority, localProvider, closed, baseline, manifest, lost;
const send = message => { if (process.connected) process.send(message); };
const safeError = () => new Error('Disposable browser fixture failed; private details suppressed');
const snapshot = async () => {
  h.assertDatabase();
  return JSON.stringify(await Promise.all(['expenses', 'incomes'].map(async name =>
    (await h.mongoose.connection.db.collection(name).find({}).sort({ _id: 1 }).toArray())
      .map(row => h.mongoose.mongo.BSON.serialize(row).toString('hex')))));
};
async function dispose() {
  if (closed) return closed;
  closed = (async () => {
    lost?.mock.restore();
    let runtimeClosed = true;
    try { if (runtime) runtimeClosed = await runtime.shutdown(); } finally {
      try { localProvider?.cleanup(); } finally {
      if (h) {
        const result = await h.close();
        assert.deepEqual(result, { dropped: true, disconnected: true, listenerClosed: true,
          logsClosed: true, directoryRemoved: true, environmentRestored: true });
      }
      }
    }
    assert.equal(runtimeClosed, true, 'Operational admissions must drain before database disposal');
    return { cleanupVerified: true };
  })();
  return closed;
}
async function seedApproved(dataset, row, role, layer) {
  h.assertDatabase();
  const { fingerprintSourceOperation } = require('../../dist/domain/classification/sourceFingerprint');
  const { prepareClassificationDocument } = require('../../dist/persistence/classification');
  const facts = { owner: row.owner.toHexString(), dataset, operationId: row._id.toHexString(),
    amount: row.amount, date: row.date, ...(Object.hasOwn(row, 'comment') ? { comment: row.comment } : {}),
    ...(dataset === 'expenses' ? { category: row.category, title: row.title, recipient: row.recipient } : { source: row.source }) };
  const fp = fingerprintSourceOperation(facts, 1); assert.equal(fp.ok, true, 'Synthetic facts must validate');
  const now = new Date();
  const doc = prepareClassificationDocument({ owner: facts.owner, dataset, operationId: facts.operationId,
    state: 'approved', assignment: { economicRole: role, layer }, taxonomyVersion: 'financial-classification-v1',
    decisionOrigin: 'manual', decisionRevision: 1, ...fp.value, sourceObservedAt: now, createdAt: now, updatedAt: now,
    lastMutation: { requestId: randomUUID(), commandFingerprint: 'c'.repeat(64), commandFingerprintVersion: 1 } });
  assert.equal(doc.ok, true, 'Synthetic decision must pass the existing persistence validator');
  await h.mongoose.connection.db.collection(manifest.collectionName).insertOne(doc.value);
}
async function start() {
  assert.equal(process.env.BUDGET_BROWSER_TEST, '1', 'Explicit browser test opt-in required');
  assert.equal(typeof process.send, 'function', 'Browser fixture requires a parent IPC lifecycle');
  testConfiguration(process.env); // BEFORE any application import, env mutation or IO.
  stage = 'mongo'; h = await createHarness(process.env);
  const db = h.mongoose.connection.db, oid = id => new h.mongoose.Types.ObjectId(id);
  ({ CLASSIFICATION_MANIFEST: manifest } = require('../../dist/persistence/classificationManifest'));
  stage = 'manifest'; await db.createCollection(manifest.collectionName, manifest.options);
  await db.collection(manifest.collectionName).createIndex(manifest.index.key, manifest.index.options);
  stage = 'accounts'; const hash = await require('bcryptjs').hash(password, 10);
  await db.collection('users').insertMany(Object.entries(owners).map(([name, id]) =>
    ({ _id: oid(id), email: `browser-${name}@example.com`, password: hash })));
  const expense = (id, month, amount, extra = {}) => ({ _id: oid(id), owner: oid(owners.a), amount,
    date: new Date(Date.UTC(2025, month, 15, 12)), category: 'Транспорт', title: 'Fictional fuel',
    recipient: 'Fictional station', comment: '', ...extra });
  const rows = Array.from({ length: 12 }, (_, m) => expense(m === 0 ? primary : (100 + m).toString(16).padStart(24, '0'), m, 100));
  rows.push(expense('3'.repeat(24), 0, 240, { title: 'Fictional repair' }),
    expense('4'.repeat(24), 0, 300, { category: 'Выдача займа', title: 'Fictional loan' }),
    expense(misc, 0, 50, { category: 'Прочее', title: 'Fictional unreviewed' }),
    expense(foreign, 0, 777, { owner: oid(owners.b), title: 'User B private fixture' }),
    expense('5'.repeat(24), 0, 999, { date: new Date('2024-12-31T23:59:59.999Z') }),
    expense('6'.repeat(24), 0, 999, { date: new Date('2026-01-01T00:00:00.000Z') }));
  stage = 'expenses'; await db.collection('expenses').insertMany(rows);
  for (const row of rows.filter(r => r.owner.toHexString() === owners.a && ![primary, misc].includes(r._id.toHexString())))
    await seedApproved('expenses', row, row.category === 'Выдача займа' ? 'loan_issuance' : 'ordinary_expense',
      row.category === 'Выдача займа' ? null : row.title === 'Fictional repair' ? 'irregular' : 'everyday');
  stage = 'incomes'; const incomes = Array.from({ length: 12 }, (_, m) => ({ _id: oid((200 + m).toString(16).padStart(24, '0')),
    owner: oid(owners.a), amount: 1000, date: new Date(Date.UTC(2025, m, 15, 12)), source: 'Fictional salary' }));
  incomes.push({ _id: oid('7'.repeat(24)), owner: oid(owners.a), amount: 50,
    date: new Date('2025-01-15T12:00:00.000Z'), source: 'Возврат займа' });
  await db.collection('incomes').insertMany(incomes);
  for (const row of incomes) await seedApproved('incomes', row, row.source === 'Возврат займа' ? 'loan_repayment' : 'ordinary_income', null);
  stage = 'runtime'; baseline = await snapshot();
  for (const flag of flags) process.env[flag] = '1';
  if (process.env.BUDGET_BROWSER_DEFAULT_OFF !== '1') {
    const fixture = fixtureConfiguration(h.databaseName);
    authority = createSyntheticAuthority(fixture.config, fixture.materials);
    if (process.env.BUDGET_BROWSER_LOCAL_PROVIDER === '1') {
      localProvider = await require('../helpers/ubuntu-runtime.cjs').createLocalRuntimeFixture(h.databaseName);
      authority = localProvider;
    }
    const installed = await require('../../dist/services/classificationRuntime/install').installSecureClassificationRuntime(
      require('../../dist/app'), h.mongoose.connection, localProvider?.config ?? fixture.config, authority.providers(), 'isolated-test');
    assert.equal(installed.ok, true, 'Explicit synthetic operational dependencies must pass real preflight');
    runtime = installed.value;
  }
  // Fault injection into real native persistence, after a real commit, ONLY in this process.
  // No test HTTP endpoints, no bypass of authentication/proofs/writer/CAS.
  const original = h.mongoose.mongo.Collection.prototype.insertOne;
  const observer = mock.method(h.mongoose.mongo.Collection.prototype, 'insertOne', async function (...args) {
    const result = await Reflect.apply(original, this, args);
    if (this.collectionName === manifest.collectionName && lost?.armed) {
      lost.armed = false; throw safeError();
    }
    return result;
  });
  lost = { armed: false, mock: observer.mock };
  stage = 'health'; const signIn = await h.request('POST', '/signin', { email: 'browser-a@example.com', password });
  assert.equal(signIn.status, 200, 'Fictional account must authenticate through real HTTP');
  const health = await h.request('GET', '/__browser_absent__');
  assert.equal(health.status, 401, 'Real Express authentication must be listening');
  send({ type: 'ready', baseUrl: h.baseUrl, primary, foreign, misc, owners });
}
async function command(message) {
  h.assertDatabase(); const db = h.mongoose.connection.db, oid = id => new h.mongoose.Types.ObjectId(id);
  switch (message.command) {
    case 'inspect': {
      const row = await db.collection(manifest.collectionName).findOne({ owner: oid(owners.a), dataset: 'expenses', operationId: oid(primary) });
      return { sourcesUnchanged: (await snapshot()) === baseline, primaryRevision: row?.decisionRevision ?? null,
        primaryLayer: row?.assignment?.layer ?? null, classifications: await db.collection(manifest.collectionName).countDocuments({}),
        expenseCount: await db.collection('expenses').countDocuments({}), incomeCount: await db.collection('incomes').countDocuments({}) };
    }
    case 'approveRemaining':
      for (const id of [primary, misc]) {
        if (!await db.collection(manifest.collectionName).findOne({ owner: oid(owners.a), dataset: 'expenses', operationId: oid(id) }))
          await seedApproved('expenses', await db.collection('expenses').findOne({ _id: oid(id), owner: oid(owners.a) }),
            'ordinary_expense', id === misc ? 'emergency' : 'everyday');
      }
      return { approved: true };
    case 'changeSource':
      await db.collection('expenses').updateOne({ _id: oid(primary), owner: oid(owners.a) }, { $set: { amount: 101 } });
      baseline = await snapshot(); return { changed: true };
    case 'unsupportedPrecision':
      await db.collection('expenses').updateOne({ _id: oid(primary), owner: oid(owners.a) }, { $set: { amount: 1.001 } });
      baseline = await snapshot(); return { changed: true };
    case 'expireProof': authority.advance(301); return { advanced: true };
    case 'loseAcknowledgement': lost.armed = true; return { armed: true };
    case 'unavailable': authority.state.available = false; return { unavailable: true };
    default: throw safeError();
  }
}
let queue = Promise.resolve();
process.on('message', message => {
  queue = queue.then(async () => {
    if (message?.command === 'close') {
      const result = await dispose(); send({ type: 'reply', id: message.id, result }); process.disconnect();
    } else {
      const result = await command(message); send({ type: 'reply', id: message.id, result });
    }
  }).catch(async () => {
    send({ type: 'failure', id: message?.id, message: 'Disposable fixture operation failed; details suppressed' });
    try { await dispose(); } finally { process.exitCode = 1; if (process.connected) process.disconnect(); }
  });
});
for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) process.once(event, () => {
  dispose().catch(() => { process.exitCode = 1; }).finally(() => { if (process.connected) process.disconnect(); });
});
start().catch(async () => {
  send({ type: 'failure', stage, message: 'Disposable fixture startup failed; details suppressed' });
  try { await dispose(); } catch { /* Exit still fails; parent requires verified cleanup. */ }
  process.exitCode = 1; if (process.connected) process.disconnect();
});
