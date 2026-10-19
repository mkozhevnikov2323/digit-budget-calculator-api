const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const auth = require('../dist/middlewares/auth.js');
const AuthorizationError = require('../dist/errors/authorizationError.js');

// Public legacy development literal, not a production credential. All other
// keys/payloads are synthetic and are never logged or written to configuration.
const developmentSecret = 'super-secret-key';
const productionTestSecret = 'synthetic-production-contract-key';
const otherTestSecret = 'synthetic-different-contract-key';
const now = 1800000000;
const missingMessage = 'Необходима авторизация.';
const invalidMessage = 'Необходима авторизация!';

const sign = (payload, secret = developmentSecret) => jwt.sign(
  typeof payload === 'string' ? payload : { iat: now - 60, ...payload },
  secret,
  { algorithm: 'HS256' },
);
const invoke = (authorization, initial = {}) => {
  const req = { ...initial, headers: authorization === undefined ? {} : { authorization } };
  const calls = [];
  const result = auth(req, {}, (...args) => { calls.push(args); });
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  return { req, args: calls[0] };
};
const assertRejected = (authorization, message, initial = {}) => {
  const { req, args } = invoke(authorization, initial);
  assert.equal(args.length, 1);
  assert.ok(args[0] instanceof AuthorizationError);
  assert.equal(args[0].statusCode, 401);
  assert.equal(args[0].message, message);
  assert.equal(Object.hasOwn(req, 'user'), Object.hasOwn(initial, 'user'));
  assert.equal(req.user, initial.user);
};

describe('compiled JWT authentication contracts', { concurrency: false }, () => {
  let savedEnv;
  let clock;

  before(() => {
    // Fixed verification clock makes expiry cases independent of wall time.
    // JWT signing and verification themselves are real, not mocked.
    clock = mock.method(Date, 'now', () => now * 1000);
  });
  after(() => clock.mock.restore());
  beforeEach(() => {
    savedEnv = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
  });
  afterEach(() => {
    for (const name of ['NODE_ENV', 'JWT_SECRET']) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it('exports CommonJS middleware directly without .default', () => {
    assert.equal(typeof auth, 'function');
    assert.equal(auth.default, undefined);
    assert.equal(auth.length, 3);
  });

  for (const [name, header, message] of [
    ['missing header', undefined, missingMessage],
    ['empty header', '', missingMessage],
    ['incorrect prefix', 'Basic synthetic', missingMessage],
    ['lowercase bearer', 'bearer synthetic', missingMessage],
    ['empty Bearer token', 'Bearer ', invalidMessage],
    ['malformed JWT', 'Bearer synthetic-not-a-jwt', invalidMessage],
    ['leading whitespace', ' Bearer synthetic', missingMessage],
  ]) {
    it(`rejects ${name} with the exact legacy message and no user assignment`, () => {
      assertRejected(header, message);
    });
  }

  it('accepts a development token, assigns the exact decoded payload and calls next() once', () => {
    const payload = { _id: 'fictional-owner-a', iat: now - 60, exp: now + 60, extra: { fictional: true } };
    const { req, args } = invoke(`Bearer ${sign(payload)}`);
    assert.deepEqual(args, []);
    assert.deepEqual(req.user, payload);
  });

  it('keeps user state separate across distinct and subsequent unauthenticated requests', () => {
    const first = invoke(`Bearer ${sign({ _id: 'fictional-owner-a' })}`);
    const second = invoke(`Bearer ${sign({ _id: 'fictional-owner-b' })}`);
    assert.deepEqual(first.args, []);
    assert.deepEqual(second.args, []);
    assert.deepEqual(first.req.user, { _id: 'fictional-owner-a', iat: now - 60 });
    assert.deepEqual(second.req.user, { _id: 'fictional-owner-b', iat: now - 60 });
    assert.notEqual(first.req.user, second.req.user);
    assertRejected(undefined, missingMessage);
  });

  it('rejects an invalid signature', () => {
    const parts = sign({ _id: 'fictional-owner' }).split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    assertRejected(`Bearer ${parts.join('.')}`, invalidMessage);
  });

  it('rejects an expired token against the fixed clock', () => {
    assertRejected(`Bearer ${sign({ _id: 'fictional-owner', exp: now - 1 })}`, invalidMessage);
  });

  it('rejects a token signed with a different key', () => {
    assertRejected(`Bearer ${sign({ _id: 'fictional-owner' }, otherTestSecret)}`, invalidMessage);
  });

  it('rejects a development token against a configured production key', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = productionTestSecret;
    assertRejected(`Bearer ${sign({ _id: 'fictional-owner' })}`, invalidMessage);
  });

  it('rejects signed tokens when the production key is missing without a development fallback', () => {
    process.env.NODE_ENV = 'production';
    assertRejected(`Bearer ${sign({ _id: 'fictional-owner' })}`, invalidMessage);
    assertRejected(`Bearer ${sign({ _id: 'fictional-owner' }, productionTestSecret)}`, invalidMessage);
  });

  it('accepts a token signed with an explicitly configured synthetic production key', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = productionTestSecret;
    const payload = { _id: 'fictional-production-owner', iat: now - 60, exp: now + 60 };
    const { req, args } = invoke(`Bearer ${sign(payload, productionTestSecret)}`);
    assert.deepEqual(args, []);
    assert.deepEqual(req.user, payload);
  });

  it('ignores configured JWT_SECRET outside production as before', () => {
    process.env.JWT_SECRET = productionTestSecret;
    const { req, args } = invoke(`Bearer ${sign({ _id: 'fictional-owner' })}`);
    assert.deepEqual(args, []);
    assert.equal(req.user._id, 'fictional-owner');
    assertRejected(`Bearer ${sign({ _id: 'fictional-owner' }, productionTestSecret)}`, invalidMessage);
  });

  it('preserves a verified string payload without pretending it is an owner object', () => {
    const { req, args } = invoke(`Bearer ${sign('synthetic-string-payload')}`);
    assert.deepEqual(args, []);
    assert.equal(req.user, 'synthetic-string-payload');
  });

  it('preserves acceptance of a signed object without _id', () => {
    const { req, args } = invoke(`Bearer ${sign({ fictional: true })}`);
    assert.deepEqual(args, []);
    assert.deepEqual(req.user, { fictional: true, iat: now - 60 });
  });

  it('does not add ObjectId validation to a signed _id claim', () => {
    const { req, args } = invoke(`Bearer ${sign({ _id: { fictional: true } })}`);
    assert.deepEqual(args, []);
    assert.deepEqual(req.user, { _id: { fictional: true }, iat: now - 60 });
  });

  it('does not overwrite existing request user state on missing-header or verification failures', () => {
    const user = { fictional: 'preexisting-state' };
    assertRejected(undefined, missingMessage, { user });
    assertRejected('Bearer synthetic-not-a-jwt', invalidMessage, { user });
  });

  it('does not trim token whitespace or remove repeated Bearer prefixes', () => {
    const token = sign({ _id: 'fictional-owner' });
    assertRejected(`Bearer  ${token}`, invalidMessage);
    assertRejected(`Bearer ${token} `, invalidMessage);
    assertRejected(`Bearer Bearer ${token}`, invalidMessage);
  });
});
