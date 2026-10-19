const { describe, it, before, after, beforeEach, mock } = require('node:test');
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

// Existing public development literal; no production credentials or login calls.
const tokens = Object.fromEntries(owners.map(owner => [owner,
  jwt.sign({ _id: owner }, 'super-secret-key', { noTimestamp: true }),
]));
const invalidToken = jwt.sign({ _id: owners[0] }, 'synthetic-wrong-owner-test-key', { noTimestamp: true });
const wire = value => JSON.parse(JSON.stringify(value));
const bodies = {
  expenses: { amount: 23.45, date: '2026-01-15T12:00:00.000Z', title: 'Synthetic title',
    recipient: 'Synthetic recipient', category: 'Synthetic category', comment: 'Synthetic create' },
  incomes: { amount: 67.89, date: '2026-01-15T12:00:00.000Z', source: 'Synthetic source', comment: 'Synthetic create' },
};
const parsed = body => ({ ...body, date: new Date(body.date) });
const messages = {
  expenses: { missing: 'Расход не найден', deleted: 'Расход успешно удалён' },
  incomes: { missing: 'Доход не найден', deleted: 'Доход успешно удалён' },
};

describe('financial ownership through the real compiled Express app', { concurrency: false, timeout: 20000 }, () => {
  const persistence = createPersistence();
  const guards = [];
  const loggers = [];
  const opened = [];
  const streams = [];
  const fileClosures = [];
  const activePorts = new Set();
  let app;
  let sandbox;
  let originalCwd;
  let savedEnv;
  let importListenerGuard;
  const forbidden = () => { throw new Error('Real database or external network access forbidden in ownership contracts'); };

  before(async () => {
    originalCwd = process.cwd();
    savedEnv = Object.fromEntries(['NODE_ENV', 'JWT_SECRET', 'DEFAULT_ALLOWED_METHODS'].map(name => [name, process.env[name]]));
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-financial-ownership-'));
    process.chdir(sandbox);
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    process.env.DEFAULT_ALLOWED_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';

    for (const [object, methods] of [
      [mongoose, ['connect', 'createConnection']],
      [mongoose.Connection.prototype, ['openUri']],
      [mongoose.mongo.MongoClient.prototype, ['connect']],
      [mongoose.Query.prototype, ['exec']], [mongoose.Aggregate.prototype, ['exec']],
      [mongoose.Model, ['find', 'findOne', 'findById', 'countDocuments', 'create', 'insertMany', 'bulkWrite',
        'findOneAndUpdate', 'findOneAndDelete', 'findByIdAndUpdate', 'findByIdAndDelete',
        'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'aggregate']],
      [mongoose.Model.prototype, ['save']], [globalThis, ['fetch']],
      [https, ['request', 'get']], [http, ['get']],
    ]) for (const method of methods) guards.push(mock.method(object, method, forbidden));

    // The only permitted requests are to a test listener already bound below.
    const request = http.request;
    mock.method(http, 'request', function (options, ...args) {
      assert.ok(options.hostname === '127.0.0.1' && activePorts.has(options.port), 'Only owned loopback listeners are permitted');
      return Reflect.apply(request, this, [options, ...args]);
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
    importListenerGuard = mock.method(net.Server.prototype, 'listen', forbidden);
    try {
      for (const [kind, filename] of [['expenses', 'expense'], ['incomes', 'income']]) {
        const Model = require(`../dist/models/${filename}.js`);
        for (const [method, implementation] of Object.entries(persistence.methods(kind))) {
          mock.method(Model, method, implementation);
        }
      }
      app = require('../dist/app.js');
    } finally { importListenerGuard.mock.restore(); }
    const listen = net.Server.prototype.listen;
    mock.method(net.Server.prototype, 'listen', function (port, host, ...args) {
      assert.equal(port, 0);
      assert.equal(host, '127.0.0.1');
      return Reflect.apply(listen, this, [port, host, ...args]);
    });
    await Promise.all(opened);
  });

  beforeEach(() => persistence.reset());
  after(async () => {
    try {
      await Promise.all(opened);
      const closed = loggers.flatMap(logger => logger.transports.map(transport => once(transport, 'closed')));
      loggers.forEach(logger => logger.close());
      await Promise.all(closed);
      await Promise.all(fileClosures);
      for (const stream of streams) assert.equal(stream.closed, true);
      for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
      assert.equal(mongoose.connection.readyState, 0);
      assert.equal(activePorts.size, 0);
    } finally {
      mock.restoreAll();
      for (const name of ['NODE_ENV', 'JWT_SECRET', 'DEFAULT_ALLOWED_METHODS']) {
        if (savedEnv?.[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
      }
      if (originalCwd) process.chdir(originalCwd);
      if (sandbox) {
        fs.rmSync(sandbox, { recursive: true, force: true });
        assert.equal(fs.existsSync(sandbox), false);
      }
    }
  });

  const request = async (owner, method, endpoint, body, token = tokens[owner]) => {
    const server = app.listen(0, '127.0.0.1');
    let port;
    persistence.setActor(owner);
    try {
      await once(server, 'listening');
      assert.equal(server.address().address, '127.0.0.1');
      port = server.address().port;
      activePorts.add(port);
      return await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, method, path: endpoint,
          headers: { Connection: 'close', 'Content-Type': 'application/json',
            ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) } }, res => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { text += chunk; });
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, text, body: text ? JSON.parse(text) : undefined,
                contentType: res.headers['content-type'] });
            } catch (error) { reject(error); }
          });
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    } finally {
      try {
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        assert.equal(server.listening, false);
        assert.equal(server.address(), null);
      } finally {
        activePorts.delete(port);
        persistence.setActor(undefined);
      }
    }
  };
  const assertJSON = (response, status, body) => {
    assert.equal(response.status, status);
    assert.match(response.contentType, /application\/json/);
    assert.deepEqual(response.body, wire(body));
  };
  const assertValidation = (response, segment, key) => {
    assert.equal(response.status, 400);
    assert.equal(response.body.statusCode, 400);
    assert.equal(response.body.error, 'Bad Request');
    assert.equal(response.body.message, 'Validation failed');
    assert.equal(response.body.validation[segment].source, segment);
    assert.deepEqual(response.body.validation[segment].keys, [key]);
  };
  const assertRead = (kind, owner, filter, expectedRows, { paginated = false, page = 1, limit = expectedRows.length, total = expectedRows.length } = {}) => {
    const expectedChain = [['sort', { date: 1, createdAt: 1 }]];
    if (paginated) expectedChain.push(['skip', (page - 1) * limit], ['limit', limit]);
    if (kind === 'incomes') expectedChain.push(['lean']);
    assert.deepEqual(persistence.calls, [
      ...(paginated ? [{ model: kind, method: 'countDocuments', args: [filter] }] : []),
      { model: kind, method: 'find', args: [filter], chain: expectedChain },
    ]);
    for (const row of expectedRows) assert.equal(row.owner, owner);
    return { total, page, limit, [kind]: expectedRows };
  };

  it('imports real compiled routes/controllers without bootstrap, DB or import-time listener', () => {
    assert.equal(typeof app, 'function');
    assert.equal(importListenerGuard.mock.callCount(), 0);
    assert.equal(require.cache[require.resolve('../dist/server.js')], undefined);
    for (const filename of ['expenses', 'incomes']) {
      assert.ok(require.cache[require.resolve(`../dist/controllers/${filename}.js`)]);
      assert.ok(require.cache[require.resolve(`../dist/routes/${filename}.js`)]);
    }
  });

  for (const kind of ['expenses', 'incomes']) {
    describe(kind, { concurrency: false }, () => {
      it('rejects missing JWT on all CRUD endpoints before any financial operation', async () => {
        for (const [method, endpoint, body] of [
          ['GET', `/${kind}`], ['POST', `/${kind}`, bodies[kind]],
          ['PATCH', `/${kind}/${fixtures(kind)[0]._id}`, bodies[kind]],
          ['DELETE', `/${kind}/${fixtures(kind)[0]._id}`],
        ]) {
          assertJSON(await request(undefined, method, endpoint, body), 401, { message: 'Необходима авторизация.' });
          assert.deepEqual(persistence.calls, []);
        }
      });

      it('rejects malformed and incorrectly signed JWTs before financial operations', async () => {
        for (const token of ['synthetic-malformed-jwt', invalidToken]) {
          for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
            const endpoint = `/${kind}${['PATCH', 'DELETE'].includes(method) ? `/${fixtures(kind)[0]._id}` : ''}`;
            const body = ['POST', 'PATCH'].includes(method) ? bodies[kind] : undefined;
            assertJSON(await request(owners[0], method, endpoint, body, token), 401, { message: 'Необходима авторизация!' });
            assert.deepEqual(persistence.calls, []);
          }
        }
      });

      for (const [index, owner] of owners.entries()) {
        const label = index === 0 ? 'A' : 'B';
        const ownRows = fixtures(kind).filter(row => row.owner === owner);
        const other = owners[1 - index];

        it(`${label}: paginated read scopes find/count and returns only this owner's page`, async () => {
          const response = await request(owner, 'GET', `/${kind}?page=2&limit=1`);
          const expected = assertRead(kind, owner, { owner }, [ownRows[1]], { paginated: true, page: 2, limit: 1, total: 3 });
          assertJSON(response, 200, expected);
        });

        it(`${label}: noPagination scopes find, keeps the actual query chain and omits count`, async () => {
          const response = await request(owner, 'GET', `/${kind}?noPagination=true`);
          assertJSON(response, 200, assertRead(kind, owner, { owner }, ownRows));
        });

        it(`${label}: date and category/source filters cannot replace owner filtering`, async () => {
          const range = { startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-31T23:59:59.000Z' };
          const extra = kind === 'expenses' ? { category: 'Synthetic Food', title: 'grocer', recipient: 'shop' } : { source: 'salary' };
          const query = new URLSearchParams({ ...range, ...extra, page: '1', limit: '20' });
          const filter = { owner, date: { $gte: new Date(range.startDate), $lte: new Date(range.endDate) },
            ...(kind === 'expenses' ? { category: extra.category, title: { $regex: extra.title, $options: 'i' },
              recipient: { $regex: extra.recipient, $options: 'i' } } : { source: { $regex: extra.source, $options: 'i' } }) };
          const response = await request(owner, 'GET', `/${kind}?${query}`);
          assertJSON(response, 200, assertRead(kind, owner, filter, [ownRows[0]], { paginated: true, limit: 20 }));
        });

        it(`${label}: creation uses the token owner and preserves the validated payload/201 empty response`, async () => {
          const before = persistence.records(kind);
          const response = await request(owner, 'POST', `/${kind}`, bodies[kind]);
          assert.equal(response.status, 201);
          assert.equal(response.text, '');
          assert.deepEqual(persistence.calls, [{ model: kind, method: 'create', args: [{ ...parsed(bodies[kind]), owner }] }]);
          const after = persistence.records(kind);
          assert.deepEqual(after.slice(0, -1), before);
          const { _id, ...created } = after.at(-1);
          assert.match(_id, /^[a-f0-9]{24}$/);
          assert.deepEqual(created, { ...parsed(bodies[kind]), owner });
        });

        it(`${label}: same-owner update requires ID/owner and preserves payload/options/200`, async () => {
          const before = persistence.records(kind);
          const body = { ...bodies[kind], amount: 45.67, comment: 'Synthetic update' };
          const response = await request(owner, 'PATCH', `/${kind}/${ownRows[0]._id}`, body);
          assert.deepEqual(persistence.calls, [{ model: kind, method: 'findOneAndUpdate', args: [
            { _id: ownRows[0]._id, owner }, parsed(body), { new: true, runValidators: true },
          ] }]);
          assertJSON(response, 200, { ...ownRows[0], ...parsed(body) });
          assert.deepEqual(persistence.records(kind).filter(row => row._id !== ownRows[0]._id),
            before.filter(row => row._id !== ownRows[0]._id));
        });

        it(`${label}: same-owner deletion requires ID/owner and preserves the success response`, async () => {
          const before = persistence.records(kind);
          const response = await request(owner, 'DELETE', `/${kind}/${ownRows[0]._id}`);
          assertJSON(response, 200, { message: messages[kind].deleted });
          assert.deepEqual(persistence.calls, [{ model: kind, method: 'findOneAndDelete', args: [{ _id: ownRows[0]._id, owner }] }]);
          assert.deepEqual(persistence.records(kind), before.filter(row => row._id !== ownRows[0]._id));
        });

        for (const [method, modelMethod] of [['PATCH', 'findOneAndUpdate'], ['DELETE', 'findOneAndDelete']]) {
          it(`${label}: ${method} cannot mutate the other owner's record and returns the existing 404`, async () => {
            const before = persistence.records(kind);
            const target = before.find(row => row.owner === other);
            const response = await request(owner, method, `/${kind}/${target._id}`, method === 'PATCH' ? bodies[kind] : undefined);
            assertJSON(response, 404, { message: messages[kind].missing });
            assert.deepEqual(persistence.calls, [{ model: kind, method: modelMethod, args: [
              { _id: target._id, owner }, ...(method === 'PATCH' ? [parsed(bodies[kind]), { new: true, runValidators: true }] : []),
            ] }]);
            assert.deepEqual(persistence.records(kind), before);
          });
        }
      }

      it('alternating A/B/A/B requests derive owner from each JWT with no response leakage', async () => {
        for (const owner of [owners[0], owners[1], owners[0], owners[1]]) {
          persistence.calls.length = 0;
          const response = await request(owner, 'GET', `/${kind}?noPagination=true`);
          const ownRows = fixtures(kind).filter(row => row.owner === owner);
          assertJSON(response, 200, assertRead(kind, owner, { owner }, ownRows));
        }
      });

      it('month/year and year-only read branches retain the verified owner', async () => {
        for (const owner of owners) for (const [query, date, expected] of [
          ['month=1&year=2026', { $gte: new Date(2026, 0, 1), $lt: new Date(2026, 1, 1) }, 2],
          ['year=2026', { $gte: new Date(2026, 0, 1), $lt: new Date(2027, 0, 1) }, 3],
        ]) {
          persistence.calls.length = 0;
          const response = await request(owner, 'GET', `/${kind}?noPagination=true&${query}`);
          const ownRows = fixtures(kind).filter(row => row.owner === owner).slice(0, expected);
          assertJSON(response, 200, assertRead(kind, owner, { owner, date }, ownRows));
        }
      });

      it('missing IDs keep scoped update/delete and the existing 404 without mutation', async () => {
        const before = persistence.records(kind);
        const id = 'eeeeeeeeeeeeeeeeeeeeeeee';
        for (const method of ['PATCH', 'DELETE']) {
          persistence.calls.length = 0;
          const response = await request(owners[0], method, `/${kind}/${id}`, method === 'PATCH' ? bodies[kind] : undefined);
          assertJSON(response, 404, { message: messages[kind].missing });
          assert.equal(persistence.calls.length, 1);
          assert.deepEqual(persistence.calls[0].args[0], { _id: id, owner: owners[0] });
          assert.deepEqual(persistence.records(kind), before);
        }
      });

      it('Celebrate rejects malformed IDs before any financial persistence call', async () => {
        for (const method of ['PATCH', 'DELETE']) {
          const response = await request(owners[0], method, `/${kind}/not-an-object-id`, method === 'PATCH' ? bodies[kind] : undefined);
          assertValidation(response, 'params', 'id');
          assert.deepEqual(persistence.calls, []);
        }
      });

      it('Celebrate rejects client-supplied owner fields instead of allowing ownership assignment', async () => {
        for (const owner of owners) {
          const foreign = owners.find(value => value !== owner);
          for (const method of ['POST', 'PATCH', 'GET']) {
            const endpoint = method === 'GET' ? `/${kind}?owner=${foreign}` :
              `/${kind}${method === 'PATCH' ? `/${fixtures(kind).find(row => row.owner === owner)._id}` : ''}`;
            const response = await request(owner, method, endpoint, method === 'GET' ? undefined : { ...bodies[kind], owner: foreign });
            assertValidation(response, method === 'GET' ? 'query' : 'body', 'owner');
            assert.deepEqual(persistence.calls, []);
          }
        }
      });
    });
  }
});
