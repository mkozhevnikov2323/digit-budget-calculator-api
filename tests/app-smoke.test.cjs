const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const mongoose = require('mongoose');
const winston = require('winston');
const proxyaddr = require('proxy-addr');

describe('Mongoose filter sanitization (no database)', { timeout: 1000 }, () => {
  for (const operator of ['$and', '$or', '$nor']) {
    it(`sanitizes bounded selectors inside ${operator} without global options`, () => {
      const filter = { [operator]: [{ amount: { $gt: 0 } }, { owner: { $ne: null } }] };
      const result = mongoose.sanitizeFilter(filter);
      assert.deepEqual(result, { [operator]: [
        { amount: { $eq: { $gt: 0 } } }, { owner: { $eq: { $ne: null } } },
      ] });
      // Calling the public helper must not enable sanitization on app queries.
      assert.equal(mongoose.get('sanitizeFilter'), undefined);
    });
  }
  it('sanitizes nested $nor and preserves an existing equality selector', () => {
    const filter = { $and: [{ $nor: [{ comment: { $regex: '^fictional$' } }] }], amount: { $eq: 1 } };
    assert.deepEqual(mongoose.sanitizeFilter(filter), {
      $and: [{ $nor: [{ comment: { $eq: { $regex: '^fictional$' } } }] }], amount: { $eq: 1 },
    });
  });
});

describe('proxy subnet security (synthetic addresses, no sockets)', { timeout: 1000 }, () => {
  // Exercise both public compile forms: one range and multiple ranges. The
  // unrelated documentation range must not mask a false match in the target.
  for (const [label, ranges] of [
    ['single subnet', subnet => subnet],
    ['multiple subnets', subnet => ['2001:db8:ffff::/48', subnet]],
  ]) {
    for (const subnet of ['::ffff:10.0.0.0/8', '::ffff:10.0.0.0/95', '::/1', '::/32', '::/80', '::/96']) {
      it(`${label}: ${subnet} must not trust IPv4 or mapped IPv4 peers`, () => {
        const trust = proxyaddr.compile(ranges(subnet));
        for (const peer of ['10.1.2.3', '198.51.100.23', '::ffff:10.1.2.3', '::ffff:198.51.100.23']) {
          assert.equal(trust(peer), false);
          const req = { socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': '203.0.113.9' } };
          assert.equal(proxyaddr(req, trust), peer);
          assert.deepEqual(proxyaddr.all(req, trust), [peer]);
        }
      });
    }

    for (const subnet of ['::ffff:10.0.0.0/104', '10.0.0.0/8']) {
      it(`${label}: ${subnet} trusts only the intended IPv4 range`, () => {
        const trust = proxyaddr.compile(ranges(subnet));
        for (const peer of ['10.0.0.0', '10.1.2.3', '10.255.255.255']) {
          assert.equal(trust(peer), true);
          assert.equal(trust(`::ffff:${peer}`), true);
        }
        for (const peer of ['9.255.255.255', '11.0.0.0', '198.51.100.23']) {
          assert.equal(trust(peer), false);
          assert.equal(trust(`::ffff:${peer}`), false);
        }
        assert.equal(trust('2001:db8:1::1'), false);
        // A legitimate proxy remains usable, but processing stops at the first
        // untrusted hop rather than accepting the client's leftmost header.
        const req = { socket: { remoteAddress: '::ffff:10.1.2.3' },
          headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.23' } };
        assert.equal(proxyaddr(req, trust), '198.51.100.23');
        assert.deepEqual(proxyaddr.all(req, trust), ['::ffff:10.1.2.3', '198.51.100.23']);
      });
    }

    it(`${label}: /96 covers the mapped marker but excludes native IPv6`, () => {
      const trust = proxyaddr.compile(ranges('::ffff:0.0.0.0/96'));
      assert.equal(trust('198.51.100.23'), true);
      assert.equal(trust('::ffff:198.51.100.23'), true);
      assert.equal(trust('::1'), false);
      assert.equal(trust('2001:db8:1::1'), false);
    });

    it(`${label}: native IPv6 zero-leading-bit ranges retain IPv6 matching`, () => {
      const trust = proxyaddr.compile(ranges('::/1'));
      assert.equal(trust('::1'), true);
      assert.equal(trust('2001:db8:1::1'), true);
      assert.equal(trust('8000::1'), false);
    });
  }
});

describe('isolated Express app (no server bootstrap or database)', { concurrency: false, timeout: 15000 }, () => {
  let app;
  let sandbox;
  let originalCwd;
  let originalMethods;
  let importListenerGuard;
  const forbiddenCalls = [];
  const loggers = [];
  const openedTransports = [];
  const forbidden = () => { throw new Error('Database and external transport forbidden in smoke tests'); };

  before(() => {
    // The Node test runner isolates this file in a child process. A temporary
    // cwd isolates the existing file loggers and controllers/users.js dotenv
    // call from the developer's real logs/.env. No router/middleware is mocked.
    originalCwd = process.cwd();
    originalMethods = process.env.DEFAULT_ALLOWED_METHODS;
    sandbox = mkdtempSync(path.join(tmpdir(), 'budget-app-smoke-'));
    process.chdir(sandbox);
    process.env.DEFAULT_ALLOWED_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';

    for (const [object, method] of [
      [mongoose, 'connect'], [mongoose, 'createConnection'],
      [mongoose.Connection.prototype, 'openUri'],
      [mongoose.mongo.MongoClient.prototype, 'connect'],
      [mongoose.Query.prototype, 'exec'], [mongoose.Aggregate.prototype, 'exec'],
      [mongoose.Model, 'create'], [mongoose.Model, 'insertMany'],
      [mongoose.Model, 'bulkWrite'], [mongoose.Model.prototype, 'save'],
      [globalThis, 'fetch'],
    ]) forbiddenCalls.push(mock.method(object, method, forbidden));

    // Observe real Winston instances so their actual file transports can be
    // closed. This delegates unchanged; logging middleware still runs normally.
    const createLogger = winston.createLogger;
    mock.method(winston, 'createLogger', function (...args) {
      const logger = Reflect.apply(createLogger, this, args);
      loggers.push(logger);
      for (const transport of logger.transports) openedTransports.push(once(transport, 'open'));
      return logger;
    });
    importListenerGuard = mock.method(net.Server.prototype, 'listen', () => {
      throw new Error('Importing dist/app.js must not start a listener');
    });
    try { app = require('../dist/app.js'); }
    finally { importListenerGuard.mock.restore(); }
  });

  after(async () => {
    try {
      await Promise.all(openedTransports);
      // Closing a logger unpipes/closes its real transports; await their public
      // closed events before deleting the temporary log directory.
      const closed = loggers.flatMap((logger) => logger.transports.map((transport) => once(transport, 'closed')));
      loggers.forEach((logger) => logger.close());
      await Promise.all(closed);
      for (const call of forbiddenCalls) assert.equal(call.mock.callCount(), 0);
      assert.equal(mongoose.connection.readyState, 0);
    } finally {
      mock.restoreAll();
      if (originalMethods === undefined) delete process.env.DEFAULT_ALLOWED_METHODS;
      else process.env.DEFAULT_ALLOWED_METHODS = originalMethods;
      if (originalCwd) process.chdir(originalCwd);
      if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    }
  });

  const withListener = async (run) => {
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      assert.equal(server.address().address, '127.0.0.1');
      assert.ok(server.address().port > 0);
      return await run(server.address().port);
    } finally {
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      assert.equal(server.listening, false);
      assert.equal(server.address(), null);
    }
  };

  const request = (method, endpoint, headers = {}, body = '') => withListener((port) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: endpoint,
      headers: { ...headers, Connection: 'close' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Local smoke request timed out')));
    req.end(body);
  }));
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const assertValidation = (response, field, message = `"${field}" is required`) => {
    assert.equal(response.status, 400);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(response.body), { statusCode: 400, error: 'Bad Request', message: 'Validation failed',
      validation: { body: { source: 'body', keys: [field], message } } });
  };
  const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const assertErrorResponse = (response, status, message) => {
    assert.equal(response.status, status);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(response.body), { message });
    for (const call of forbiddenCalls) assert.equal(call.mock.callCount(), 0);
  };

  it('imports a configured app without MongoDB connection or HTTP listener', () => {
    assert.equal(typeof app, 'function');
    assert.equal(typeof app.listen, 'function');
    assert.equal(importListenerGuard.mock.callCount(), 0);
    assert.equal(mongoose.connection.readyState, 0);
    assert.equal(require.cache[require.resolve('../dist/server.js')], undefined);
    for (const call of forbiddenCalls) assert.equal(call.mock.callCount(), 0);
  });

  it('binds an ephemeral loopback port and closes it cleanly', async () => {
    await withListener(async () => {});
  });

  it('keeps the real compiled app trust proxy disabled and ignores forwarded identity', () => {
    assert.equal(app.get('trust proxy'), false);
    const socket = { remoteAddress: '198.51.100.23' };
    const req = Object.assign(Object.create(app.request), { app, socket, headers: {
      host: 'local.example.invalid', 'x-forwarded-for': '203.0.113.9',
      'x-forwarded-host': 'forwarded.example.invalid', 'x-forwarded-proto': 'https',
    } });
    assert.equal(app.get('trust proxy fn')(socket.remoteAddress, 0), false);
    assert.equal(req.ip, socket.remoteAddress);
    assert.deepEqual(req.ips, []);
    assert.equal(req.hostname, 'local.example.invalid');
    assert.equal(req.protocol, 'http');
    assert.equal(req.secure, false);
  });

  it('keeps forwarded headers from bypassing real HTTP authentication', async () => {
    const response = await request('GET', '/expenses', {
      'X-Forwarded-For': '10.1.2.3, 203.0.113.9',
      'X-Forwarded-Host': 'forwarded.example.invalid', 'X-Forwarded-Proto': 'https',
    });
    assertErrorResponse(response, 401, 'Необходима авторизация.');
    assert.equal(app.get('trust proxy'), false);
  });

  for (const endpoint of ['/expenses', '/incomes', '/users/me', '/balance', '/not-a-route']) {
    it(`keeps ${endpoint} behind the existing authentication/error middleware`, async () => {
      const response = await request('GET', endpoint);
      assert.equal(response.status, 401);
      assert.match(response.headers['content-type'], /application\/json/);
      assert.deepEqual(JSON.parse(response.body), { message: 'Необходима авторизация.' });
    });
  }

  for (const endpoint of ['/signin', '/signup']) {
    it(`keeps public ${endpoint} validation before authentication and controllers`, async () => {
      assertValidation(await request('POST', endpoint, jsonHeaders, '{}'), 'email');
    });
  }

  it('parses URL-encoded bodies before public authentication validation', async () => {
    const response = await request('POST', '/signin', { 'Content-Type': 'application/x-www-form-urlencoded' },
      'email=fictional%40example.com');
    assertValidation(response, 'password');
  });

  it('keeps JSON parser errors on the existing global error path', async () => {
    const response = await request('POST', '/signin', jsonHeaders, '{');
    assert.equal(response.status, 400);
    assert.match(response.headers['content-type'], /application\/json/);
    const body = JSON.parse(response.body);
    assert.deepEqual(Object.keys(body), ['message']);
    assert.match(body.message, /JSON/i);
  });

  it('parses valid JSON before real login validation without reaching persistence', async () => {
    assertValidation(await request('POST', '/signin', jsonHeaders,
      JSON.stringify({ email: 'fictional@example.com' })), 'password');
  });

  for (const [label, body, field, message] of [
    ['nested object', 'email[value]=fictional%40example.com', 'email', '"email" must be a string'],
    ['bracket array', 'email[]=fictional%40example.com&email[]=other%40example.com', 'email', '"email" must be a string'],
    // qs tolerates invalid percent escapes; the existing rejection is Joi's
    // email validation, not a newly invented parser error contract.
    ['malformed percent encoding', 'email=%E0%A4%A', 'email', '"email" must be a valid email'],
    // qs 6.16 treats this malformed key as an object. The reviewed contract
    // keeps HTTP 400 and the Celebrate response shape with this type error.
    ['unclosed bracket', 'email[=fictional%40example.com', 'email', '"email" must be a string'],
  ]) {
    it(`preserves bounded URL-encoded ${label} validation`, async () => {
      assertValidation(await request('POST', '/signin', formHeaders, body), field, message);
    });
  }

  it('accepts exactly the default 100 KiB JSON limit before login validation', async () => {
    const json = JSON.stringify({ email: 'fictional@example.com' });
    const body = json + ' '.repeat(100 * 1024 - Buffer.byteLength(json));
    assert.equal(Buffer.byteLength(body), 100 * 1024);
    assertValidation(await request('POST', '/signin', jsonHeaders, body), 'password');
  });

  for (const [label, headers, prefix] of [
    ['JSON', jsonHeaders, '{}'],
    ['URL-encoded', formHeaders, 'padding='],
  ]) {
    it(`rejects ${label} one byte over the default body limit before authentication/persistence`, async () => {
      // Bounded 102401-byte fixture, not a load/OOM test. The protected route
      // would return 401 if parsing did not reject before authentication.
      const fill = label === 'JSON' ? ' ' : 'x';
      const body = prefix + fill.repeat(100 * 1024 + 1 - Buffer.byteLength(prefix));
      assert.equal(Buffer.byteLength(body), 100 * 1024 + 1);
      assertErrorResponse(await request('POST', '/expenses', headers, body), 413, 'request entity too large');
    });
  }

  it('accepts 1000 URL-encoded parameters before login validation', async () => {
    const body = ['email=fictional%40example.com', ...Array(999).fill('spare=x')].join('&');
    assert.ok(Buffer.byteLength(body) < 12000);
    assertValidation(await request('POST', '/signin', formHeaders, body), 'password');
  });

  it('rejects 1001 URL-encoded parameters before authentication/persistence', async () => {
    const body = Array(1001).fill('spare=x').join('&');
    assert.ok(Buffer.byteLength(body) < 12000);
    assertErrorResponse(await request('POST', '/expenses', formHeaders, body), 413, 'too many parameters');
  });

  it('rejects a bounded form beyond the default nesting depth before authentication/persistence', async () => {
    const body = `email${'[nested]'.repeat(33)}=fictional`;
    assert.ok(Buffer.byteLength(body) < 400);
    assertErrorResponse(await request('POST', '/expenses', formHeaders, body), 400, 'The input exceeded the depth');
  });

  it('accepts a quoted case-insensitive JSON content type and UTF-8 charset', async () => {
    assertValidation(await request('POST', '/signin', { 'Content-Type': 'Application/JSON; Charset="UTF-8"' },
      JSON.stringify({ email: 'fictional@example.com' })), 'password');
  });

  it('decodes valid UTF-16LE JSON before real validation', async () => {
    const body = Buffer.from(JSON.stringify({ email: 'fictional@example.com' }), 'utf16le');
    assertValidation(await request('POST', '/signin', { 'Content-Type': 'application/json; charset=utf-16le' }, body), 'password');
  });

  it('preserves the accepted ISO-8859-1 form charset', async () => {
    assertValidation(await request('POST', '/signin', {
      'Content-Type': 'application/x-www-form-urlencoded; charset=iso-8859-1',
    }, 'email=fictional%40example.com&padding=caf%E9'), 'password');
  });

  for (const [type, charset, body] of [
    ['application/json', 'iso-8859-1', '{}'],
    ['application/x-www-form-urlencoded', 'utf-16le', 'email=fictional%40example.com'],
  ]) {
    it(`rejects unsupported ${type} charset before authentication/persistence`, async () => {
      assertErrorResponse(await request('POST', '/expenses', { 'Content-Type': `${type}; charset=${charset}` }, body),
        415, `unsupported charset "${charset.toUpperCase()}"`);
    });
  }

  it('preserves the existing generic 500 when text/plain bypasses body parsing', async () => {
    // Baseline behavior: skipped parsing leaves body undefined on this legacy
    // login path. Changing its HTTP error policy is outside this dependency PR.
    assertErrorResponse(await request('POST', '/signin', { 'Content-Type': 'text/plain' },
      JSON.stringify({ email: 'fictional@example.com' })), 500, 'На сервере произошла ошибка');
  });

  it('adds the existing localhost CORS header even to unauthorized responses', async () => {
    const response = await request('GET', '/expenses', { Origin: 'http://localhost:5173' });
    assert.equal(response.status, 401);
    assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173');
    assert.deepEqual(JSON.parse(response.body), { message: 'Необходима авторизация.' });
  });

  it('handles localhost preflight before protected routes using the configured methods', async () => {
    const response = await request('OPTIONS', '/expenses', { Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173');
    assert.equal(response.headers['access-control-allow-methods'], 'GET,POST,PATCH,DELETE,OPTIONS');
    assert.equal(response.headers['access-control-allow-headers'], 'content-type');
    assert.equal(response.body, '');
  });

  it('does not grant CORS origin access to an unlisted fictional origin', async () => {
    const response = await request('GET', '/expenses', { Origin: 'https://fictional.example.invalid' });
    assert.equal(response.status, 401);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });
});
