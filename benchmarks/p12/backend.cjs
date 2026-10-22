// IPC-only performance fixture. All IO uses the existing generated-name MongoDB
// guard. No application bootstrap, production URI, raw errors or financial logs.
const assert = require('node:assert/strict');
const http = require('node:http');
const { mock } = require('node:test');
const { performance } = require('node:perf_hooks');
const { createHarness, testConfiguration } = require('../../tests/helpers/mongodb-integration.cjs');
const { installFixture, sourceDigest, START, END } = require('../../tests/helpers/performance-history.cjs');
let stage = 'guard';
let h, fixture, baseline, tracker, timer, metrics, cpu, heap, closing;
const send = m => { if (process.connected) process.send(m); };
const fresh = () => ({ http: { GET: 0, POST: 0, OPTIONS: 0, OTHER: 0 }, responseBytes: 0, active: 0, peakActive: 0, aborted: 0, httpDurations: [], mongo: {} });
const percentile = (a, p) => a.length ? [...a].sort((a, b) => a - b)[Math.max(0, Math.ceil(a.length * p) - 1)] : null;
async function start(count) {
  assert.equal(process.env.BUDGET_PERFORMANCE_TEST, '1'); assert.equal(typeof process.send, 'function'); testConfiguration(process.env);
  stage = 'harness'; h = await createHarness(process.env); stage = 'seed'; fixture = await installFixture(h, count); stage = 'bson'; baseline = await sourceDigest(h); stage = 'monitor';
  process.env.CLASSIFICATION_HISTORY_READ_ENABLED = '1';
  const client = h.mongoose.connection.getClient(); client.monitorCommands = true;
  const names = new Set(['expenses', 'incomes', 'users', 'operation_classifications']); const pending = new Map();
  client.on('commandStarted', e => {
    const collection = names.has(e.command[e.commandName]) ? e.command[e.commandName] : ['listCollections', 'listIndexes'].includes(e.commandName) ? 'metadata' : null;
    if (collection) pending.set(e.requestId, `${collection}/${e.commandName}`);
  });
  client.on('commandSucceeded', e => {
    const name = pending.get(e.requestId); pending.delete(e.requestId); if (!name || !metrics) return;
    const r = metrics.mongo[name] ??= { count: 0, milliseconds: 0, maxMilliseconds: 0 };
    r.count++; r.milliseconds += e.duration; r.maxMilliseconds = Math.max(r.maxMilliseconds, e.duration);
  });
  client.on('commandFailed', e => pending.delete(e.requestId));
  const original = http.Server.prototype.emit, port = Number(new URL(h.baseUrl).port);
  tracker = mock.method(http.Server.prototype, 'emit', function (event, ...args) {
    if (event === 'request' && this.address()?.port === port && metrics) {
      const [req, res] = args, start = performance.now(), target = metrics;
      const method = ['GET', 'POST', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER'; target.http[method]++;
      target.active++; target.peakActive = Math.max(target.peakActive, target.active); let ended = false;
      const finish = aborted => { if (ended) return; ended = true; target.active--; target.aborted += Number(aborted);
        const size = Number(res.getHeader('content-length')); if (Number.isSafeInteger(size) && size >= 0) target.responseBytes += size;
        target.httpDurations.push(performance.now() - start); };
      res.once('finish', () => finish(false)); res.once('close', () => finish(!res.writableFinished));
    }
    return Reflect.apply(original, this, [event, ...args]);
  });
  heap = process.memoryUsage().heapUsed; timer = setInterval(() => { heap = Math.max(heap, process.memoryUsage().heapUsed); }, 10);
  const bearer = require('jsonwebtoken').sign({ _id: fixture.owner, exp: 4102444800 }, 'super-secret-key');
  send({ type: 'ready', baseUrl: h.baseUrl, bearer, ...fixture, versions: { node: process.version, mongo: (await h.mongoose.connection.db.admin().command({ buildInfo: 1 })).version } });
}
function summarize() {
  return { http: metrics.http, responseBytes: metrics.responseBytes, peakActive: metrics.peakActive, aborted: metrics.aborted,
    httpLatencyMs: { p50: percentile(metrics.httpDurations, .5), p95: percentile(metrics.httpDurations, .95), max: Math.max(0, ...metrics.httpDurations) },
    mongo: metrics.mongo, sampledHeapPeakBytes: Math.max(heap, process.memoryUsage().heapUsed), cpuMicroseconds: process.cpuUsage(cpu), maxRSSKiB: process.resourceUsage().maxRSS };
}
const planStats = raw => {
  let stats; const stages = new Set();
  const visit = x => { if (!x || typeof x !== 'object') return; if (typeof x.totalDocsExamined === 'number' && !stats) stats = x;
    if (['COLLSCAN', 'IXSCAN', 'SORT', 'FETCH', 'COUNT_SCAN', 'SORT_MERGE', 'IDHACK', 'EXPRESS_IXSCAN'].includes(x.stage)) stages.add(x.stage);
    for (const [k, v] of Object.entries(x)) if (k !== 'rejectedPlans' && k !== 'allPlansExecution') { if (Array.isArray(v)) v.forEach(visit); else visit(v); } };
  visit(raw); return { docsExamined: stats?.totalDocsExamined ?? null, keysExamined: stats?.totalKeysExamined ?? null,
    returned: stats?.nReturned ?? null, executionTimeMillis: stats?.executionTimeMillis ?? null, stages: [...stages].sort() };
};
async function explain(indexed) {
  h.assertDatabase(); const db = h.mongoose.connection.db, owner = new h.mongoose.Types.ObjectId(fixture.owner), result = {};
  for (const name of ['expenses', 'incomes']) {
    const col = db.collection(name), filter = { owner, date: { $gte: new Date(START), $lte: new Date(END - 1) } };
    if (indexed) await col.createIndex({ owner: 1, date: 1, createdAt: 1 }, { name: 'p12_proposal_only' });
    const count = fixture.reference.counts[name];
    result[name] = { first: planStats(await col.find(filter).sort({ date: 1, createdAt: 1 }).limit(100).explain('executionStats')),
      deep: planStats(await col.find(filter).sort({ date: 1, createdAt: 1 }).skip(Math.max(0, count - 100)).limit(100).explain('executionStats')),
      count: planStats(await col.aggregate([{ $match: filter }, { $group: { _id: 1, n: { $sum: 1 } } }]).explain('executionStats')),
      indexes: (await col.listIndexes().toArray()).map(i => ({ name: i.name, key: i.key })),
      indexBytes: (await db.command({ collStats: name })).totalIndexSize };
    if (indexed) await col.dropIndex('p12_proposal_only');
  }
  const ids = Array.from({ length: Math.min(100, fixture.count) }, (_, i) => require('../../tests/helpers/performance-history.cjs').blueprint(i));
  const sample = ids.filter(x => x.dataset === 'expenses');
  result.sourceObservation = planStats(await db.collection('expenses').find({ owner, _id: { $in: sample.map(x => new h.mongoose.Types.ObjectId(x.id)) } },
    { projection: require('../../dist/services/classificationObservation').sourceProjection('expenses') }).limit(sample.length + 1).explain('executionStats'));
  result.decisions = planStats(await db.collection('operation_classifications').find({ owner, $or: ids.map(x => ({ dataset: x.dataset, operationId: new h.mongoose.Types.ObjectId(x.id) })) }).limit(ids.length + 1).explain('executionStats'));
  result.account = planStats(await db.collection('users').find({ _id: owner }, { projection: { _id: 1 } }).limit(1).explain('executionStats'));
  return result;
}
async function close() {
  if (closing) return closing;
  closing = (async () => { clearInterval(timer); tracker?.mock.restore();
    let unchanged = true; try { if (h) unchanged = (await sourceDigest(h)) === baseline; } finally {
      if (h) { const cleanup = await h.close(); assert.equal(cleanup.dropped, true); }
    }
    assert.equal(unchanged, true, 'Read benchmarks must not change financial BSON'); return { cleanupVerified: true, sourceBsonUnchanged: true };
  })(); return closing;
}
let queue = Promise.resolve();
process.on('message', m => {
  queue = queue.then(async () => {
    if (m.command === 'start') return start(m.count);
    stage = ['reset', 'stats', 'explain', 'close'].includes(m.command) ? m.command : 'invalid';
    if (m.command === 'reset') { metrics = fresh(); heap = process.memoryUsage().heapUsed; cpu = process.cpuUsage(); send({ type: 'reply', id: m.id, value: true }); }
    else if (m.command === 'stats') send({ type: 'reply', id: m.id, value: summarize() });
    else if (m.command === 'explain') send({ type: 'reply', id: m.id, value: await explain(m.indexed === true) });
    else if (m.command === 'close') { send({ type: 'reply', id: m.id, value: await close() }); process.disconnect(); }
    else throw Error('Unsupported performance command');
  }).catch(async error => { const kind = error?.code === 121 ? 'validator' : error?.code === 11000 ? 'duplicate' : error?.code === 'ERR_ASSERTION' ? 'assertion' : 'other'; send({ type: 'failure', code: 'PERFORMANCE_FIXTURE_UNAVAILABLE', stage: stage === 'seed' ? stage + '_' + h.performancePhase : stage, kind }); try { await close(); } finally { process.exitCode = 1; if (process.connected) process.disconnect(); } });
});
for (const event of ['SIGTERM', 'SIGINT', 'disconnect']) process.once(event, () => { close().catch(() => { process.exitCode = 1; }).finally(() => { if (process.connected) process.disconnect(); }); });
