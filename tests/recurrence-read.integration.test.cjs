const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createHarness } = require('./helpers/mongodb-integration.cjs');

const a = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const b = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const token = owner => jwt.sign({ _id: owner, exp: 4102444800 }, 'super-secret-key');
const endpoint = '/analytics/recurrence?startMonth=2025-01&endMonthExclusive=2025-04';

describe('real MongoDB owner-scoped read-only recurrence API', { concurrency: false, timeout: 120000 }, () => {
  let h;
  const snapshots = async () => {
    const objects = await Promise.all(['expenses', 'incomes'].map(async kind =>
      (await h.models[kind].collection.find({}).sort({ _id: 1 }).toArray())
        .map(doc => h.mongoose.mongo.BSON.serialize(doc))));
    return objects;
  };
  const get = (owner = a, path = endpoint, credential = token(owner)) =>
    h.request('GET', path, undefined, credential);

  before(async () => { h = await createHarness(process.env); });
  beforeEach(async () => {
    h.assertDatabase();
    await h.models.expenses.deleteMany({});
    await h.models.incomes.deleteMany({});
    await h.models.expenses.insertMany([
      { owner: a, date: new Date('2025-01-01T00:00:00.000Z'), amount: 10, category: 'Food', title: 'Groceries', recipient: 'Shop' },
      { owner: a, date: new Date('2025-01-20T12:00:00.000Z'), amount: 12, category: 'Food', title: 'Groceries', recipient: 'Shop' },
      { owner: a, date: new Date('2025-02-01T00:00:00.000Z'), amount: 13, category: 'Food', title: 'Groceries', recipient: 'Shop' },
      { owner: b, date: new Date('2025-03-31T23:59:59.999Z'), amount: 90, category: 'Food', title: 'Groceries', recipient: 'Shop' },
      { owner: a, date: new Date('2025-04-01T00:00:00.000Z'), amount: 100, category: 'Outside', title: 'Later', recipient: 'Shop' },
    ]);
    await h.models.incomes.insertMany([
      { owner: a, date: new Date('2025-01-31T23:59:59.999Z'), amount: 100, source: 'Salary' },
      { owner: b, date: new Date('2025-03-01T00:00:00.000Z'), amount: 200, source: 'Salary' },
    ]);
  });
  after(async () => {
    if (!h) return;
    assert.deepEqual(await h.close(), { dropped: true, disconnected: true, listenerClosed: true,
      logsClosed: true, directoryRemoved: true, environmentRestored: true });
    console.info('Recurrence test-owned MongoDB dropped and resources closed.');
  });

  it('returns only owned evidence, counted by distinct UTC months, without amounts or classifications', async () => {
    const before = await snapshots();
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.body.version, 'observations-v0');
    assert.deepEqual(res.body.window, { startMonth: '2025-01', endMonthExclusive: '2025-04' });
    assert.equal(res.body.coverage.source, 'stored_records_only');
    assert.equal(res.body.coverage.historicalContinuity, 'unverified');
    assert.equal(res.body.coverage.atomicSnapshot, false);
    assert.equal(res.body.observations.length, 3);
    const category = res.body.observations.find(x => x.group.dataset === 'expenses'
      && x.group.level === 'category_or_source');
    assert.equal(category.group.identity.provenance, 'label_only');
    assert.equal(category.group.identity.value, 'Food');
    assert.equal(category.operationCount, 3);
    assert.equal(category.activeMonthCount, 2);
    assert.deepEqual(category.activeMonths, ['2025-01', '2025-02']);
    assert.deepEqual(category.intervalsInMonths, [1]);
    assert.equal(category.longestConsecutiveMonths, 2);
    const similar = res.body.observations.find(x => x.group.level === 'similar_expense');
    assert.equal(similar.operationCount, 3);
    assert.equal(similar.group.title, 'Groceries');
    const source = res.body.observations.find(x => x.group.dataset === 'incomes');
    assert.deepEqual(source.activeMonths, ['2025-01']);
    assert.equal(JSON.stringify(res.body).includes('"amount"'), false);
    assert.equal(JSON.stringify(res.body).includes('"layer"'), false);
    assert.deepEqual(await snapshots(), before);
  });
  it('isolates another owner even when category/source labels are identical', async () => {
    const res = await get(b);
    assert.equal(res.status, 200);
    assert.equal(res.body.observations.length, 3);
    for (const observed of res.body.observations) {
      assert.equal(observed.operationCount, 1);
      assert.deepEqual(observed.activeMonths, ['2025-03']);
    }
  });
  it('requires authentication and rejects invalid signing key', async () => {
    const before = await snapshots();
    const missing = await h.request('GET', endpoint);
    assert.equal(missing.status, 401);
    const invalid = await get(a, endpoint, jwt.sign({ _id: a }, 'wrong-secret'));
    assert.equal(invalid.status, 401);
    assert.deepEqual(await snapshots(), before);
  });
  it('rejects client owner/unknown query fields and missing ranges', async () => {
    const before = await snapshots();
    for (const path of [
      endpoint + '&owner=' + b,
      '/analytics/recurrence?startMonth=2025-01',
      '/analytics/recurrence?startMonth=2025-13&endMonthExclusive=2025-04',
    ]) {
      const res = await get(a, path);
      assert.equal(res.status, 400);
      assert.equal(res.body.message, 'Validation failed');
    }
    assert.deepEqual(await snapshots(), before);
  });
  it('rejects reversed, future, ongoing or more-than-12-month UTC windows', async () => {
    for (const [start, end] of [
      ['2025-05','2025-04'], ['2025-01','2026-02'], ['2099-01','2100-01'],
      ['2026-10','2026-11'],
    ]) {
      const res = await get(a, '/analytics/recurrence?startMonth=' + start + '&endMonthExclusive=' + end);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { message: 'Invalid completed UTC month range' });
    }
  });
  it('refuses oversized datasets instead of publishing partial observations', async () => {
    const before = await snapshots();
    const extra = Array.from({ length: 999 }, (_, i) => ({
      owner: a, date: new Date('2025-02-10T00:00:00.000Z'), amount: 1,
      category: 'Synthetic Load', title: 'Purchase' + i, recipient: 'Synthetic Shop',
    }));
    await h.models.expenses.insertMany(extra);
    const res = await get();
    assert.equal(res.status, 413);
    assert.deepEqual(res.body, { message: 'Recurrence history exceeds safe read limit' });
    const after = await snapshots();
    assert.equal(after[1].length, before[1].length);
    assert.equal(after[0].length, before[0].length + 999);
  });
  it('does not reinterpret excluded upper-bound operations as observations', async () => {
    const res = await get(a, '/analytics/recurrence?startMonth=2025-04&endMonthExclusive=2025-05');
    assert.equal(res.status, 200);
    assert.equal(res.body.observations.length, 2);
    assert.deepEqual(res.body.observations.map(x => x.activeMonths), [['2025-04'],['2025-04']]);
  });
});
