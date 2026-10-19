const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const mongoose = require('mongoose');
const winston = require('winston');

const syntheticRequest = () => ({
  method: 'GET', url: '/synthetic-logger-contract', originalUrl: '/synthetic-logger-contract',
  headers: { 'x-fixture': 'synthetic' }, httpVersion: '1.1', query: {},
});

describe('compiled file logging contracts', { concurrency: false, timeout: 10000 }, () => {
  let middleware;
  let sandbox;
  let originalCwd;
  let closing;
  const loggers = [];
  const opened = [];
  const streams = [];
  const streamClosures = [];
  const guards = [];
  const forbidden = () => { throw new Error('DB/network/listener forbidden in logger contracts'); };

  const closeLoggers = () => {
    if (!closing) closing = (async () => {
      await Promise.all(opened);
      const closed = loggers.flatMap(logger => logger.transports.map(transport => once(transport, 'closed')));
      loggers.forEach(logger => logger.close());
      await Promise.all(closed);
      // Transport "logged"/"closed" need not mean the OS file is flushed.
      // Observe real fs streams and await their public close events as well.
      await Promise.all(streamClosures);
    })();
    return closing;
  };

  before(async () => {
    originalCwd = process.cwd();
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-logger-contract-'));
    process.chdir(sandbox);
    for (const [object, method] of [
      [mongoose, 'connect'], [mongoose, 'createConnection'],
      [mongoose.Connection.prototype, 'openUri'], [mongoose.mongo.MongoClient.prototype, 'connect'],
      [mongoose.Query.prototype, 'exec'], [mongoose.Aggregate.prototype, 'exec'],
      [mongoose.Model, 'create'], [mongoose.Model, 'insertMany'], [mongoose.Model, 'bulkWrite'],
      [mongoose.Model.prototype, 'save'], [globalThis, 'fetch'],
      [net.Server.prototype, 'listen'], [net.Socket.prototype, 'connect'],
      [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    ]) guards.push(mock.method(object, method, forbidden));

    // Observe public factories, delegating unchanged to real Winston/File I/O.
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
      for (const transport of logger.transports) opened.push(once(transport, 'open'));
      return logger;
    });
    middleware = require('../dist/middlewares/logger.js');
    await Promise.all(opened);
  });

  after(async () => {
    try { await closeLoggers(); }
    finally {
      mock.restoreAll();
      if (originalCwd) process.chdir(originalCwd);
      if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('exports exactly the two existing Express-compatible CommonJS middleware functions', () => {
    assert.deepEqual(Object.keys(middleware).sort(), ['errorLogger', 'requestLogger']);
    assert.equal(middleware.default, undefined);
    assert.equal(typeof middleware.requestLogger, 'function');
    assert.equal(typeof middleware.errorLogger, 'function');
    assert.equal(middleware.requestLogger.length, 3);
    assert.equal(middleware.errorLogger.length, 4);
  });

  it('initializes one real File transport per logger with the unchanged filenames', () => {
    assert.equal(loggers.length, 2);
    assert.deepEqual(loggers.map(logger => {
      assert.equal(logger.transports.length, 1);
      assert.ok(logger.transports[0] instanceof winston.transports.File);
      return logger.transports[0].filename;
    }), ['request.log', 'error.log']);
    assert.equal(streams.length, 2);
    for (const stream of streams) assert.equal(path.dirname(path.resolve(stream.path)), sandbox);
  });

  it('logs a synthetic request as JSON and delegates to next() once', async () => {
    const logged = once(loggers[0].transports[0], 'logged');
    const calls = [];
    const res = { statusCode: 200, end() {}, getHeader() {} };
    middleware.requestLogger(syntheticRequest(), res, (...args) => calls.push(args));
    assert.deepEqual(calls, [[]]);
    res.end();
    const [info] = await logged;
    const json = JSON.parse(info[Symbol.for('message')]);
    assert.equal(json.level, 'info');
    assert.equal(json.message, 'HTTP GET /synthetic-logger-contract');
  });

  it('logs a synthetic error as JSON and delegates the same error once', async () => {
    const logged = once(loggers[1].transports[0], 'logged');
    const error = new Error('Synthetic logger contract error');
    const calls = [];
    middleware.errorLogger(error, syntheticRequest(), { statusCode: 500 }, (...args) => calls.push(args));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0], error);
    const [info] = await logged;
    const json = JSON.parse(info[Symbol.for('message')]);
    assert.equal(json.level, 'error');
    assert.equal(json.message, 'middlewareError');
  });

  it('never connects to MongoDB, starts listeners or imports server bootstrap', () => {
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
    assert.equal(mongoose.connection.readyState, 0);
    assert.equal(require.cache[require.resolve('../dist/server.js')], undefined);
  });

  it('flushes JSON files, closes every real file handle and removes isolated logs', async () => {
    await closeLoggers();
    for (const stream of streams) assert.equal(stream.closed, true);
    assert.deepEqual(fs.readdirSync(sandbox).sort(), ['error.log', 'request.log']);
    for (const [filename, level] of [['request.log', 'info'], ['error.log', 'error']]) {
      const lines = fs.readFileSync(path.join(sandbox, filename), 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).level, level);
    }
    process.chdir(originalCwd);
    fs.rmSync(sandbox, { recursive: true, force: true });
    assert.equal(fs.existsSync(sandbox), false);
  });
});
