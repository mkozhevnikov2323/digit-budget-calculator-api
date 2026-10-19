const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const express = require('express');

const modulePath = require.resolve('../dist/middlewares/cors.js');
const methods = 'GET,POST,PATCH,DELETE,OPTIONS';
const localhost = 'http://localhost:5173';
const deployed = 'https://digit-budget-calculator.onrender.com';

// Exercise real Express header conversion on Node HTTP objects, without binding
// any listener. The existing app smoke suite covers actual loopback preflight.
const invoke = (cors, method = 'GET', headers = {}) => {
  const req = new http.IncomingMessage(new net.Socket());
  req.method = method;
  req.headers = headers;
  const res = new http.ServerResponse(req);
  Object.setPrototypeOf(res, express.response);
  const nextCalls = [];
  let endCalls = 0;
  const end = res.end;
  res.end = function (...args) { endCalls++; return Reflect.apply(end, this, args); };
  try {
    const result = cors(req, res, (...args) => { nextCalls.push(args); return 'synthetic-next'; });
    return { res, nextCalls, endCalls, result };
  } finally {
    res.destroy();
    req.destroy();
  }
};
const assertContinued = ({ res, nextCalls, endCalls, result }) => {
  assert.deepEqual(nextCalls, [[]]);
  assert.equal(endCalls, 0);
  assert.equal(res.writableEnded, false);
  assert.equal(result, 'synthetic-next');
};
const assertPreflight = ({ res, nextCalls, endCalls, result }) => {
  assert.deepEqual(nextCalls, []);
  assert.equal(endCalls, 1);
  assert.equal(res.writableEnded, true);
  assert.equal(res.statusCode, 200);
  assert.equal(result, res);
  assert.equal(res.getHeader('Access-Control-Allow-Credentials'), undefined);
};

describe('compiled CORS contracts', { concurrency: false }, () => {
  let cors;
  let savedMethods;
  let savedModule;

  beforeEach(() => {
    savedMethods = process.env.DEFAULT_ALLOWED_METHODS;
    savedModule = require.cache[modulePath];
    delete require.cache[modulePath];
    process.env.DEFAULT_ALLOWED_METHODS = methods;
    cors = require(modulePath);
  });
  afterEach(() => {
    delete require.cache[modulePath];
    if (savedModule) require.cache[modulePath] = savedModule;
    if (savedMethods === undefined) delete process.env.DEFAULT_ALLOWED_METHODS;
    else process.env.DEFAULT_ALLOWED_METHODS = savedMethods;
  });

  it('exports a direct CommonJS middleware function', () => {
    assert.equal(typeof cors, 'function');
    assert.equal(cors.default, undefined);
    assert.equal(cors.length, 3);
  });

  for (const origin of [localhost, deployed]) {
    it(`allows the existing ${origin} origin and delegates non-OPTIONS requests`, () => {
      const response = invoke(cors, 'GET', { origin });
      assert.equal(response.res.getHeader('Access-Control-Allow-Origin'), origin);
      assert.equal(response.res.getHeader('Access-Control-Allow-Credentials'), undefined);
      assert.equal(response.res.getHeader('Access-Control-Allow-Methods'), undefined);
      assertContinued(response);
    });
  }

  for (const origin of ['https://fictional.example.invalid', '*', `${localhost}/`, 'HTTP://localhost:5173']) {
    it(`does not allow or normalize ${origin}`, () => {
      const response = invoke(cors, 'GET', { origin });
      assert.equal(response.res.getHeader('Access-Control-Allow-Origin'), undefined);
      assertContinued(response);
    });
  }

  it('omits allow-origin when Origin is missing and delegates', () => {
    const response = invoke(cors);
    assert.equal(response.res.getHeader('Access-Control-Allow-Origin'), undefined);
    assertContinued(response);
  });

  it('ends preflight before downstream routes and forwards configured methods/request headers', () => {
    const response = invoke(cors, 'OPTIONS', {
      origin: localhost, 'access-control-request-headers': 'content-type,x-synthetic',
    });
    assertPreflight(response);
    assert.equal(response.res.getHeader('Access-Control-Allow-Origin'), localhost);
    assert.equal(response.res.getHeader('Access-Control-Allow-Methods'), methods);
    assert.equal(response.res.getHeader('Access-Control-Allow-Headers'), 'content-type,x-synthetic');
  });

  it('preserves termination for an unknown-origin preflight without granting allow-origin', () => {
    const response = invoke(cors, 'OPTIONS', {
      origin: 'https://fictional.example.invalid', 'access-control-request-headers': 'x-synthetic',
    });
    assertPreflight(response);
    assert.equal(response.res.getHeader('Access-Control-Allow-Origin'), undefined);
    assert.equal(response.res.getHeader('Access-Control-Allow-Methods'), methods);
    assert.equal(response.res.getHeader('Access-Control-Allow-Headers'), 'x-synthetic');
  });

  it('keeps DEFAULT_ALLOWED_METHODS captured at module evaluation time', () => {
    process.env.DEFAULT_ALLOWED_METHODS = 'SYNTHETIC-LATER-VALUE';
    assert.equal(require(modulePath), cors);
    const response = invoke(cors, 'OPTIONS', { origin: localhost });
    assertPreflight(response);
    assert.equal(response.res.getHeader('Access-Control-Allow-Methods'), methods);
  });

  it('preserves the literal undefined header when DEFAULT_ALLOWED_METHODS was missing at import', () => {
    delete process.env.DEFAULT_ALLOWED_METHODS;
    delete require.cache[modulePath];
    const response = invoke(require(modulePath), 'OPTIONS', { origin: localhost });
    assertPreflight(response);
    assert.equal(response.res.getHeader('Access-Control-Allow-Methods'), 'undefined');
  });

  it('preserves missing request-header handling without inserting a default', () => {
    const response = invoke(cors, 'OPTIONS');
    assertPreflight(response);
    assert.equal(response.res.getHeader('Access-Control-Allow-Origin'), undefined);
    assert.equal(response.res.getHeader('Access-Control-Allow-Headers'), 'undefined');
  });

  it('forwards array-valued requested headers through the existing Express boundary', () => {
    const response = invoke(cors, 'OPTIONS', { 'access-control-request-headers': ['x-synthetic', 'content-type'] });
    assertPreflight(response);
    assert.deepEqual(response.res.getHeader('Access-Control-Allow-Headers'), ['x-synthetic', 'content-type']);
  });
});
