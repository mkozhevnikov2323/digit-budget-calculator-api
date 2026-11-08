const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const auth = require('../dist/middlewares/auth');
const errorHandler = require('../dist/errors/globalErrorHandler');
const { createClassificationRulesRouter } = require('../dist/routes/classificationRules');
const a = 'a'.repeat(24), b = 'b'.repeat(24);
const expense = (extra = {}) => ({ dataset: 'expenses', enabled: true, category: ' Еда ', economicRole: 'ordinary_expense', layer: 'emergency', ...extra });
const income = () => ({ dataset: 'incomes', enabled: true, source: ' Зарплата ', economicRole: 'ordinary_income', layer: null });
const copy = data => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(data));

describe('rule CRUD: actual JWT/router/Mongoose validation with stubbed driver, no MongoDB', { concurrency: false }, () => {
  let server, connection, rows, actor, indexes, present, catalogFails, lostAck, savedEnv;
  const forbidden = () => { throw new Error('Real database/DDL forbidden'); };
  const scoped = filter => assert.equal(filter.owner?.toHexString(), actor, 'Missing or incorrect owner scope');
  const selected = filter => { scoped(filter); return rows.filter(row => row.owner.equals(filter.owner) && (!filter._id || row._id.equals(filter._id))); };
  const duplicate = candidate => rows.some(row => !row._id.equals(candidate._id) && row.owner.equals(candidate.owner)
    && row.dataset === candidate.dataset && (row.dataset === 'expenses'
      ? row.category === candidate.category && (row.title ?? null) === (candidate.title ?? null) : row.source === candidate.source));
  const checkDuplicate = doc => { if (duplicate(doc)) throw new mongoose.mongo.MongoServerError({ code: 11000, message: 'Synthetic duplicate' }); };
  const driver = {
    listIndexes: () => ({ toArray: async () => indexes }),
    find: filter => ({ toArray: async () => selected(filter).map(copy) }),
    findOne: async filter => { const doc = selected(filter)[0]; return doc ? copy(doc) : null; },
    insertOne: async doc => {
      assert.equal(doc.owner.toHexString(), actor); checkDuplicate(doc); rows.push(copy(doc));
      if (lostAck) throw new Error('Synthetic lost acknowledgement');
      return { acknowledged: true, insertedId: doc._id };
    },
    updateOne: async (filter, update) => {
      const old = selected(filter)[0]; if (!old) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      const next = { ...old, ...update.$set }; for (const key of Object.keys(update.$unset ?? {})) delete next[key];
      checkDuplicate(next); rows[rows.indexOf(old)] = copy(next);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
    deleteOne: async filter => { const old = selected(filter)[0]; if (old) rows.splice(rows.indexOf(old), 1); return { acknowledged: true, deletedCount: old ? 1 : 0 }; },
  };
  const db = {
    listCollections: () => ({ toArray: async () => { if (catalogFails) throw new Error('Synthetic catalog outage'); return present ? [{ type: 'collection', options: {} }] : []; } }),
    collection: name => { assert.equal(name, 'classification_rules', 'Financial collections forbidden'); return driver; },
  };
  const request = (method, suffix = '', body, who = a, token) => new Promise((resolve, reject) => {
    actor = who;
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: '/classification-rules' + suffix,
      headers: { Connection: 'close', Authorization: 'Bearer ' + (token ?? jwt.sign({ _id: who }, 'super-secret-key', { expiresIn: '1h' })),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let raw = ''; res.on('data', chunk => raw += chunk); res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    }); req.on('error', reject); req.setTimeout(3000, () => req.destroy()); req.end(data);
  });
  before(async () => {
    savedEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
    for (const [target, method] of [[mongoose, 'connect'], [mongoose.Connection.prototype, 'openUri'],
      [mongoose.Connection.prototype, 'createCollection'], [mongoose.Model, 'createIndexes'], [mongoose.mongo.MongoClient.prototype, 'connect']]) mock.method(target, method, forbidden);
    connection = new mongoose.Mongoose().connection; connection.db = db; connection.readyState = 1;
    const app = express(); app.use(express.json()); app.use(auth);
    app.use('/classification-rules', createClassificationRulesRouter(connection)); app.use(errorHandler);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  });
  beforeEach(() => {
    rows = []; present = true; catalogFails = false; lostAck = false; connection.readyState = 1;
    indexes = connection.models.ClassificationRule.schema.indexes().map(([key, options]) => ({ key, ...structuredClone(options) }));
  });
  after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    mock.restoreAll(); if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
  });
  it('creates/lists/updates/toggles/deletes with canonical values and full document validation', async () => {
    const created = await request('POST', '', expense({ title: ' ХЛЕБ ' })); assert.equal(created.status, 201);
    const id = created.body._id; assert.equal(created.body.category, 'еда'); assert.equal(created.body.title, 'хлеб');
    assert.equal((await request('GET')).body.rules.length, 1);
    const updated = await request('PATCH', '/' + id, { enabled: false, layer: 'irregular', title: null });
    assert.equal(updated.status, 200); assert.equal(updated.body.enabled, false); assert.equal(updated.body.layer, 'irregular'); assert.equal(Object.hasOwn(updated.body, 'title'), false);
    assert.equal((await request('PATCH', '/' + id, { enabled: true })).body.enabled, true);
    const snapshot = JSON.stringify(rows);
    assert.equal((await request('PATCH', '/' + id, { economicRole: 'internal_transfer', layer: null })).status, 400);
    assert.equal(JSON.stringify(rows), snapshot);
    assert.equal((await request('DELETE', '/' + id)).status, 204); assert.equal(rows.length, 0);
    assert.equal((await request('POST', '', income())).status, 201);
  });
  it('isolates A/B list, patch and delete without exposing foreign records', async () => {
    const created = await request('POST', '', expense()); const before = JSON.stringify(rows);
    assert.deepEqual((await request('GET', '', undefined, b)).body.rules, []);
    assert.equal((await request('PATCH', '/' + created.body._id, { enabled: false }, b)).status, 404);
    assert.equal((await request('DELETE', '/' + created.body._id, undefined, b)).status, 404); assert.equal(JSON.stringify(rows), before);
    assert.equal((await request('POST', '', expense(), b)).status, 201); assert.equal(rows.length, 2);
  });
  it('rejects forged JWTs, unknown/server fields, malformed IDs, incompatible v2 fields and dataset changes', async () => {
    assert.equal((await request('GET', '', undefined, a, jwt.sign({ _id: a }, 'wrong-key'))).status, 401);
    for (const extra of [{ owner: b }, { _id: b }, { createdAt: new Date() }, { updatedAt: new Date() }, { extra: true },
      { economicRole: 'loan_issuance', layer: null }, { source: 'Salary' }, { category: ' ' }, { enabled: 'true' }]) assert.equal((await request('POST', '', expense(extra))).status, 400);
    assert.equal((await request('POST', '', { ...income(), category: 'Food' })).status, 400);
    const created = await request('POST', '', expense());
    for (const body of [{}, { owner: b }, { _id: b }, { updatedAt: new Date() }, { dataset: 'incomes' }, { layer: null }]) assert.equal((await request('PATCH', '/' + created.body._id, body)).status, 400);
    assert.equal((await request('DELETE', '/bad-id')).status, 400); assert.equal((await request('PATCH', '/bad-id', { enabled: true })).status, 400);
    assert.equal((await request('DELETE', '/' + '1'.repeat(24))).status, 404); assert.equal((await request('GET', '?owner=' + b)).status, 400);
  });
  it('maps driver duplicate failures on create and patch to 409, including untitled/disabled rules', async () => {
    assert.equal((await request('POST', '', expense())).status, 201);
    assert.equal((await request('POST', '', expense({ category: 'ЕДА', enabled: false }))).status, 409);
    const other = await request('POST', '', expense({ title: 'Хлеб' }));
    assert.equal((await request('PATCH', '/' + other.body._id, { title: null })).status, 409);
    assert.equal((await request('POST', '', income())).status, 201);
    assert.equal((await request('POST', '', { ...income(), source: 'ЗАРПЛАТА' })).status, 409);
  });
  it('refuses every mutation when required indexes/collection cannot be verified; permits read-only listing', async () => {
    const created = await request('POST', '', expense()), before = JSON.stringify(rows);
    const complete = structuredClone(indexes);
    for (const change of [() => { present = false; }, () => { indexes.pop(); }, () => { indexes[0].unique = false; },
      () => { indexes[0].sparse = true; }, () => { indexes[0].partialFilterExpression = {}; },
      () => { indexes[0].collation = { locale: 'en' }; }, () => { catalogFails = true; }]) {
      indexes = structuredClone(complete); present = true; catalogFails = false; change();
      for (const [method, path, body] of [['POST', '', expense({ title: 'New' })], ['PATCH', '/' + created.body._id, { enabled: false }], ['DELETE', '/' + created.body._id]]) assert.equal((await request(method, path, body)).status, 503);
      assert.equal(JSON.stringify(rows), before);
    }
    assert.equal((await request('GET')).status, 200);
  });
  it('returns 503 without buffering when disconnected and reports unknown for a lost save acknowledgement', async () => {
    connection.readyState = 0; assert.equal((await request('GET')).status, 503); assert.equal((await request('POST', '', expense())).status, 503); assert.equal(rows.length, 0);
    connection.readyState = 1; lostAck = true; const result = await request('POST', '', expense());
    assert.equal(result.status, 503); assert.equal(result.body.persistence, 'unknown'); assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(result.body).includes('Synthetic'), false);
  });
});
