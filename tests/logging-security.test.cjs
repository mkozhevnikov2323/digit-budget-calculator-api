const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const winston = require('winston');

// Every value is fictional. Assertions print labels/booleans, never file contents
// or tokens, even when this suite catches a logging regression.
const markers = Object.fromEntries([
  'cookie', 'password', 'query', 'pathname', 'description', 'source', 'comment',
  'nested', 'errorMessage', 'errorStack', 'errorMetadata', 'databaseUri',
  'validation', 'responseBody', 'unknownMethod', 'symbolMessage', 'symbolSplat',
  'nestedSerializer', 'invalidStatus', 'userClaim', 'malformedPassword', 'malformedDescription',
].map(label => [label, `B3G_SYNTHETIC_${label}_9f3c7a`]));
markers.amount = '937462.81';
markers.malformedAmount = '486291.73';
const malformedBody = `{"password":"${markers.malformedPassword}","amount":${markers.malformedAmount},"description":"${markers.malformedDescription}",}`;
markers.jwt = jwt.sign({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', fixture: markers.userClaim },
  'super-secret-key', { noTimestamp: true });
markers.invalidJwt = jwt.sign({ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
  'B3G_SYNTHETIC_wrong_signing_key', { noTimestamp: true });

describe('sensitive data excluded from actual serialized File logs', { concurrency: false, timeout: 15000 }, () => {
  let sandbox;
  let originalCwd;
  let closing;
  let middleware;
  let files;
  let records;
  let parserMessage;
  const originalEnv = new Map();
  const loggers = [];
  const opened = [];
  const transports = [];
  const streams = [];
  const streamClosures = [];
  const guards = [];
  const listeners = [];
  const allowedPorts = new Set();
  const responses = {};
  const forbidden = () => { throw new Error('Database/external network forbidden in logging security tests'); };

  const closeLoggers = () => {
    if (!closing) closing = (async () => {
      await Promise.all(opened);
      // logger.close() can unpipe before buffered writes finish. End and await
      // finish first, then await both transport and actual fs stream closure.
      const finished = loggers.map(logger => once(logger, 'finish'));
      const closed = transports.map(transport => once(transport, 'closed'));
      loggers.forEach(logger => logger.end());
      await Promise.all(finished);
      loggers.forEach(logger => logger.close());
      await Promise.all(closed);
      await Promise.all(streamClosures);
    })();
    return closing;
  };

  const request = (port, method, endpoint, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: endpoint,
      headers: { ...headers, Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Synthetic loopback request timed out')));
    // Buffers are raw bytes; existing object fixtures retain JSON serialization.
    req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });

  const listen = async app => {
    const server = app.listen(0, '127.0.0.1');
    listeners.push(server);
    await once(server, 'listening');
    assert.equal(server.address().address, '127.0.0.1');
    allowedPorts.add(server.address().port);
    return server.address().port;
  };
  const closeListeners = async () => {
    for (const server of listeners) {
      if (server.listening) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
    allowedPorts.clear();
  };

  before(async () => {
    originalCwd = process.cwd();
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-log-security-'));
    process.chdir(sandbox); // Also isolates the legacy users controller dotenv call.
    for (const key of ['NODE_ENV', 'JWT_SECRET', 'DEFAULT_ALLOWED_METHODS']) originalEnv.set(key, process.env[key]);
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    process.env.DEFAULT_ALLOWED_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';

    for (const [object, method] of [
      [mongoose, 'connect'], [mongoose, 'createConnection'],
      [mongoose.Connection.prototype, 'openUri'], [mongoose.mongo.MongoClient.prototype, 'connect'],
      [mongoose.Query.prototype, 'exec'], [mongoose.Aggregate.prototype, 'exec'],
      [mongoose.Model, 'create'], [mongoose.Model, 'insertMany'], [mongoose.Model, 'bulkWrite'],
      [mongoose.Model.prototype, 'save'], [globalThis, 'fetch'],
      [http, 'get'], [https, 'request'], [https, 'get'],
    ]) guards.push(mock.method(object, method, forbidden));

    const httpRequest = http.request;
    mock.method(http, 'request', function (options, callback) {
      if (options.hostname !== '127.0.0.1' || !allowedPorts.has(options.port)) return forbidden();
      return Reflect.apply(httpRequest, this, [options, callback]);
    });
    const socketConnect = net.Socket.prototype.connect;
    mock.method(net.Socket.prototype, 'connect', function (...args) {
      // Node normalizes http.request socket arguments into [options, callback].
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (options?.host !== '127.0.0.1' || !allowedPorts.has(Number(options.port))) return forbidden();
      return Reflect.apply(socketConnect, this, args);
    });

    // Observe/delegate real factories; do not replace the logger or File I/O.
    const createWriteStream = fs.createWriteStream;
    mock.method(fs, 'createWriteStream', function (...args) {
      const stream = Reflect.apply(createWriteStream, this, args);
      streams.push(stream);
      streamClosures.push(once(stream, 'close'));
      return stream;
    });
    const createLogger = winston.createLogger;
    mock.method(winston, 'createLogger', function (...args) {
      const logger = Reflect.apply(createLogger, this, args);
      loggers.push(logger);
      for (const transport of logger.transports) {
        transports.push(transport);
        opened.push(once(transport, 'open'));
      }
      return logger;
    });
    const importGuard = mock.method(net.Server.prototype, 'listen', forbidden);
    let app;
    try { app = require('../dist/app.js'); }
    finally { importGuard.mock.restore(); }
    assert.equal(importGuard.mock.callCount(), 0);
    middleware = require('../dist/middlewares/logger.js');
    const globalErrorHandler = require('../dist/errors/globalErrorHandler.js');
    const port = await listen(app);
    const auth = { Authorization: `Bearer ${markers.jwt}` };
    try { JSON.parse(malformedBody); }
    catch (error) { parserMessage = error.message; }
    // First traffic: its error must be the first error.log event. body-parser
    // rejects before requestLogger and routes; no persistence is reached.
    responses.malformed = await request(port, 'POST', '/signin', {}, Buffer.from(malformedBody));
    responses.unauthorized = await request(port, 'GET', `/expenses?secret=${markers.query}`, {
      Authorization: `Bearer ${markers.invalidJwt}`, Cookie: `session=${markers.cookie}`,
    });
    responses.missingAuth = await request(port, 'GET', '/expenses');
    responses.login = await request(port, 'POST', '/signin', {}, {
      email: markers.validation, password: markers.password,
      unknown: { deeply: { unfamiliarField: markers.nested } },
    });
    // A valid JWT on an unknown protected URL exercises req.user, not persistence.
    responses.notFound = await request(port, 'GET', `/${markers.pathname}?secret=${markers.query}`, auth);
    // Invalid amount fails real Celebrate before the financial controller.
    responses.validation = await request(port, 'POST', '/expenses', auth, {
      amount: -1, date: '2026-01-15', title: markers.description,
      recipient: 'fictional', category: 'fictional', comment: markers.comment,
    });
    responses.preflight = await request(port, 'OPTIONS', '/expenses', {
      Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST',
    });

    // Test-only routes reach success/500 without adding application routes or
    // calling persistence. Real compiled middleware and global handler are used.
    const synthetic = express();
    synthetic.use(express.json());
    synthetic.use(middleware.requestLogger);
    synthetic.post('/success/:private', (req, res) => {
      req.user = { opaque: markers.userClaim };
      req._routeWhitelists.req.push('headers', 'body', 'query', 'user', 'params');
      req._routeWhitelists.res.push('body');
      req._routeWhitelists.body.push(...Object.keys(req.body));
      res.status(201).json({ result: markers.responseBody, amount: req.body.amount });
    });
    synthetic.get('/failure', (req, res, next) => {
      const error = new Error(markers.errorMessage);
      error.stack = markers.errorStack;
      error.details = { opaque: markers.errorMetadata, connection: `mongodb://fictional.invalid/${markers.databaseUri}` };
      next(error);
    });
    synthetic.use(middleware.errorLogger);
    synthetic.use(globalErrorHandler);
    const syntheticPort = await listen(synthetic);
    responses.success = await request(syntheticPort, 'POST', `/success/${markers.pathname}?secret=${markers.query}`, {
      ...auth, Cookie: `session=${markers.cookie}`,
    }, { amount: Number(markers.amount), description: markers.description, source: markers.source,
      comment: markers.comment, unknown: { deeply: { unfamiliarField: markers.nested } } });
    responses.failure = await request(syntheticPort, 'GET', '/failure', auth);

    // Exercise enum fallback through the actual middleware, bypassing only
    // Node's HTTP parser (it rejects most nonstandard methods before Express).
    const req = { method: markers.unknownMethod, url: '/fixture', headers: {}, query: {} };
    const res = { statusCode: 204, end() {}, getHeader() {} };
    middleware.requestLogger(req, res, () => {});
    res.end();

    // Simulate future library enrichment, including Winston's special symbols
    // and nested toJSON. Only a fresh allowlisted object may reach format.json.
    for (const [index, logger] of loggers.entries()) logger.log({
      level: index === 0 ? 'info' : 'error', message: markers.errorMessage,
      method: markers.unknownMethod, statusCode: { toJSON: () => markers.invalidStatus },
      nested: { toJSON: () => markers.nestedSerializer },
      [Symbol.for('message')]: markers.symbolMessage,
      [Symbol.for('splat')]: [{ opaque: markers.symbolSplat }],
    });

    await closeListeners();
    await closeLoggers();
    files = Object.fromEntries(['request.log', 'error.log'].map(filename =>
      [filename, fs.readFileSync(path.join(sandbox, filename), 'utf8')]));
    records = Object.fromEntries(Object.entries(files).map(([filename, text]) =>
      [filename, text.trim().split('\n').map(line => JSON.parse(line))]));
  });

  after(async () => {
    try {
      await closeListeners();
      await closeLoggers();
    } finally {
      mock.restoreAll();
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (originalCwd) process.chdir(originalCwd);
      if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  for (const label of Object.keys(markers)) it(`excludes ${label} from both complete files`, () => {
    for (const [filename, text] of Object.entries(files)) {
      assert.equal(text.includes(markers[label]), false, `Sensitive ${label} appeared in ${filename}`);
    }
  });

  it('retains only safe JSON keys, enum methods, fixed messages and levels', () => {
    for (const [filename, entries] of Object.entries(records)) {
      assert.ok(entries.length > 0, `${filename} must not be silent`);
      const requestLog = filename === 'request.log';
      for (const entry of entries) {
        assert.equal(Object.keys(entry).every(key => ['level', 'message', 'method', ...(requestLog ? ['statusCode'] : [])].includes(key)), true);
        assert.equal(entry.level === (requestLog ? 'info' : 'error'), true);
        assert.equal(entry.message === (requestLog ? 'http_request' : 'http_error'), true);
        assert.equal(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'CONNECT', 'TRACE', 'OTHER'].includes(entry.method), true);
        if ('statusCode' in entry) assert.equal(Number.isInteger(entry.statusCode) && entry.statusCode >= 100 && entry.statusCode <= 599, true);
      }
    }
  });

  it('emits request events with final 200/201/204/400/401/404/500 statuses and error events', () => {
    assert.equal(records['request.log'].length, 10); // Eight HTTP, one direct middleware, one enrichment; parser failure bypasses it.
    assert.equal(records['error.log'].length, 8); // Seven real error paths plus enrichment.
    for (const status of [200, 201, 204, 400, 401, 404, 500]) {
      assert.equal(records['request.log'].some(entry => entry.statusCode === status), true);
    }
    assert.equal(records['request.log'].some(entry => entry.method === 'OTHER' && entry.statusCode === 204), true);
    assert.equal(records['request.log'].some(entry => entry.method === 'OTHER' && !('statusCode' in entry)), true);
  });

  it('preserves actual authentication 401 bodies for missing and invalid JWTs', () => {
    assert.equal(responses.unauthorized.status, 401);
    assert.deepEqual(JSON.parse(responses.unauthorized.body), { message: 'Необходима авторизация!' });
    assert.equal(responses.missingAuth.status, 401);
    assert.deepEqual(JSON.parse(responses.missingAuth.body), { message: 'Необходима авторизация.' });
  });

  it('preserves real Celebrate login and financial validation 400 bodies', () => {
    for (const [label, field, message] of [
      ['login', 'email', '"email" must be a valid email'],
      ['validation', 'amount', '"amount" must be greater than or equal to 0'],
    ]) {
      assert.equal(responses[label].status, 400);
      assert.deepEqual(JSON.parse(responses[label].body), { statusCode: 400, error: 'Bad Request', message: 'Validation failed',
        validation: { body: { source: 'body', keys: [field], message } } });
    }
  });

  it('preserves the real malformed JSON parser HTTP 400 contract', () => {
    assert.equal(typeof parserMessage, 'string', 'Fixture must be genuinely malformed JSON');
    assert.equal(responses.malformed.status, 400);
    assert.equal(/application\/json/.test(responses.malformed.headers['content-type']), true);
    let body;
    try { body = JSON.parse(responses.malformed.body); }
    catch { assert.fail('Parser error response must be JSON'); }
    // The legacy global handler forwards the parser message. Compare booleans
    // so neither the response nor secret-bearing parser text is printed on failure.
    assert.equal(body !== null && typeof body === 'object', true);
    assert.equal(Object.keys(body).length === 1 && Object.hasOwn(body, 'message'), true);
    assert.equal(body.message === parserMessage, true, 'Existing parser response message changed');
  });

  it('records the parser failure safely without raw body or exception details in either complete file', () => {
    const event = records['error.log'][0];
    assert.equal(Object.keys(event).sort().join(',') === 'level,message,method', true);
    assert.equal(event.level === 'error' && event.message === 'http_error' && event.method === 'POST', true);
    for (const [filename, text] of Object.entries(files)) {
      for (const value of [malformedBody, parserMessage]) {
        assert.equal(text.includes(value), false, `Parser contents appeared in ${filename}`);
        assert.equal(text.includes(JSON.stringify(value).slice(1, -1)), false, `Escaped parser contents appeared in ${filename}`);
      }
      assert.equal(/SyntaxError|entity\.parse\.failed|node_modules[\\/](?:body-parser|raw-body)/.test(text), false,
        `Parser exception details appeared in ${filename}`);
    }
  });

  it('preserves real authenticated 404 and successful CORS preflight', () => {
    assert.equal(responses.notFound.status, 404);
    assert.deepEqual(JSON.parse(responses.notFound.body), { message: 'Страница не найдена!' });
    assert.equal(responses.preflight.status, 200);
    assert.equal(responses.preflight.body, '');
    assert.equal(responses.preflight.headers['access-control-allow-origin'], 'http://localhost:5173');
  });

  it('preserves test-route success payload and the unchanged global 500 response', () => {
    assert.equal(responses.success.status, 201);
    assert.equal(responses.success.body === JSON.stringify({ result: markers.responseBody, amount: Number(markers.amount) }), true);
    assert.equal(responses.failure.status, 500);
    assert.deepEqual(JSON.parse(responses.failure.body), { message: 'На сервере произошла ошибка' });
  });

  it('uses real isolated File transports and closes listeners, transports and fs streams', () => {
    assert.equal(loggers.length, 2);
    assert.deepEqual(transports.map(transport => {
      assert.equal(transport instanceof winston.transports.File, true);
      return transport.filename;
    }), ['request.log', 'error.log']);
    assert.equal(streams.length, 2);
    assert.deepEqual(fs.readdirSync(sandbox).sort(), ['error.log', 'request.log']);
    for (const stream of streams) {
      assert.equal(path.dirname(path.resolve(stream.path)), sandbox);
      assert.equal(stream.closed, true);
    }
    for (const server of listeners) assert.equal(server.address(), null);
  });

  it('never touches database persistence or imports the server bootstrap', () => {
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
    assert.equal(mongoose.connection.readyState, 0);
    assert.equal(require.cache[require.resolve('../dist/server.js')], undefined);
    assert.equal(typeof middleware.requestLogger, 'function');
    assert.equal(typeof middleware.errorLogger, 'function');
    assert.equal(middleware.default, undefined);
  });
});
