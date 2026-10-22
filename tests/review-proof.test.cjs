const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv, createDecipheriv } = require('node:crypto');
const { createReviewProofFoundation: create } = require('../dist/domain/classification/reviewProof.js');
const { validateVerifiedReview } = require('../dist/domain/classification/writeCommand.js');
const fixture = require('./fixtures/review-proof-v1.json');

// Public fictional test material. Never include tokens, keys, claims or digests in
// assertion diagnostics (including unexpected-success failures).
const valid = result => { assert.equal(result.ok, true, 'Expected synthetic success'); return result.value; };
const reject = (result, code) => {
  assert.equal(result.ok, false, 'Expected safe rejection');
  assert.equal(JSON.stringify(result) === JSON.stringify({ ok: false, error: { code } }), true, 'Expected code-only failure');
};
const equalPrivate = (a, b) => assert.equal(JSON.stringify(a) === JSON.stringify(b), true, 'Internal projection mismatch');
const key = () => Buffer.from(fixture.keyHex, 'hex');
const ring = () => ({ activeKid: fixture.kid, keys: [{ kid: fixture.kid, state: 'active', key: key() }] });
const command = (extra = {}) => ({ kind: 'manual_classification', dataset: 'expenses',
  operationId: fixture.claims.operationId, state: 'approved',
  assignment: { economicRole: 'ordinary_expense', layer: 'everyday' },
  expectedRevision: null, requestId: fixture.claims.requestId, ...extra });
const context = (extra = {}) => ({ actor: fixture.claims.actor, credentialBinding: fixture.claims.credentialBinding,
  browserReviewContext: fixture.claims.browserReviewContext, credentialExpiresAt: 1700000900, ...extra });
const review = (extra = {}) => ({ kind: 'verified_manual_review', owner: fixture.claims.actor,
  dataset: 'expenses', operationId: fixture.claims.operationId,
  sourceFingerprint: fixture.claims.sourceFingerprint, sourceFingerprintVersion: 1, ...extra });
const absent = state => { const c = command({ state }); delete c.assignment; return c; };
const omit = (x, field) => { const r = { ...x }; delete r[field]; return r; };
const harness = ({ keyring = ring(), deploymentId = fixture.deploymentId, issue = {}, verify = {}, observation = review(), time = 1700000000 } = {}) => {
  const issuance = new WeakMap(), verification = new WeakMap(), handle = Object.freeze(Object.create(null));
  const issueData = { ...context(), ...issue, review: observation }, verifyData = { ...context(), ...verify };
  issuance.set(handle, issueData); verification.set(handle, verifyData);
  let now = time, calls = 0;
  const trust = {
    resolveIssuance(h) { calls++; return issuance.get(h); },
    resolveVerification(h) { calls++; return verification.get(h); },
    nowSeconds: () => now,
  };
  const foundation = valid(create(keyring, deploymentId, trust));
  return { foundation, handle, issueData, verifyData, trust, setTime: n => { now = n; }, calls: () => calls,
    issue: c => foundation.issue(handle, c ?? command()),
    verify: (token, c) => foundation.verify(token, handle, c ?? command()) };
};
const token = h => valid(h.issue()).reviewProof;
// Independent low-level fixture encryption, not the issuer under test. Used to
// authenticate deliberately malformed plaintext so claim validation is exercised.
const encrypt = (plain, { kid = fixture.kid, deploymentId = fixture.deploymentId,
  material = key(), nonce = Buffer.from(fixture.nonceHex, 'hex'), aad } = {}) => {
  const cipher = createCipheriv('aes-256-gcm', material, nonce, { authTagLength: 16 });
  cipher.setAAD(aad ?? Buffer.from(JSON.stringify(['budget-classification-review', 1, deploymentId, kid])));
  const ciphertext = Buffer.concat([cipher.update(Buffer.isBuffer(plain) ? plain : Buffer.from(plain)), cipher.final()]);
  return ['crp1', kid, nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
};
const sealed = claims => encrypt(JSON.stringify(claims));
const changeSegment = (proof, index, transform) => { const p = proof.split('.'); p[index] = transform(p[index]); return p.join('.'); };
const flipByte = s => { const b = Buffer.from(s, 'base64url'); b[0] ^= 1; return b.toString('base64url'); };
const independentlyDecrypt = proof => {
  const p = proof.split('.'), decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(p[2], 'base64url'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(JSON.stringify(['budget-classification-review', 1, fixture.deploymentId, p[1]])));
  decipher.setAuthTag(Buffer.from(p[4], 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(p[3], 'base64url')), decipher.final()]).toString('utf8'));
};

describe('separate read-only recovery verification', () => {
  it('allows expired proof only inside the fixed 24h horizon and never through verify', () => {
    const h = harness({ issue: { credentialExpiresAt: 4102444800 }, verify: { credentialExpiresAt: 4102444800 } });
    const p = valid(h.issue()); h.setTime(1700000300);
    reject(h.verify(p.reviewProof), 'proof_expired');
    const recovered = valid(h.foundation.verifyRecovery(p.reviewProof, h.handle, command()));
    equalPrivate(recovered.review, review()); assert.equal(validateVerifiedReview(recovered).ok, false);
    h.setTime(1700086399); valid(h.foundation.verifyRecovery(p.reviewProof, h.handle, command()));
    h.setTime(1700086400); reject(h.foundation.verifyRecovery(p.reviewProof, h.handle, command()), 'proof_expired');
  });
  it('never relaxes credential expiry, browser binding, intent or GCM authentication for recovery', () => {
    const h = harness(), p = valid(h.issue()); h.setTime(1700000300);
    reject(h.foundation.verifyRecovery(changeSegment(p.reviewProof, 4, flipByte), h.handle, command()), 'invalid_proof');
    reject(h.foundation.verifyRecovery(p.reviewProof, h.handle, command({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })), 'intent_mismatch');
    h.verifyData.browserReviewContext = context().browserReviewContext === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    reject(h.foundation.verifyRecovery(p.reviewProof, h.handle, command()), 'context_mismatch');
    h.verifyData.browserReviewContext = context().browserReviewContext; h.setTime(1700000900);
    reject(h.foundation.verifyRecovery(p.reviewProof, h.handle, command()), 'invalid_context');
  });
});

describe('experimental isolated AEAD review proof (fictional material, no database)', () => {
  it('verifies a literal fixture independently generated with Python cryptography AESGCM', () => {
    equalPrivate(valid(harness().verify(fixture.reviewProof)), review());
  });
  it('issues opaque bounded proofs with fresh CSPRNG nonce and proof ID', () => {
    const h = harness(), first = valid(h.issue()), second = valid(h.issue());
    assert.equal(first.expiresAt, 1700000300);
    assert.equal(first.reviewProof.length <= 4096, true);
    assert.equal(first.reviewProof !== second.reviewProof, true);
    assert.equal(first.reviewProof.split('.')[2] !== second.reviewProof.split('.')[2], true);
    assert.equal(Buffer.from(first.reviewProof.split('.')[2], 'base64url').length, 12);
    assert.equal(Buffer.from(first.reviewProof.split('.')[4], 'base64url').length, 16);
    equalPrivate(valid(h.verify(first.reviewProof)), review());
    equalPrivate(valid(h.verify(second.reviewProof)), review());
    const plain = independentlyDecrypt(first.reviewProof), other = independentlyDecrypt(second.reviewProof);
    assert.equal(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(plain.proofId), true);
    assert.equal(plain.proofId !== other.proofId, true);
    equalPrivate({ ...plain, proofId: fixture.claims.proofId }, fixture.claims);
    for (const marker of [fixture.claims.actor, fixture.claims.sourceFingerprint, fixture.claims.credentialBinding])
      assert.equal(first.reviewProof.includes(marker), false, 'Opaque proof leaked a private marker');
  });
  for (const state of ['cleared', 'explicit_unclassified']) it('supports assignment-free ' + state, () => {
    const h = harness(), c = absent(state), issued = valid(h.issue(c));
    equalPrivate(valid(h.verify(issued.reviewProof, c)), review());
  });
  it('supports stable income and non-spending null-layer assignments', () => {
    for (const [dataset, assignment] of [['incomes', { economicRole: 'ordinary_income', layer: null }],
      ['expenses', { economicRole: 'loan_issuance', layer: null }]]) {
      const h = harness({ observation: review({ dataset }) }), c = command({ dataset, assignment });
      equalPrivate(valid(h.verify(valid(h.issue(c)).reviewProof, c)), review({ dataset }));
    }
  });
  it('caps issuance at verified credential expiry, with no invented missing-exp fallback', () => {
    const h = harness({ issue: { credentialExpiresAt: 1700000001 }, verify: { credentialExpiresAt: 1700000001 } });
    const issued = valid(h.issue()); assert.equal(issued.expiresAt, 1700000001);
    valid(h.verify(issued.reviewProof)); h.setTime(1700000001);
    reject(h.verify(issued.reviewProof), 'invalid_context');
    for (const expiry of [undefined, null, NaN, Infinity, 1700000000, '1700000900', 1700000900.5]) {
      reject(harness({ issue: { credentialExpiresAt: expiry } }).issue(), 'invalid_context');
      reject(harness({ verify: { credentialExpiresAt: expiry } }).verify(fixture.reviewProof), 'invalid_context');
    }
  });
  for (const [name, index] of [['nonce', 2], ['ciphertext', 3], ['authentication tag', 4]])
    it('rejects modified ' + name, () => reject(harness().verify(changeSegment(fixture.reviewProof, index, flipByte)), 'invalid_proof'));
  it('authenticates before parsing any plaintext or consulting trusted context', () => {
    const h = harness(), original = JSON.parse;
    let parses = 0, result;
    try {
      JSON.parse = () => { parses++; throw new Error('Fictional private parse exception'); };
      result = h.verify(changeSegment(fixture.reviewProof, 4, flipByte));
    } finally { JSON.parse = original; }
    reject(result, 'invalid_proof'); assert.equal(parses, 0); assert.equal(h.calls(), 0);
  });
  for (const kid of ['unknown-key', '__proto__', 'test-old-more']) it('rejects unknown exact kid ' + kid, () =>
    reject(harness().verify(changeSegment(fixture.reviewProof, 1, () => kid)), kid === '__proto__' ? 'invalid_token' : 'invalid_proof'));
  it('rejects wrong key material, deployment AAD, purpose AAD and kid AAD', () => {
    reject(harness({ keyring: { activeKid: fixture.kid, keys: [{ kid: fixture.kid, state: 'active', key: Buffer.alloc(32, 99) }] } })
      .verify(fixture.reviewProof), 'invalid_proof');
    reject(harness({ deploymentId: 'other-world' }).verify(fixture.reviewProof), 'invalid_proof');
    for (const tuple of [['wrong-purpose', 1, fixture.deploymentId, fixture.kid],
      ['budget-classification-review', 2, fixture.deploymentId, fixture.kid],
      ['budget-classification-review', 1, fixture.deploymentId, 'other-kid']])
      reject(harness().verify(encrypt(JSON.stringify(fixture.claims), { aad: Buffer.from(JSON.stringify(tuple)) })), 'invalid_proof');
  });
  for (const [field, value] of [['actor', 'b'.repeat(24)], ['credentialBinding', 'c'.repeat(64)],
    ['browserReviewContext', '45678901-4567-4567-b567-45678901abcd']])
    it('rejects different trusted ' + field, () => reject(harness({ verify: { [field]: value } }).verify(fixture.reviewProof), 'context_mismatch'));
  for (const [name, c] of [
    ['operation', command({ operationId: '2'.repeat(24) })],
    ['dataset', command({ dataset: 'incomes', assignment: { economicRole: 'ordinary_income', layer: null } })],
    ['role', command({ assignment: { economicRole: 'loan_issuance', layer: null } })],
    ['layer', command({ assignment: { economicRole: 'ordinary_expense', layer: 'irregular' } })],
    ['state', absent('cleared')], ['revision', command({ expectedRevision: 1 })],
    ['request ID', command({ requestId: '87654321-4321-4321-8321-cba987654321' })],
  ]) it('rejects different intended ' + name, () => reject(harness().verify(fixture.reviewProof, c), 'intent_mismatch'));
  it('expires at the exact admission deadline with no write grace or renewal', () => {
    const h = harness(); h.setTime(1700000299); valid(h.verify(fixture.reviewProof));
    for (const time of [1700000300, 1700000301, 1700000600]) {
      h.setTime(time); reject(h.verify(fixture.reviewProof), 'proof_expired');
    }
  });
  it('enforces future-iat skew inclusively at 30 seconds', () => {
    const h = harness(); h.setTime(1699999970); valid(h.verify(fixture.reviewProof));
    h.setTime(1699999969); reject(h.verify(fixture.reviewProof), 'invalid_time');
  });
  it('rejects proof expiry beyond the current trusted credential expiry', () =>
    reject(harness({ verify: { credentialExpiresAt: 1700000200 } }).verify(fixture.reviewProof), 'invalid_time'));
  for (const time of [undefined, null, -0, -1, 1.5, NaN, Infinity, '1700000000', Number.MAX_SAFE_INTEGER])
    it('rejects invalid explicit clock case ' + String(time), () => {
      const h = harness(); h.setTime(time);
      reject(h.issue(), 'invalid_time'); reject(h.verify(fixture.reviewProof), 'invalid_time');
    });
  it('contains a throwing clock without private exception messages', () => {
    const h = harness(); const trust = { ...h.trust, nowSeconds() { throw new Error('Fictional private clock exception'); } };
    const f = valid(create(ring(), fixture.deploymentId, trust));
    reject(f.issue(h.handle, command()), 'invalid_time'); reject(f.verify(fixture.reviewProof, h.handle, command()), 'invalid_time');
  });
});

describe('strict proof wire and authenticated claims', () => {
  const malformed = [undefined, null, {}, [], new String(fixture.reviewProof), '', 'x'.repeat(4097),
    fixture.reviewProof + '.', '.' + fixture.reviewProof, fixture.reviewProof + '\n',
    changeSegment(fixture.reviewProof, 0, () => 'crp2'), changeSegment(fixture.reviewProof, 1, () => 'Test-old'),
    changeSegment(fixture.reviewProof, 1, () => 'test-old\n'),
    changeSegment(fixture.reviewProof, 1, () => 'a'.repeat(33)),
    ...[2, 3, 4].flatMap(i => ['', 'A', 'abcd=', '+///', 'a b', 'a\nb', 'é'].map(s => changeSegment(fixture.reviewProof, i, () => s))),
    changeSegment(fixture.reviewProof, 2, () => Buffer.alloc(13).toString('base64url')),
    changeSegment(fixture.reviewProof, 3, () => Buffer.alloc(2049).toString('base64url')),
    changeSegment(fixture.reviewProof, 4, () => Buffer.alloc(15).toString('base64url')),
    // Same decoded tag with nonzero unused trailing bits must not be accepted.
    changeSegment(fixture.reviewProof, 4, s => s.slice(0, -1) + 'B'),
  ];
  for (const [i, value] of malformed.entries()) it('rejects malformed bounded wire case ' + i + ' before trust callbacks', () => {
    const h = harness(); reject(h.verify(value), 'invalid_token'); assert.equal(h.calls(), 0);
  });
  for (const field of Object.keys(fixture.claims)) it('rejects missing authenticated claim ' + field, () =>
    reject(harness().verify(sealed(omit(fixture.claims, field))), 'invalid_claims'));
  const invalidClaims = [
    ['proof version', { proofVersion: 2 }], ['purpose', { purpose: 'other' }], ['audience', { audience: 'other' }],
    ['deployment claim', { deploymentId: 'other-world' }, 'context_mismatch'],
    ['proof ID', { proofId: 'not-a-uuid' }], ['UUID case', { proofId: fixture.claims.proofId.toUpperCase() }],
    ['actor', { actor: 'invalid' }], ['actor case', { actor: fixture.claims.actor.toUpperCase() }],
    ['binding', { credentialBinding: 'bad' }], ['browser UUID', { browserReviewContext: 'bad' }],
    ['dataset', { dataset: 'other' }], ['operation', { operationId: fixture.claims.operationId + '\n' }],
    ['fingerprint', { sourceFingerprint: 'bad' }], ['fingerprint version', { sourceFingerprintVersion: 2 }],
    ['taxonomy', { taxonomyVersion: 'financial-layers-v1-provisional' }], ['kind', { kind: 'automatic_classification' }],
    ['state', { state: 'suggested' }], ['role', { assignment: { economicRole: 'ordinary_income', layer: null } }],
    ['layer', { assignment: { economicRole: 'ordinary_expense', layer: 'other' } }],
    ['nested extra', { assignment: { economicRole: 'ordinary_expense', layer: 'everyday', extra: true } }],
    ['revision', { expectedRevision: 0 }], ['request ID', { requestId: 'bad' }],
    ['iat type', { issuedAt: '1700000000' }], ['negative iat', { issuedAt: -1 }],
    ['exp type', { expiresAt: null }], ['fractional exp', { expiresAt: 1700000001.5 }],
    ['lifetime 301', { expiresAt: 1700000301 }], ['zero lifetime', { expiresAt: 1700000000 }],
    ['negative lifetime', { expiresAt: 1699999999 }], ['oversafe exp', { expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['extra financial amount', { amount: 123.45 }], ['extra __proto__', JSON.parse('{"__proto__":{}}')],
    ['extra toJSON', { toJSON: 'forbidden' }],
  ];
  for (const [name, extra, code = 'invalid_claims'] of invalidClaims) it('rejects authenticated invalid ' + name, () =>
    reject(harness().verify(sealed({ ...fixture.claims, ...extra })), code));
  for (const [i, plain] of [
    '{', 'null', '[]', '"string"',
    JSON.stringify(fixture.claims).replace('"proofVersion":1', '"proofVersion":2,"proofVersion":1'),
    JSON.stringify(fixture.claims).replace('"layer":"everyday"', '"layer":"irregular","layer":"everyday"'),
    JSON.stringify(fixture.claims).replace('"sourceFingerprintVersion":1', '"sourceFingerprintVersion":1,"sourceFingerprintVersion":1'),
    ' ' + JSON.stringify(fixture.claims),
    JSON.stringify(fixture.claims).replace('"issuedAt":1700000000', '"issuedAt":1.7e9'),
    Buffer.from([0xff, 0xfe]),
  ].entries()) it('rejects authenticated noncanonical/duplicate/invalid JSON case ' + i, () =>
    reject(harness().verify(encrypt(plain)), 'invalid_claims'));
});

describe('explicit keyring lifecycle and trust boundary', () => {
  const invalidRings = [undefined, null, [], {}, { ...ring(), activeKid: undefined }, { ...ring(), extra: true },
    { ...ring(), activeKid: 'absent' }, { ...ring(), activeKid: null }, { ...ring(), keys: [] },
    { ...ring(), keys: [...ring().keys, ...ring().keys] },
    { ...ring(), keys: [...ring().keys, { kid: 'other', state: 'active', key: key() }] },
    { ...ring(), keys: [{ kid: fixture.kid, state: 'unknown', key: key() }] },
    { activeKid: null, keys: [{ kid: fixture.kid, state: 'disabled', key: key() }] },
    ...[0, 16, 24, 31, 33, 64].map(n => ({ ...ring(), keys: [{ kid: fixture.kid, state: 'active', key: Buffer.alloc(n) }] })),
    ...[undefined, null, fixture.keyHex, Array(32).fill(0), new Uint8Array(32), new Proxy(key(), {})]
      .map(material => ({ ...ring(), keys: [{ kid: fixture.kid, state: 'active', key: material }] })),
    { ...ring(), keys: Array.from({ length: 33 }, (_, i) => ({ kid: 'k' + i, state: 'verify_only', key: key() })) },
    { ...ring(), keys: new Proxy(ring().keys, {}) }, { ...ring(), keys: Array(1) },
    Object.create(ring()), new Proxy(ring(), {}),
  ];
  for (const [i, input] of invalidRings.entries()) it('rejects invalid ring case ' + i + ' safely', () =>
    reject(create(input, fixture.deploymentId, harness().trust), 'invalid_keyring'));
  it('rejects array accessors and decorated keys without executing hooks', () => {
    let calls = 0; const hook = () => { calls++; throw new Error('Fictional private key exception'); };
    const array = ring().keys; Object.defineProperty(array, '0', { enumerable: true, get: hook });
    reject(create({ ...ring(), keys: array }, fixture.deploymentId, harness().trust), 'invalid_keyring');
    const decorated = key(); Object.defineProperty(decorated, 'toJSON', { value: hook });
    reject(create({ ...ring(), keys: [{ kid: fixture.kid, state: 'active', key: decorated }] }, fixture.deploymentId, harness().trust), 'invalid_keyring');
    const input = Object.defineProperty(ring(), 'activeKid', { enumerable: true, get: hook });
    reject(create(input, fixture.deploymentId, harness().trust), 'invalid_keyring');
    assert.equal(calls, 0);
  });
  it('copies caller key bytes and captures key states/config callbacks defensively', () => {
    const material = key(), input = { activeKid: fixture.kid, keys: [{ kid: fixture.kid, state: 'active', key: material }] };
    const h = harness({ keyring: input }), before = token(h);
    material.fill(99); input.activeKid = null; input.keys[0].state = 'disabled'; input.keys.length = 0;
    h.trust.resolveVerification = () => { throw new Error('Replaced callback must not run'); };
    equalPrivate(valid(h.verify(before)), review()); equalPrivate(valid(h.verify(fixture.reviewProof)), review());
    equalPrivate(valid(h.verify(token(h))), review());
    assert.equal(JSON.stringify(h.foundation).includes(fixture.keyHex), false, 'Key material must not be returned');
  });
  it('verifies old keys during explicit rotation, issues only with active key, and rejects revocation', () => {
    const newer = { kid: 'test-new', state: 'active', key: Buffer.alloc(32, 88) };
    const rotated = harness({ keyring: { activeKid: 'test-new', keys: [newer, { kid: fixture.kid, state: 'verify_only', key: key() }] } });
    valid(rotated.verify(fixture.reviewProof)); const fresh = token(rotated);
    assert.equal(fresh.split('.')[1], 'test-new'); valid(rotated.verify(fresh));
    const revoked = harness({ keyring: { activeKid: 'test-new', keys: [newer, { kid: fixture.kid, state: 'disabled' }] } });
    reject(revoked.verify(fixture.reviewProof), 'invalid_proof'); valid(revoked.verify(fresh));
    const onlyVerify = harness({ keyring: { activeKid: null, keys: [{ kid: fixture.kid, state: 'verify_only', key: key() }] } });
    valid(onlyVerify.verify(fixture.reviewProof)); reject(onlyVerify.issue(), 'issuance_unavailable');
  });
  it('requires all trusted ports and explicit deployment; no implicit keys or identity resolvers', () => {
    const h = harness();
    for (const trust of [undefined, null, {}, omit(h.trust, 'nowSeconds'), omit(h.trust, 'resolveIssuance'),
      omit(h.trust, 'resolveVerification'), { ...h.trust, extra: true }, Object.create(h.trust)])
      reject(create(ring(), fixture.deploymentId, trust), 'invalid_configuration');
    for (const dep of [undefined, null, '', 'x'.repeat(129), 'world\n', 'world/path', {}])
      reject(create(ring(), dep, h.trust), 'invalid_configuration');
  });
  it('rejects raw client identity/claim copies instead of treating them as authenticated handles', () => {
    const h = harness();
    for (const value of [undefined, null, fixture.claims.actor, context(), { ...h.issueData }, {}, fixture.claims]) {
      reject(h.foundation.issue(value, command()), 'invalid_context');
      reject(h.foundation.verify(fixture.reviewProof, value, command()), 'invalid_context');
    }
  });
  it('requires prior reviewed observation and refuses wrong identities or unsupported source versions', () => {
    for (const observation of [undefined, null, {}, { ...review(), amount: 123.45 }, review({ sourceFingerprintVersion: 2 }),
      review({ sourceFingerprint: 'invalid' }), Object.create(review())])
      { const h = harness(); h.issueData.review = observation; reject(h.issue(), 'invalid_observation'); }
    for (const observation of [review({ owner: 'b'.repeat(24) }), review({ operationId: '2'.repeat(24) }), review({ dataset: 'incomes' })])
      reject(harness({ observation }).issue(), 'context_mismatch');
  });
  it('rejects getters, inherited data, proxies, hooks, extras and invalid UUIDs in trusted snapshots', () => {
    let calls = 0; const hook = () => { calls++; throw new Error('Fictional private context exception'); };
    const h = harness();
    const invalid = [undefined, null, {}, Object.create(context()), new Proxy(context(), {}),
      { ...context(), browserReviewContext: 'invalid' }, { ...context(), owner: fixture.claims.actor },
      Object.defineProperty(context(), 'actor', { enumerable: true, get: hook }), { ...context(), toJSON: hook }];
    for (const input of invalid) {
      const f = valid(create(ring(), fixture.deploymentId, { ...h.trust, resolveVerification: () => input }));
      reject(f.verify(fixture.reviewProof, h.handle, command()), 'invalid_context');
    }
    const rev = Object.defineProperty(review(), 'sourceFingerprint', { enumerable: true, get: hook });
    reject(harness({ observation: rev }).issue(), 'invalid_observation');
    assert.equal(calls, 0);
  });
  it('rejects invalid manual intent on issue and verification without accessing hooks', () => {
    let calls = 0; const hook = () => { calls++; throw new Error('Fictional private command exception'); };
    for (const c of [null, {}, { ...command(), owner: fixture.claims.actor }, { ...command(), requestId: 'bad' },
      command({ state: 'cleared' }), command({ expectedRevision: 0 }), command({ assignment: { economicRole: 'ordinary_income', layer: null } }),
      Object.create(command()), new Proxy(command(), {}), { ...command(), toJSON: hook },
      Object.defineProperty(command(), 'state', { enumerable: true, get: hook }),
      command({ assignment: new Proxy(command().assignment, {}) })]) {
      const h = harness();
      reject(h.foundation.issue(h.handle, c), 'invalid_command');
      reject(h.foundation.verify(fixture.reviewProof, h.handle, c), 'invalid_command');
    }
    assert.equal(calls, 0);
  });
  it('contains trusted-port exceptions as safe codes without exception data', () => {
    const h = harness(), throws = () => { throw new Error('Fictional private exception with token/password'); };
    const f = valid(create(ring(), fixture.deploymentId, { ...h.trust, resolveIssuance: throws, resolveVerification: throws }));
    reject(f.issue({}, command()), 'invalid_context'); reject(f.verify(fixture.reviewProof, {}, command()), 'invalid_context');
  });
  it('contains CSPRNG failures without exposing native exceptions or fallback nonces', () => {
    const crypto = require('node:crypto'), modulePath = require.resolve('../dist/domain/classification/reviewProof.js');
    const original = crypto.randomBytes, cached = require.cache[modulePath], h = harness();
    let result;
    try {
      crypto.randomBytes = () => { throw new Error('Fictional private RNG exception'); };
      delete require.cache[modulePath];
      const isolated = require(modulePath).createReviewProofFoundation;
      result = valid(isolated(ring(), fixture.deploymentId, h.trust)).issue(h.handle, command());
    } finally {
      crypto.randomBytes = original; delete require.cache[modulePath]; require.cache[modulePath] = cached;
    }
    reject(result, 'crypto_failure');
  });
  it('does not mutate trusted input, intent or ring, and returns frozen owned projections', () => {
    const keyring = ring(), h = harness({ keyring }), c = command();
    const before = JSON.stringify([keyring, h.issueData, h.verifyData, c]);
    const issued = valid(h.issue(c)), verified = valid(h.verify(issued.reviewProof, c));
    assert.equal(JSON.stringify([keyring, h.issueData, h.verifyData, c]) === before, true, 'Input mutation');
    assert.equal(Object.isFrozen(h.foundation), true); assert.equal(Object.isFrozen(issued), true);
    assert.equal(Object.isFrozen(verified), true);
    assert.equal(verified !== h.issueData.review, true);
    h.issueData.review.sourceFingerprint = 'c'.repeat(64); c.assignment.layer = 'irregular';
    assert.equal(verified.sourceFingerprint === fixture.claims.sourceFingerprint, true, 'Mutable alias');
  });
  it('accepts null-prototype data while avoiding inherited serialization hooks', () => {
    const h = harness(), c = Object.assign(Object.create(null), command());
    c.assignment = Object.assign(Object.create(null), c.assignment);
    let calls = 0, issued, verified;
    const before = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    try {
      Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { calls++; throw new Error('Forbidden hook'); } });
      issued = h.issue(c); verified = h.verify(fixture.reviewProof, c);
    } finally { if (before) Object.defineProperty(Object.prototype, 'toJSON', before); else delete Object.prototype.toJSON; }
    valid(issued); valid(verified); assert.equal(calls, 0);
  });
});
