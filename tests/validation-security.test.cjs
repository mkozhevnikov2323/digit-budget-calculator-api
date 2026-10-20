const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const mongoose = require('mongoose');
const winston = require('winston');
const jwt = require('jsonwebtoken');
const { createPersistence, owners, fixtures } = require('./helpers/financial-persistence.cjs');

const email = 'fictional-validation@example.com';
const password = 'synthetic-validation-password-marker';
const financialMarker = 'synthetic-validation-financial-marker';
const errorMarker = 'synthetic-validation-exception-marker';
// Same public development literal used by the existing isolated JWT contracts.
const token = jwt.sign({ _id: owners[0] }, 'super-secret-key', { noTimestamp: true });
const bodies = {
  incomes: { source: 'Fictional source', amount: 12.5, date: '2026-01-15T12:00:00.000Z', comment: financialMarker },
  expenses: { title: 'Fictional title', recipient: 'Fictional recipient', category: 'Fictional category',
    amount: 12.5, date: '2026-01-15T12:00:00.000Z', comment: financialMarker },
};

describe('validation security through compiled Express and real Celebrate', { concurrency: false, timeout: 20000 }, () => {
  const persistence = createPersistence();
  const guards = [];
  const loggers = [];
  const opened = [];
  const streams = [];
  const fileClosures = [];
  const ports = new Set();
  const userCalls = [];
  let app;
  let sandbox;
  let originalCwd;
  let savedEnv;
  let credentialError;
  const forbidden = () => { throw new Error('Real database and external network are forbidden in validation tests'); };

  before(async () => {
    originalCwd = process.cwd();
    savedEnv = Object.fromEntries(['NODE_ENV', 'JWT_SECRET', 'DEFAULT_ALLOWED_METHODS'].map(name => [name, process.env[name]]));
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-validation-security-'));
    process.chdir(sandbox); // Isolate dotenv and real File logging from application configuration.
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    process.env.DEFAULT_ALLOWED_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
    for (const [object, methods] of [
      [mongoose, ['connect', 'createConnection']], [mongoose.Connection.prototype, ['openUri']],
      [mongoose.mongo.MongoClient.prototype, ['connect']], [mongoose.Query.prototype, ['exec']],
      [mongoose.Aggregate.prototype, ['exec']], [mongoose.Model.prototype, ['save']],
      [mongoose.Model, ['find', 'findOne', 'findById', 'countDocuments', 'create', 'insertMany', 'bulkWrite',
        'findOneAndUpdate', 'findOneAndDelete', 'findByIdAndUpdate', 'findByIdAndDelete',
        'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'aggregate']],
      [globalThis, ['fetch']], [https, ['request', 'get']], [http, ['get']],
    ]) for (const method of methods) guards.push(mock.method(object, method, forbidden));
    const originalRequest = http.request;
    mock.method(http, 'request', function (options, ...args) {
      assert.ok(options.hostname === '127.0.0.1' && ports.has(options.port), 'Only an owned loopback listener is allowed');
      return Reflect.apply(originalRequest, this, [options, ...args]);
    });
    const createLogger = winston.createLogger;
    mock.method(winston, 'createLogger', function (...args) {
      const logger = Reflect.apply(createLogger, this, args);
      loggers.push(logger);
      for (const transport of logger.transports) opened.push(once(transport, 'open'));
      return logger;
    });
    const createWriteStream = fs.createWriteStream;
    mock.method(fs, 'createWriteStream', function (...args) {
      const stream = Reflect.apply(createWriteStream, this, args);
      streams.push(stream);
      fileClosures.push(once(stream, 'close'));
      return stream;
    });
    // Stub only persistence boundaries; keep actual routes, schemas, controllers,
    // bcrypt hashing, JWT signing/verification and error middleware unchanged.
    for (const [kind, filename] of [['expenses', 'expense'], ['incomes', 'income']]) {
      const Model = require(`../dist/models/${filename}.js`);
      for (const [method, implementation] of Object.entries(persistence.methods(kind))) mock.method(Model, method, implementation);
    }
    const User = require('../dist/models/user.js');
    mock.method(User, 'findUserByCredentials', async (actualEmail, actualPassword) => {
      // Boolean assertions prevent fictional credentials from appearing in TAP.
      assert.ok(actualEmail === email && actualPassword === password, 'Unexpected fictional credentials');
      userCalls.push('credentials');
      if (credentialError) throw credentialError;
      return { _id: owners[0], email };
    });
    mock.method(User, 'create', async payload => {
      assert.ok(payload.email === email && typeof payload.password === 'string' && payload.password !== password,
        'Signup must pass a hash to mocked persistence');
      assert.equal(/^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/.test(payload.password), true, 'Expected the existing bcrypt hash format');
      assert.deepEqual(Object.keys(payload).sort(), ['email', 'password']);
      userCalls.push('create');
      return { _id: owners[0], email };
    });
    mock.method(User, 'findByIdAndUpdate', async (id, payload, options) => {
      assert.equal(id, owners[0]);
      assert.deepEqual(payload, { email });
      assert.deepEqual(options, { new: true });
      userCalls.push('update');
      return { _id: id, email };
    });
    const importGuard = mock.method(net.Server.prototype, 'listen', forbidden);
    try { app = require('../dist/app.js'); } finally { importGuard.mock.restore(); }
    assert.equal(importGuard.mock.callCount(), 0);
    assert.equal(require.cache[require.resolve('../dist/server.js')], undefined);
    const listen = net.Server.prototype.listen;
    mock.method(net.Server.prototype, 'listen', function (port, host, ...args) {
      assert.equal(port, 0);
      assert.equal(host, '127.0.0.1');
      return Reflect.apply(listen, this, [port, host, ...args]);
    });
    await Promise.all(opened);
  });

  beforeEach(() => {
    persistence.reset();
    persistence.setActor(owners[0]);
    userCalls.length = 0;
    credentialError = undefined;
  });
  after(async () => {
    try {
      await Promise.all(opened);
      const closed = loggers.flatMap(logger => logger.transports.map(transport => once(transport, 'closed')));
      loggers.forEach(logger => logger.close());
      await Promise.all([...closed, ...fileClosures]);
      for (const stream of streams) assert.equal(stream.closed, true);
      // Read complete real files after flush/close, without printing their data
      // or markers if any assertion fails. B3g's full allowlist suite also runs.
      for (const filename of ['request.log', 'error.log']) {
        const text = fs.readFileSync(path.join(sandbox, filename), 'utf8');
        assert.ok(text.length > 0, 'Expected real operational log records');
        for (const marker of [email, password, financialMarker, errorMarker, token, 'syntheticPollution']) {
          assert.equal(text.includes(marker), false, 'Sensitive synthetic data reached File logging');
        }
      }
      for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
      assert.equal(mongoose.connection.readyState, 0);
      assert.equal(ports.size, 0);
      assert.equal(Object.hasOwn(Object.prototype, 'syntheticPollution'), false);
    } finally {
      mock.restoreAll();
      for (const name of ['NODE_ENV', 'JWT_SECRET', 'DEFAULT_ALLOWED_METHODS']) {
        if (savedEnv?.[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
      }
      if (originalCwd) process.chdir(originalCwd);
      if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  const request = async (method, endpoint, body, authorization = token, raw = false) => {
    const server = app.listen(0, '127.0.0.1');
    let port;
    try {
      await once(server, 'listening');
      port = server.address().port;
      ports.add(port);
      return await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, method, path: endpoint,
          headers: { Connection: 'close', 'Content-Type': 'application/json',
            ...(authorization === null ? {} : { Authorization: `Bearer ${authorization}` }) } }, res => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { text += chunk; });
          res.on('error', reject);
          res.on('end', () => {
            try { resolve({ status: res.statusCode, text, body: text ? JSON.parse(text) : undefined,
              contentType: res.headers['content-type'] }); } catch { reject(new Error('Expected a synthetic JSON response')); }
          });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('Owned validation HTTP request timed out')));
        req.end(body === undefined ? undefined : raw ? body : JSON.stringify(body));
      });
    } finally {
      try {
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        assert.equal(server.address(), null);
      } finally { ports.delete(port); }
    }
  };
  const assertUntouched = () => {
    assert.deepEqual(userCalls, []);
    assert.deepEqual(persistence.calls, []);
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
  };
  const assertValidation = (response, segment, key, message) => {
    assert.equal(response.status, 400);
    assert.match(response.contentType, /application\/json/);
    assert.deepEqual(response.body, { statusCode: 400, error: 'Bad Request', message: 'Validation failed',
      validation: { [segment]: { source: segment, keys: [key], message } } });
    assertUntouched();
  };

  for (const endpoint of ['/signin', '/signup']) {
    for (const [label, body, key, message] of [
      ['missing email', {}, 'email', '"email" is required'],
      ['missing password', { email }, 'password', '"password" is required'],
      ['non-string email', { email: 42, password }, 'email', '"email" must be a string'],
      ['empty email', { email: '', password }, 'email', '"email" is not allowed to be empty'],
      ['invalid email', { email: 'not-an-email', password }, 'email', '"email" must be a valid email'],
      ['nested email', { email: { value: email }, password }, 'email', '"email" must be a string'],
      ['non-string password', { email, password: 42 }, 'password', '"password" must be a string'],
      ['empty password', { email, password: '' }, 'password', '"password" is not allowed to be empty'],
      ['unknown field', { email, password, unexpected: true }, 'unexpected', '"unexpected" is not allowed'],
      ['constructor key', { email, password, constructor: { prototype: { syntheticPollution: true } } },
        'constructor', '"constructor" is not allowed'],
      ['prototype key', { email, password, prototype: { syntheticPollution: true } }, 'prototype', '"prototype" is not allowed'],
    ]) {
      it(`${endpoint}: preserves ${label} and exact 400 body`, async () => {
        assertValidation(await request('POST', endpoint, body, null), 'body', key, message);
      });
    }
    it(`${endpoint}: raw __proto__ fixture does not bypass required fields or pollute globals`, async () => {
      const body = JSON.stringify({ email }).slice(0, -1) + ',"__proto__":{"syntheticPollution":true}}';
      assertValidation(await request('POST', endpoint, body, null, true), 'body', 'password', '"password" is required');
      assert.equal(Object.hasOwn(Object.prototype, 'syntheticPollution'), false);
    });
  }
  it('preserves sign-in minimum length without printing the submitted password', async () => {
    assertValidation(await request('POST', '/signin', { email, password: 'short' }, null),
      'body', 'password', '"password" length must be at least 8 characters long');
  });
  it('valid sign-in reaches only mocked credential lookup and real JWT signing', async () => {
    const response = await request('POST', '/signin', { email, password }, null);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body), ['token']);
    assert.ok(typeof response.body.token === 'string', 'Expected a synthetic token');
    const claims = jwt.verify(response.body.token, 'super-secret-key');
    assert.equal(claims._id, owners[0]);
    assert.equal(claims.exp - claims.iat, 7 * 24 * 60 * 60);
    assert.deepEqual(userCalls, ['credentials']);
  });
  for (const [label, value] of [['ordinary', password], ['one-character (existing signup policy)', 'x']]) {
    it(`valid ${label} signup keeps 201 and hashes before mocked persistence`, async () => {
      const response = await request('POST', '/signup', { email, password: value }, null);
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, { _id: owners[0], email });
      assert.deepEqual(userCalls, ['create']);
    });
  }
  for (const [label, body, key, message] of [
    ['required', {}, 'email', '"email" is required'],
    ['invalid email', { email: 'invalid' }, 'email', '"email" must be a valid email'],
    ['unknown field', { email, owner: owners[1] }, 'owner', '"owner" is not allowed'],
  ]) {
    it(`protected user email: ${label} preserves exact 400`, async () => {
      assertValidation(await request('PATCH', '/users/me', body), 'body', key, message);
    });
  }
  it('valid protected user email reaches only the authenticated mocked update', async () => {
    const response = await request('PATCH', '/users/me', { email });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { _id: owners[0], email });
    assert.deepEqual(userCalls, ['update']);
  });

  for (const kind of ['incomes', 'expenses']) {
    for (const [label, changes, key, message] of [
      ['required amount', { amount: undefined }, 'amount', '"amount" is required'],
      ['negative amount', { amount: -0.01 }, 'amount', '"amount" must be greater than or equal to 0'],
      ['empty amount', { amount: '' }, 'amount', '"amount" must be a number'],
      ['nonnumeric amount', { amount: 'not-a-number' }, 'amount', '"amount" must be a number'],
      ['null amount', { amount: null }, 'amount', '"amount" must be a number'],
      ['nested amount', { amount: { $gt: 0 } }, 'amount', '"amount" must be a number'],
      ['unsafe amount', { amount: Number.MAX_SAFE_INTEGER + 1 }, 'amount', '"amount" must be a safe number'],
      ['required date', { date: undefined }, 'date', '"date" is required'],
      ['invalid date', { date: 'not-a-date' }, 'date', '"date" must be a valid date'],
      ['nested comment', { comment: { value: financialMarker } }, 'comment', '"comment" must be a string'],
      ['unexpected owner', { owner: owners[1] }, 'owner', '"owner" is not allowed'],
    ]) {
      it(`${kind}: ${label} preserves exact body validation before persistence`, async () => {
        assertValidation(await request('POST', `/${kind}`, { ...bodies[kind], ...changes }), 'body', key, message);
      });
    }
    for (const [label, changes, amount, date] of [
      ['zero', { amount: 0 }, 0, '2026-01-15T12:00:00.000Z'],
      ['decimal string coercion', { amount: '12.50' }, 12.5, '2026-01-15T12:00:00.000Z'],
      ['maximum safe integer', { amount: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER, '2026-01-15T12:00:00.000Z'],
      ['ISO offset', { date: '2026-01-15T12:00:00+03:00' }, 12.5, '2026-01-15T09:00:00.000Z'],
      ['ISO date only', { date: '2026-01-15' }, 12.5, '2026-01-15T00:00:00.000Z'],
      ['existing non-ISO body date', { date: '01/15/2026' }, 12.5, '2026-01-15T00:00:00.000Z'],
      ['epoch date coercion', { date: 0 }, 12.5, '1970-01-01T00:00:00.000Z'],
    ]) {
      it(`${kind}: ${label} preserves coercion passed to scoped mocked persistence`, async () => {
        const response = await request('POST', `/${kind}`, { ...bodies[kind], ...changes });
        assert.equal(response.status, 201);
        assert.equal(response.text, '');
        assert.deepEqual(persistence.calls, [{ model: kind, method: 'create', args: [
          { ...bodies[kind], ...changes, amount, date: new Date(date), owner: owners[0] },
        ] }]);
      });
    }
    for (const [query, key, message] of [
      ['startDate=not-a-date', 'startDate', '"startDate" must be in ISO 8601 date format'],
      ['startDate=01%2F15%2F2026', 'startDate', '"startDate" must be in ISO 8601 date format'],
      ['month=0', 'month', '"month" must be greater than or equal to 1'],
      ['month=13', 'month', '"month" must be less than or equal to 12'],
      ['month=1.5', 'month', '"month" must be an integer'],
      ['limit=101', 'limit', '"limit" must be less than or equal to 100'],
      ['owner=fictional', 'owner', '"owner" is not allowed'],
    ]) {
      it(`${kind}: query ${key} rejects ${query} with exact ISO/numeric/unknown contract`, async () => {
        assertValidation(await request('GET', `/${kind}?${query}`), 'query', key, message);
      });
    }
    it(`${kind}: ISO query coercion keeps owner-scoped date filtering`, async () => {
      const query = new URLSearchParams({ startDate: '2026-01-01', endDate: '2026-01-31T23:59:59Z', noPagination: 'true' });
      const response = await request('GET', `/${kind}?${query}`);
      assert.equal(response.status, 200);
      assert.deepEqual(persistence.calls[0].args, [{ owner: owners[0], date: {
        $gte: new Date('2026-01-01T00:00:00Z'), $lte: new Date('2026-01-31T23:59:59Z'),
      } }]);
      assert.equal(response.body.total, 2);
      assert.ok(response.body[kind].every(row => row.owner === owners[0]));
    });
    it(`${kind}: invalid params precede invalid body and retain the exact key/message`, async () => {
      assertValidation(await request('PATCH', `/${kind}/not-hex`, { amount: -1 }), 'params', 'id',
        '"id" must only contain hexadecimal characters');
    });
    it(`${kind}: missing and invalid authentication precede body validation`, async () => {
      for (const [authorization, message] of [[null, 'Необходима авторизация.'], ['fictional-invalid-jwt', 'Необходима авторизация!']]) {
        const response = await request('POST', `/${kind}`, { amount: -1 }, authorization);
        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message });
        assertUntouched();
      }
    });
    it(`${kind}: valid input cannot update another owner's record and keeps 404`, async () => {
      const target = fixtures(kind).find(row => row.owner === owners[1]);
      const response = await request('PATCH', `/${kind}/${target._id}`, bodies[kind]);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: kind === 'expenses' ? 'Расход не найден' : 'Доход не найден' });
      assert.deepEqual(persistence.calls[0].args[0], { _id: target._id, owner: owners[0] });
    });
  }
  it('malformed raw JSON stays a parser 400 before authentication, not a Celebrate error', async () => {
    const response = await request('POST', '/incomes', `{"password":"${password}","amount":`, null, true);
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(response.body), ['message']);
    assert.equal(/JSON/i.test(response.body.message), true);
    assertUntouched();
  });
  it('non-Celebrate controller errors still delegate to the global 500 and safe File logger', async () => {
    credentialError = Object.assign(new Error(errorMarker), { body: password, financial: financialMarker });
    const response = await request('POST', '/signin', { email, password }, null);
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { message: 'На сервере произошла ошибка' });
    assert.deepEqual(userCalls, ['credentials']);
    assert.deepEqual(persistence.calls, []);
  });
});
