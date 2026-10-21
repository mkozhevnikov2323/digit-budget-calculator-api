const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { SOURCE_FINGERPRINT_VERSION, fingerprintSourceOperation: fingerprint,
  validateSourceFingerprint: validateDigest, compareSourceFingerprints: compare } =
  require('../dist/domain/classification/sourceFingerprint.js');
const { PROVISIONAL_TAXONOMY_VERSION, validateClassificationDecision } = require('../dist/domain/classification.js');

const owner = 'aaaaaaaaaaaaaaaaaaaaaaaa', operationId = '111111111111111111111111';
const expense = (extra = {}) => ({ owner, operationId, dataset: 'expenses', amount: 123.45,
  date: new Date(1736942400000), category: 'Транспорт', title: 'Fuel', recipient: 'Fictional station', ...extra });
const income = (extra = {}) => ({ owner, operationId, dataset: 'incomes', amount: 0.1,
  date: new Date(1709164800000), source: 'Synthetic salary', comment: null, ...extra });
const without = (value, key) => { const result = { ...value }; delete result[key]; return result; };
const result = (input) => {
  const value = fingerprint(input, SOURCE_FINGERPRINT_VERSION);
  assert.equal(value.ok, true, 'Expected valid synthetic source facts');
  return value.value;
};
const rejected = (input, code) =>
  assert.deepEqual(fingerprint(input, SOURCE_FINGERPRINT_VERSION), { ok: false, error: { code } });
const envelope = (sourceFingerprint = 'a'.repeat(64), sourceFingerprintVersion = 1) =>
  ({ sourceFingerprint, sourceFingerprintVersion });

// Independent fixed vectors computed with Python hashlib.sha256 + struct.pack('>d')
// and compact UTF-8 JSON (ensure_ascii=False). Expected digests are literals: the
// tests never use the implementation or a second JS canonicalizer to derive them.
const vectors = [
  ['expense absent comment', () => expense(), 'fdec7e25d68576ccb8351eec42cf6c4f2b2ffc19f3e9998cea2e5f5a82299064'],
  ['income null comment', () => income(), '200a325ca28f3392b893e35d9da13b4411fd6f1fd59b7974954078c67539a82a'],
  ['positive zero at epoch', () => expense({ amount: +0, date: new Date(0) }), '04bc16d10ba508ad3c413837c82b19f9e2fca614af60d7ff73cb93096bb540a0'],
  ['negative zero at epoch', () => expense({ amount: -0, date: new Date(0) }), '1c0791cd7f2bf328d04864d7e57af66b2a86b3ac7617bcc9791f86dcce218f58'],
  ['fraction literal', () => expense({ amount: 0.3 }), '6460a81a8c4a30a1265beca6bc7050fafedd13f6f035749ffae4a5626d45cb77'],
  ['fraction sum', () => expense({ amount: 0.1 + 0.2 }), '5f5853c0af404dbac481b339a62d2025dc355129e377fffae409be0ba3a00bed'],
  ['NFC comment', () => expense({ comment: '\u00e9' }), 'e7f8f5a9fae8849dabdad4482c10035b0d9eb2f464154e0261e372583e4dda72'],
  ['NFD comment', () => expense({ comment: 'e\u0301' }), 'c7c8ab1c07b147cf8527bcea15c545fe120c44ab8d622cd0b61f2e09598f53b4'],
];

describe('experimental RFC source fingerprint v1 (synthetic, no IO)', () => {
  for (const [name, facts, digest] of vectors) {
    it(`matches independent fixed vector: ${name}`, () => {
      assert.deepEqual(result(facts()), envelope(digest));
    });
  }
  for (const [field, value] of [
    ['owner', 'bbbbbbbbbbbbbbbbbbbbbbbb'], ['operationId', '222222222222222222222222'],
    ['amount', 123.45000000000002], ['date', new Date(1736942400001)],
    ['category', 'Other category'], ['title', 'Repair'], ['recipient', 'Fictional workshop'], ['comment', 'Edited'],
  ]) {
    it(`detects a change to expense ${field}`, () => {
      assert.notEqual(result(expense()).sourceFingerprint, result(expense({ [field]: value })).sourceFingerprint);
    });
  }
  for (const [field, value] of [
    ['owner', 'bbbbbbbbbbbbbbbbbbbbbbbb'], ['operationId', '222222222222222222222222'],
    ['amount', 0.10000000000000002], ['date', new Date(1709164800001)],
    ['source', 'Different synthetic source'], ['comment', 'Edited'],
  ]) {
    it(`detects a change to income ${field}`, () => {
      assert.notEqual(result(income()).sourceFingerprint, result(income({ [field]: value })).sourceFingerprint);
    });
  }
  it('separates datasets with otherwise matching identities, amount, date and text', () => {
    const outgoing = expense({ category: '', title: '', recipient: 'Same', comment: null });
    const incoming = income({ amount: outgoing.amount, date: new Date(outgoing.date.getTime()), source: 'Same' });
    assert.notEqual(result(outgoing).sourceFingerprint, result(incoming).sourceFingerprint);
  });
  it('canonicalizes ObjectId case only, preserving C2.1 syntax checks', () => {
    assert.deepEqual(result(expense({ operationId: 'abcdef0123456789abcdef01' })),
      result(expense({ owner: owner.toUpperCase(), operationId: 'ABCDEF0123456789ABCDEF01' })));
    rejected(expense({ owner: owner + '\n' }), 'invalid_owner');
    rejected(expense({ operationId: ' ' + operationId }), 'invalid_operation_id');
  });
  it('distinguishes absent, null and empty comments for both datasets', () => {
    for (const facts of [expense, income]) {
      const base = without(facts(), 'comment');
      const hashes = [base, { ...base, comment: null }, { ...base, comment: '' }].map(x => result(x).sourceFingerprint);
      assert.equal(new Set(hashes).size, 3);
      rejected({ ...base, comment: undefined }, 'invalid_comment');
    }
  });
  it('preserves case, whitespace, empty strings and Unicode normalization in every source string', () => {
    for (const [facts, fields] of [[expense, ['category', 'title', 'recipient', 'comment']], [income, ['source', 'comment']]]) {
      for (const field of fields) {
        const variants = ['text', 'Text', ' text ', '', '\u00e9', 'e\u0301'];
        assert.equal(new Set(variants.map(value => result(facts({ [field]: value })).sourceFingerprint)).size, variants.length);
      }
    }
  });
  it('does not collapse escaped strings, delimiter-like text or lone surrogates', () => {
    const values = ['a,b', 'a","b', 'a\nb', 'a\\nb', '\u2028', '\ud800', '\ufffd', '\u0000'];
    assert.equal(new Set(values.map(comment => result(expense({ comment })).sourceFingerprint)).size, values.length);
    assert.notEqual(result(expense({ title: 'a', recipient: 'b,c' })).sourceFingerprint,
      result(expense({ title: 'a,b', recipient: 'c' })).sourceFingerprint);
  });
  it('preserves adjacent fractional binary64 values without rounding or kopeck conversion', () => {
    const values = [0.3, 0.1 + 0.2, 0.3000000000000001, Number.MIN_VALUE, 0, Number.MAX_VALUE];
    assert.equal(new Set(values.map(amount => result(expense({ amount })).sourceFingerprint)).size, values.length);
    assert.notEqual(result(expense({ amount: +0 })).sourceFingerprint, result(expense({ amount: -0 })).sourceFingerprint);
  });
  it('uses UTC epoch milliseconds, including negative and extreme valid dates', () => {
    const dates = [new Date(-1), new Date(0), new Date(1), new Date(-8640000000000000), new Date(8640000000000000)];
    assert.equal(new Set(dates.map(date => result(expense({ date })).sourceFingerprint)).size, dates.length);
    assert.deepEqual(result(expense({ date: new Date('2025-01-15T12:00:00.000Z') })),
      result(expense({ date: new Date('2025-01-15T15:00:00.000+03:00') })));
  });
  it('rejects invalid, coerced and unsupported amount representations', () => {
    for (const amount of [undefined, null, -1, NaN, Infinity, -Infinity, '123.45', 1n,
      new Number(1), {}, [], { _bsontype: 'Decimal128', toString: () => '1' },
      { _bsontype: 'Long', low: 1, high: 0 }]) rejected(expense({ amount }), 'invalid_amount');
    rejected(without(expense(), 'amount'), 'invalid_amount');
  });
  it('rejects non-Date, invalid Date, subclassed, proxied and decorated date representations', () => {
    const decorated = new Date(0); decorated.extra = 'synthetic-private-marker';
    for (const date of [undefined, null, 0, '2025-01-15T12:00:00Z', {}, [], new Date(NaN),
      new Date(8640000000000001), new (class SpecialDate extends Date {})(0),
      Object.create(Date.prototype), new Proxy(new Date(0), {}), decorated]) rejected(expense({ date }), 'invalid_date');
    rejected(without(expense(), 'date'), 'invalid_date');
  });
  it('rejects malformed and missing identities and datasets', () => {
    for (const [field, code] of [['owner', 'invalid_owner'], ['operationId', 'invalid_operation_id']]) {
      for (const value of [undefined, null, '', 1, {}, new String(owner), 'g'.repeat(24), 'a'.repeat(23),
        'a'.repeat(25), owner + '\n', owner.slice(0, 23) + '\n']) rejected(expense({ [field]: value }), code);
      rejected(without(expense(), field), code);
    }
    for (const dataset of [undefined, null, '', 'expense', 'Expenses', ['incomes'], 1])
      rejected(expense({ dataset }), 'invalid_dataset');
  });
  it('rejects missing and non-string required fields and unsupported comments', () => {
    for (const [facts, fields] of [[expense, ['category', 'title', 'recipient']], [income, ['source']]]) {
      for (const field of fields) {
        rejected(without(facts(), field), 'invalid_source_string');
        for (const value of [undefined, null, 1, false, [], {}, new String('text')])
          rejected(facts({ [field]: value }), 'invalid_source_string');
      }
      for (const comment of [undefined, 1, false, [], {}, new String('text')]) rejected(facts({ comment }), 'invalid_comment');
    }
  });
  it('rejects primitives, arrays, arbitrary document instances and inherited facts', () => {
    for (const input of [undefined, null, true, 1, 1n, 'facts', [], [expense()], () => expense(),
      new Date(0), new Map(), Object.create(expense()), new (class Document {
        constructor() { Object.assign(this, expense()); }
      })()]) rejected(input, 'invalid_object');
    rejected({}, 'invalid_owner');
  });
  it('rejects unexpected keys, symbols, operators, storage and classification metadata', () => {
    for (const key of ['unknown', '__proto__', 'constructor', 'prototype', '$set', 'toJSON',
      '_id', '__v', 'updatedAt', 'createdAt', 'assignment', 'state', 'taxonomyVersion',
      'sourceFingerprintVersion', 'sourceFingerprint']) {
      rejected({ ...expense(), ...Object.fromEntries([[key, 'synthetic-private-marker']]) }, 'unexpected_field');
    }
    rejected({ ...expense(), [Symbol('private')]: true }, 'unexpected_field');
    rejected(expense({ source: 'Income-only field' }), 'unexpected_field');
    rejected(income({ category: 'Expense-only field' }), 'unexpected_field');
  });
  it('does not call accessors, coercion methods or own toJSON hooks', () => {
    let calls = 0;
    const hook = () => { calls++; throw new Error('synthetic-private-marker'); };
    for (const field of Object.keys(expense()))
      rejected(Object.defineProperty(expense(), field, { enumerable: true, get: hook }), 'invalid_object');
    rejected({ ...expense(), toJSON: hook }, 'unexpected_field');
    rejected(expense({ amount: { valueOf: hook, toJSON: hook } }), 'invalid_amount');
    rejected(expense({ owner: { toString: hook } }), 'invalid_owner');
    rejected(expense({ comment: { toString: hook } }), 'invalid_comment');
    const date = Object.defineProperty(new Date(0), 'getTime', { get: hook });
    rejected(expense({ date }), 'invalid_date');
    const dateJson = Object.defineProperty(new Date(0), 'toJSON', { value: hook });
    rejected(expense({ date: dateJson }), 'invalid_date');
    assert.equal(calls, 0);
  });
  it('does not invoke inherited toJSON when encoding newly owned canonical tuples', () => {
    const before = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    let calls = 0, actual;
    try {
      Object.defineProperty(Object.prototype, 'toJSON', { configurable: true,
        value() { calls++; throw new Error('synthetic-private-marker'); } });
      actual = fingerprint(expense(), 1);
    } finally {
      if (before) Object.defineProperty(Object.prototype, 'toJSON', before);
      else delete Object.prototype.toJSON;
    }
    assert.equal(calls, 0);
    assert.deepEqual(actual, { ok: true, value: envelope(vectors[0][2]) });
  });
  it('rejects hidden fields and safely contains throwing/revoked reflection proxies', () => {
    rejected(Object.defineProperty(expense(), 'amount', { enumerable: false }), 'invalid_object');
    rejected(new Proxy({}, { getPrototypeOf() { throw new Error('synthetic-private-marker'); } }), 'invalid_object');
    rejected(new Proxy(expense(), { getOwnPropertyDescriptor() { throw new Error('synthetic-private-marker'); } }), 'invalid_object');
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    rejected(revoked.proxy, 'invalid_object');
  });
  it('preserves input objects and dates on success and failure without mutable aliases', () => {
    const input = expense({ comment: 'Synthetic comment' }), before = structuredClone(input);
    const output = result(input);
    assert.equal(isDeepStrictEqual(input, before), true);
    assert.equal(Object.isFrozen(input), false);
    assert.equal(Object.isFrozen(input.date), false);
    assert.deepEqual(Object.keys(output).sort(), ['sourceFingerprint', 'sourceFingerprintVersion']);
    assert.equal(Object.isFrozen(output), true);
    input.date.setTime(0); input.amount = 1; input.comment = 'Changed';
    assert.notEqual(result(input).sourceFingerprint, output.sourceFingerprint);
    const bad = expense({ amount: -1 }), badBefore = structuredClone(bad);
    rejected(bad, 'invalid_amount');
    assert.equal(isDeepStrictEqual(bad, badBefore), true);
    result(Object.freeze(expense({ date: Object.freeze(new Date(0)) })));
    result(Object.assign(Object.create(null), expense()));
  });
  it('is deterministic independent of input field order and previous failed calls', () => {
    const input = expense(), expected = result(input);
    for (let i = 0; i < 3; i++) {
      rejected(expense({ amount: 'synthetic-private-marker' }), 'invalid_amount');
      assert.deepEqual(result(input), expected);
      assert.deepEqual(result(Object.fromEntries(Object.entries(input).reverse())), expected);
    }
  });
  it('requires an explicitly supported version without coercion or fallback', () => {
    for (const version of [undefined, null, '', '1', 0, 2, -1, NaN, Infinity, 1n, {}, new Number(1)])
      assert.deepEqual(fingerprint(expense(), version), { ok: false, error: { code: 'unsupported_fingerprint_version' } });
    assert.deepEqual(fingerprint(expense()), { ok: false, error: { code: 'unsupported_fingerprint_version' } });
  });
  it('compares only valid supported fingerprints and distinguishes matches from mismatches', () => {
    const a = result(expense()), b = result(income());
    assert.deepEqual(compare(a, { ...a }), { ok: true, value: { matches: true } });
    assert.deepEqual(compare(a, b), { ok: true, value: { matches: false } });
    assert.deepEqual(compare(b, a), compare(a, b));
    assert.deepEqual(validateDigest(a), { ok: true, value: a });
    const before = { ...a }; compare(a, b);
    assert.equal(isDeepStrictEqual(a, before), true);
  });
  it('rejects invalid digest representations and unsupported envelope versions on either side', () => {
    const good = result(expense());
    const bad = [
      [null, 'invalid_object'], [[], 'invalid_object'], [{}, 'unsupported_fingerprint_version'],
      [envelope('a'.repeat(64), 2), 'unsupported_fingerprint_version'],
      [envelope('a'.repeat(64), '1'), 'unsupported_fingerprint_version'],
      [{ ...good, extra: true }, 'unexpected_field'],
      [Object.create(good), 'invalid_object'],
    ];
    for (const digest of [undefined, null, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64),
      'A'.repeat(64), 'a'.repeat(64) + '\n', 1, {}, new String('a'.repeat(64))])
      bad.push([{ sourceFingerprint: digest, sourceFingerprintVersion: 1 }, 'invalid_fingerprint']);
    for (const [value, code] of bad) {
      const error = { ok: false, error: { code } };
      assert.deepEqual(validateDigest(value), error);
      assert.deepEqual(compare(value, good), error);
      assert.deepEqual(compare(good, value), error);
    }
  });
  it('does not execute comparison-envelope getters or return partial/private errors', () => {
    let calls = 0;
    const bad = Object.defineProperty(envelope(), 'sourceFingerprint', { enumerable: true,
      get() { calls++; throw new Error('synthetic-private-marker'); } });
    assert.deepEqual(compare(bad, envelope()), { ok: false, error: { code: 'invalid_object' } });
    assert.equal(calls, 0);
  });
  it('cannot detect A to B to A history from equal observed facts', () => {
    const a = result(expense()), b = result(expense({ amount: 1 })), restored = result(expense());
    assert.deepEqual(compare(a, b), { ok: true, value: { matches: false } });
    assert.deepEqual(compare(a, restored), { ok: true, value: { matches: true } });
  });
  it('editing fuel changes its hash without changing or approving Transport classifications', () => {
    const fuel = expense(), repair = expense({ operationId: '222222222222222222222222', title: 'Repair' });
    const decisionFor = (facts, layer) => ({ owner: facts.owner, dataset: facts.dataset, operationId: facts.operationId,
      taxonomyVersion: PROVISIONAL_TAXONOMY_VERSION, decisionOrigin: 'manual', decisionRevision: 1, state: 'approved',
      assignment: { economicRole: 'ordinary_expense', layer } });
    const decisions = [decisionFor(fuel, 'everyday'), decisionFor(repair, 'irregular')];
    const before = structuredClone(decisions), fuelHash = result(fuel), repairHash = result(repair);
    assert.equal(fuel.category, repair.category);
    assert.equal(decisions.every(value => validateClassificationDecision(value).ok), true);
    const edited = result({ ...fuel, amount: 130 });
    assert.deepEqual(compare(fuelHash, edited), { ok: true, value: { matches: false } });
    assert.deepEqual(result(repair), repairHash);
    assert.equal(isDeepStrictEqual(decisions, before), true);
    assert.deepEqual(decisions.map(value => value.assignment.layer), ['everyday', 'irregular']);
    assert.deepEqual(Object.keys(edited).sort(), ['sourceFingerprint', 'sourceFingerprintVersion']);
    const unreviewed = { state: 'unreviewed' }; result(fuel);
    assert.deepEqual(unreviewed, { state: 'unreviewed' });
  });
});
