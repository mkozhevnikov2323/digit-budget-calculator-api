// Deterministic FICTIONAL fixtures only. Installation requires an existing guarded
// test harness; no URI, bootstrap, application database or environment fallback.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const OWNER = 'a'.repeat(24), FOREIGN = 'b'.repeat(24);
const START = Date.UTC(2025, 0, 1), END = Date.UTC(2026, 0, 1);
const MONTHS = [0, 0, 0, 1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 10, 11, 11];
const LAYERS = ['everyday', 'irregular', 'emergency', 'major_goals', 'long_term_capital'];
const key = n => n.toString(16).padStart(24, '0');
const mutation = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function blueprint(index, owner = OWNER) {
  const dataset = index % 5 === 0 ? 'incomes' : 'expenses';
  const minor = 100 + (index * 7919 % 123456);
  const amount = Number(`${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`);
  let timestamp = Date.UTC(2025, MONTHS[index % MONTHS.length], 1 + (Math.floor(index / 16) % 27), 12);
  if (index === 0) timestamp = START;
  if (index === 1) timestamp = END - 1;
  if (index === 2 || index === 3) timestamp = Date.UTC(2025, 0, 15, 12); // equal dates, distinct createdAt
  const role = dataset === 'incomes' ? ['ordinary_income', 'loan_repayment', 'refund', 'internal_transfer', 'capital_movement'][Math.floor(index / 5) % 5]
    : index % 7 === 0 ? 'loan_issuance' : index % 7 === 1 ? 'internal_transfer' : index % 7 === 2 ? 'capital_movement' : 'ordinary_expense';
  const category = role === 'loan_issuance' ? 'Выдача займа' : ['Транспорт', 'Еда', 'Дом', 'Учёба', 'Здоровье', 'Прочее'][index % 6];
  const id = key((dataset === 'incomes' ? Math.floor(index / 5) + 1 : index + 1) + (owner === OWNER ? 0 : 0x100000));
  const facts = { owner, dataset, operationId: id, amount, date: new Date(timestamp),
    ...(dataset === 'expenses' ? { category, title: 'Fictional item', recipient: 'Fictional recipient' }
      : { source: role === 'loan_repayment' ? 'Возврат займа' : 'Fictional source' }),
    ...(index % 4 === 0 ? {} : { comment: index % 4 === 1 ? null : index % 4 === 2 ? '' : 'Fictional e\u0301' }) };
  const state = index % 11 === 0 ? 'unreviewed' : index % 11 === 1 ? 'explicit_unclassified' : index % 11 === 2 ? 'cleared' : 'approved';
  return { dataset, id, owner, minor, timestamp, role, category, facts, state,
    status: state === 'approved' && index % 11 === 3 ? 'stale' : state,
    assignment: { economicRole: role, layer: role === 'ordinary_expense' ? LAYERS[Math.floor(index / 5) % 5] : null } };
}
function reference(count) {
  // Independent integer-only oracle. Never calls a production money/statistics function.
  const totals = { expenses: 0n, incomes: 0n }, counts = { expenses: 0, incomes: 0 }, months = {}, categories = {}, statuses = {}, roles = {}, layers = {};
  const add = (obj, id, minor) => { const r = obj[id] ??= { minor: 0n, count: 0 }; r.minor += BigInt(minor); r.count++; };
  for (let i = 0; i < count; i++) {
    const b = blueprint(i); totals[b.dataset] += BigInt(b.minor); counts[b.dataset]++;
    add(months, `${new Date(b.timestamp).toISOString().slice(0, 7)}/${b.dataset}`, b.minor);
    add(statuses, `${b.dataset}/${b.status}`, b.minor);
    if (b.dataset === 'expenses') add(categories, b.category, b.minor);
    if (b.status === 'approved') { add(roles, `${b.dataset}/${b.role}`, b.minor); if (b.role === 'ordinary_expense') add(layers, b.assignment.layer, b.minor); }
  }
  return JSON.parse(JSON.stringify({ totals, counts, months, categories, statuses, roles, layers }, (_, v) => typeof v === 'bigint' ? Number(v) : v));
}
async function installFixture(h, count) {
  assert.equal([100, 1000, 10000, 50000].includes(count), true, 'Approved bounded fixture size required'); h.assertDatabase();
  const { CLASSIFICATION_MANIFEST: m } = require('../../dist/persistence/classificationManifest');
  const { fingerprintSourceOperation } = require('../../dist/domain/classification/sourceFingerprint');
  const { prepareClassificationDocument } = require('../../dist/persistence/classification');
  const db = h.mongoose.connection.db, oid = id => new h.mongoose.Types.ObjectId(id);
  h.performancePhase = 'manifest'; await db.createCollection(m.collectionName, m.options); await db.collection(m.collectionName).createIndex(m.index.key, m.index.options);
  await db.collection('users').insertMany([{ _id: oid(OWNER) }, { _id: oid(FOREIGN) }]);
  const sources = { expenses: [], incomes: [] }, decisions = [];
  h.performancePhase = 'blueprints';
  for (const [owner, size] of [[OWNER, count], [FOREIGN, Math.max(10, Math.floor(count / 10))]]) for (let i = 0; i < size; i++) {
    const b = blueprint(i, owner), { dataset, operationId, ...facts } = b.facts;
    sources[dataset].push({ ...facts, _id: oid(operationId), owner: oid(owner), createdAt: new Date(START + i), updatedAt: new Date(START + i) });
    if (b.state === 'unreviewed') continue;
    const oldFacts = { ...b.facts, ...(dataset === 'expenses' ? { title: 'Fictional older item' } : { source: 'Fictional older source' }) };
    const fingerprint = fingerprintSourceOperation(b.status === 'stale' ? oldFacts : b.facts, 1);
    assert.equal(fingerprint.ok, true, 'Fictional fingerprint must validate');
    const now = new Date(END + 1000);
    const doc = prepareClassificationDocument({ owner, dataset, operationId, state: b.state,
      ...(b.state === 'approved' ? { assignment: b.assignment } : {}), taxonomyVersion: 'financial-classification-v1', decisionOrigin: 'manual', decisionRevision: 1,
      ...fingerprint.value, sourceObservedAt: now, createdAt: now, updatedAt: now,
      lastMutation: { requestId: mutation(i + 1), commandFingerprint: 'c'.repeat(64), commandFingerprintVersion: 1 } });
    assert.equal(doc.ok, true, 'Fictional classification must validate');
    decisions.push({ ...doc.value, _id: oid(key(i + 1 + (owner === OWNER ? 0 : 0x100000))) });
  }
  for (const name of ['expenses', 'incomes']) {
    // Adjacent boundary records MUST NOT enter the selected 2025 cohort.
    for (const [offset, date] of [[1, new Date(START - 1)], [2, new Date(END)]]) {
      const b = blueprint(name === 'expenses' ? 1 : 0);
      const { dataset, operationId, ...facts } = b.facts;
      sources[name].push({ ...facts, _id: oid(key(0x200000 + offset)), owner: oid(OWNER), date });
    }
    h.performancePhase = 'sources'; await db.collection(name).insertMany(sources[name]);
  }
  h.performancePhase = 'decisions';
  for (let n = 0; n < decisions.length; n += 1000) await db.collection(m.collectionName).insertMany(decisions.slice(n, n + 1000));
  return { owner: OWNER, foreign: FOREIGN, count, reference: reference(count), period: { firstDate: '2025-01-01', lastDate: '2025-12-31', startInclusive: START, endExclusive: END } };
}
async function sourceDigest(h) {
  h.assertDatabase(); const digest = createHash('sha256');
  for (const name of ['expenses', 'incomes']) {
    digest.update(name);
    for await (const row of h.mongoose.connection.db.collection(name).find({}).sort({ _id: 1 })) digest.update(h.mongoose.mongo.BSON.serialize(row));
  }
  return digest.digest('hex'); // compare internally; never emit financial fingerprints
}
module.exports = { blueprint, reference, installFixture, sourceDigest, OWNER, FOREIGN, START, END };
