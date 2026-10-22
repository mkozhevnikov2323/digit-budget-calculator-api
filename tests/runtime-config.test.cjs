const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { validateRuntimeConfiguration: validate, validateRuntimeTransition: transition,
  runtimePolicyDigest, ISSUANCE_LIMIT } = require('../dist/domain/classification/runtimeConfiguration');
const { loadRuntimeKeyring, runtimeKeyAllowed: allowed } = require('../dist/domain/classification/runtimeKeyPolicy');
const { createRuntimeClock } = require('../dist/domain/classification/runtimeClock');
const start = 1700000000, material = randomBytes(32), materialId = createHash('sha256').update(material).digest('hex');
const key = (extra = {}) => ({ kid: 'synthetic', materialId, state: 'active', issueFrom: start,
  issueUntil: start + 2592000, verifyUntil: start + 2678400, ...extra });
const config = (extra = {}) => ({ version: 'classification-runtime-v1', deploymentId: 'synthetic-era-v1',
  revision: 1, databaseName: 'synthetic_only', issuingKid: 'synthetic', keys: [key()], ...extra });
const valid = input => { const r = validate(input); assert.equal(r.ok, true, 'Synthetic configuration must validate'); return r.value; };
const denied = input => assert.equal(JSON.stringify(validate(input)) === JSON.stringify({ ok: false, code: 'invalid_configuration' }), true, 'Code-only rejection');
const secrets = keys => ({ version: 'classification-secrets-v1', purpose: 'classification-review-aead-v1', keys });

describe('P11 strict trusted runtime configuration and key lifecycle (synthetic)', () => {
  it('accepts a complete immutable copy without material and binds every policy field', () => {
    const c = config(), v = valid(c); assert.equal(Object.isFrozen(v.keys[0]), true);
    assert.equal(ISSUANCE_LIMIT, 1048576); const digest = runtimePolicyDigest(v);
    c.keys[0].kid = 'changed'; assert.equal(v.keys[0].kid, 'synthetic');
    assert.equal(digest === runtimePolicyDigest(valid(config())), true);
    for (const edit of [{ revision: 2 }, { deploymentId: 'synthetic-era-v2' }, { databaseName: 'other' }])
      assert.equal(digest !== runtimePolicyDigest(valid(config(edit))), true);
  });
  for (const [name, edit] of [
    ['unsupported version', { version: 'v2' }], ['missing issuer', { issuingKid: undefined }],
    ['two active issuers', { keys: [key(), key({ kid: 'other', materialId: 'b'.repeat(64) })] }],
    ['duplicate kid', { keys: [key(), key()] }], ['same material different kid', { keys: [key(), key({ kid: 'other', state: 'verify_only' })] }],
    ['unknown key state', { keys: [key({ state: 'retired' })] }], ['oversized issuing window', { keys: [key({ issueUntil: start + 2592001 })] }],
    ['unbounded historical verification', { keys: [key({ verifyUntil: start + 2678401 })] }],
    ['invalid era', { deploymentId: '../synthetic' }], ['URI namespace', { databaseName: 'mongodb://remote.invalid' }],
    ['system namespace', { databaseName: 'admin' }], ['zero revision', { revision: 0 }], ['coerced revision', { revision: '1' }],
    ['unknown field', { secret: 'fictional-private-marker' }], ['invalid identity', { issuingKid: 'synthetic\n' }],
    ['invalid material identity', { keys: [key({ materialId: 'X'.repeat(64) })] }],
  ]) it('rejects ' + name, () => denied(config(edit)));
  for (const [name, make] of [
    ['null', () => null], ['array', () => []], ['prototype', () => Object.assign(Object.create({ x: 1 }), config())],
    ['getter', () => Object.defineProperty(config(), 'revision', { enumerable: true, get() { throw Error('Must not execute'); } })],
    ['toJSON', () => ({ ...config(), toJSON() { throw Error('Must not execute'); } })],
    ['proxy', () => new Proxy(config(), { ownKeys() { throw Error('Must not execute'); } })],
    ['sparse keys', () => config({ keys: Array(1) })],
  ]) it('rejects unsafe input ' + name + ' without coercion or hooks', () => denied(make()));
  for (const [name, change] of [['kid', { issuingKid: 'synthetic\n', keys: [key({ kid: 'synthetic\n' })] }],
    ['era', { deploymentId: 'synthetic-era\n' }], ['namespace', { databaseName: 'synthetic_only\n' }]])
    it('rejects a final newline in ' + name + ' despite JavaScript end-anchor behavior', () => denied(config(change)));
  it('permits verify-only recovery with no issuer and denies new issuance', () => {
    const c = valid(config({ issuingKid: null, keys: [key({ state: 'verify_only' })] }));
    assert.equal(allowed(c, 'synthetic', 'prepare', start + 10, start + 10), false);
    assert.equal(allowed(c, 'synthetic', 'apply', start + 10, start + 11), true);
    assert.equal(allowed(c, 'synthetic', 'reconcile', start + 10, start + 301), true);
  });
  it('bounds issuance, apply after retirement, recovery and revocation without key fallback', () => {
    const k = key({ issueUntil: start + 100, verifyUntil: start + 86500 }), c = valid(config({ keys: [k] }));
    assert.equal(allowed(c, 'synthetic', 'prepare', start + 99, start + 99), true);
    for (const [use, issued, now] of [['prepare', start + 100, start + 100], ['apply', start, start + 400],
      ['apply', start - 1, start], ['reconcile', start, start + 86500]]) assert.equal(allowed(c, 'synthetic', use, issued, now), false);
    assert.equal(allowed(c, 'missing', 'apply', start, start), false);
    const revoked = valid(config({ issuingKid: null, keys: [key({ state: 'revoked' })] }));
    for (const use of ['prepare', 'apply', 'reconcile']) assert.equal(allowed(revoked, 'synthetic', use, start, start), false);
  });
  it('requires purpose-specific exact provider bytes and copies secrets without printable assertions', () => {
    const c = valid(config()), ring = loadRuntimeKeyring(c, secrets([{ kid: 'synthetic', key: material }]));
    assert.equal(!!ring, true); assert.equal(ring.keys[0].key !== material, true);
    assert.equal(ring.keys[0].key.equals(material), true);
    for (const input of [null, secrets([]), secrets([{ kid: 'unknown', key: material }]),
      secrets([{ kid: 'synthetic', key: Buffer.alloc(31) }]), secrets([{ kid: 'synthetic', key: Buffer.alloc(32) }]),
      secrets([{ kid: 'synthetic', key: material.toString('hex') }]),
      { ...secrets([{ kid: 'synthetic', key: material }]), purpose: 'jwt' },
      secrets([{ kid: 'synthetic', key: material }, { kid: 'synthetic', key: material }])])
      assert.equal(loadRuntimeKeyring(c, input) === undefined, true, 'Secret-provider failure remains opaque');
  });
  it('maps revoked keys to disabled entries and rejects material for a revoked identity', () => {
    const c = valid(config({ issuingKid: null, keys: [key({ state: 'revoked' })] }));
    assert.equal(loadRuntimeKeyring(c, secrets([])).keys[0].state, 'disabled');
    assert.equal(loadRuntimeKeyring(c, secrets([{ kid: 'synthetic', key: material }])) === undefined, true);
  });
  it('requires strictly advancing policy revisions and a new era after incompatible restore', () => {
    assert.equal(transition(config(), config({ revision: 2 })), true);
    assert.equal(transition(config(), config()), false);
    assert.equal(transition(config({ revision: 2 }), config()), false);
    assert.equal(transition(config(), config({ revision: 2 }), true), false);
    assert.equal(transition(config(), config({ revision: 2, deploymentId: 'new-restore-era' }), true), true);
    assert.equal(transition(config(), config({ revision: 2, deploymentId: 'new-restore-era' })), false);
  });
  it('retains revocation tombstones, stable material identity and retirement under rollback', () => {
    const retired = config({ issuingKid: null, keys: [key({ state: 'verify_only' })] });
    const revoked = config({ issuingKid: null, keys: [key({ state: 'revoked' })] });
    for (const previous of [retired, revoked]) assert.equal(transition(previous, config({ revision: 2 })), false);
    assert.equal(transition(revoked, { ...revoked, revision: 2 }), true);
    assert.equal(transition(config(), config({ revision: 2, keys: [key({ materialId: 'b'.repeat(64) })] })), false);
    assert.equal(transition(config(), config({ revision: 2, keys: [key({ issueFrom: start + 1 })] })), false);
    assert.equal(transition(config(), config({ revision: 2, keys: [key({ kid: 'alias' })], issuingKid: 'alias' })), false);
  });
});

const clockHarness = () => {
  let wall = start * 1000, mono = 0;
  const clock = createRuntimeClock(() => ({ wallMilliseconds: wall, monotonicMilliseconds: mono }));
  const sample = (extra = {}) => clock.accept({ version: 'classification-clock-evidence-v1', requestId: 'request',
    policyDigest: 'synthetic-binding', utcMilliseconds: wall, uncertaintyMilliseconds: 10, ...extra }, 'request', 'synthetic-binding');
  return { clock, sample, move: (w, m = w) => { wall += w; mono += m; } };
};
describe('P11 independent clock-health boundary (synthetic UTC evidence)', () => {
  it('requires external evidence, tracks monotonic elapsed time and expires evidence', () => {
    const h = clockHarness(); assert.equal(Number.isNaN(h.clock.nowSeconds()), true);
    assert.equal(h.sample(), true); h.move(999); assert.equal(h.clock.nowSeconds(), start);
    h.move(4002); assert.equal(Number.isNaN(h.clock.nowSeconds()), true);
    assert.equal(h.sample(), true); assert.equal(h.clock.nowSeconds(), start + 5);
  });
  for (const [name, extra] of [['skew', { utcMilliseconds: start * 1000 + 2001 }], ['uncertainty', { uncertaintyMilliseconds: 1001 }],
    ['version', { version: 'v2' }], ['challenge', { requestId: 'other' }], ['binding', { policyDigest: 'other' }], ['coercion', { utcMilliseconds: '1700000000000' }]])
    it('rejects invalid time evidence: ' + name, () => { const h = clockHarness(); assert.equal(h.sample(extra), false); assert.equal(Number.isNaN(h.clock.nowSeconds()), true); });
  for (const [name, w, m] of [['rollback', -1, 1], ['forward jump', 3000, 1], ['monotonic rollback', 1, -1]])
    it('latches unhealthy on ' + name + ' until a new explicitly authorized runtime', () => {
      const h = clockHarness(); h.sample(); h.move(w, m); assert.equal(Number.isNaN(h.clock.nowSeconds()), true);
      assert.equal(h.sample(), false);
    });
  it('retains rollback history through provider loss and accepts healthy elapsed restart evidence only externally', () => {
    const h = clockHarness(); h.sample(); h.clock.invalidate(); assert.equal(Number.isNaN(h.clock.nowSeconds()), true);
    h.move(-1, 1); assert.equal(h.sample(), false);
    const restarted = clockHarness(); assert.equal(Number.isNaN(restarted.clock.nowSeconds()), true);
    assert.equal(restarted.sample(), true); // Cross-process high-water evidence remains provider responsibility.
  });
});
