const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateHistoryReadRequest: validate } = require('../dist/domain/classification/historyReadContract.js');
const op = (extra = {}) => ({ dataset: 'expenses', operationId: 'abcdef0123456789abcdef01', ...extra });
const request = (extra = {}) => ({ version: 'classification-history-read-request-v1',
  startInclusive: Date.parse('2025-01-01T00:00:00Z'), endExclusive: Date.parse('2026-01-01T00:00:00Z'), operations: [op()], ...extra });
const rejected = input => {
  const r = validate(input); assert.equal(r.ok, false, 'Expected rejection');
  assert.equal(JSON.stringify(r) === '{"ok":false,"error":{"code":"invalid_history_read_request"}}', true, 'Safe code only');
};
describe('disconnected coherent history request proposal (no IO or authority)', () => {
  it('accepts a bounded UTC identity set and canonicalizes IDs without caller aliases', () => {
    const input = request({ operations: [op({ operationId: op().operationId.toUpperCase() }), op({ dataset: 'incomes' })] }), before = JSON.stringify(input);
    const r = validate(input); assert.equal(r.ok, true); assert.equal(r.value.operations.length, 2);
    assert.equal(r.value.operations[0].operationId === op().operationId, true);
    assert.equal(JSON.stringify(input) === before, true); assert.equal(Object.isFrozen(r.value.operations), true);
  });
  for (const [i, input] of [null, {}, request({ version: 'other' }), request({ owner: 'a'.repeat(24) }),
    request({ startInclusive: '2025-01-01' }), request({ startInclusive: Date.parse('2025-01-01T00:00:00.001Z') }),
    request({ startInclusive: NaN }), request({ endExclusive: Date.parse('2025-01-01') }), request({ operations: [] }),
    request({ operations: Array(2) }), request({ operations: Array.from({ length: 101 }, (_, i) => op({ operationId: i.toString(16).padStart(24, '0') })) }),
    request({ operations: [op(), op({ operationId: op().operationId.toUpperCase() })] }),
    request({ operations: [op({ owner: 'a'.repeat(24) })] }), request({ operations: [op({ dataset: 'other' })] }),
    request({ operations: [op({ operationId: 'not-an-id' })] }), Object.create(request()), new Proxy(request(), {}),
  ].entries()) it('rejects invalid proposal case ' + i, () => rejected(input));
  it('rejects accessors/prototypes/revoked proxies without leaking hook errors', () => {
    let calls = 0; const hook = () => { calls++; throw Error('Fictional private exception'); };
    rejected(Object.defineProperty(request(), 'operations', { enumerable: true, get: hook }));
    const array = [op()]; Object.defineProperty(array, '0', { enumerable: true, get: hook }); rejected(request({ operations: array }));
    rejected(request({ operations: [Object.create(op())] }));
    const revoked = Proxy.revocable({}, {}); revoked.revoke(); rejected(revoked.proxy); assert.equal(calls, 0);
  });
  it('accepts exactly 100 unique identities but rejects oversize, hidden and symbolic data', () => {
    assert.equal(validate(request({ operations: Array.from({ length: 100 }, (_, i) => op({ operationId: i.toString(16).padStart(24, '0') })) })).ok, true);
    rejected({ ...request(), [Symbol('unknown')]: 1 }); rejected(Object.defineProperty(request(), 'hidden', { value: 1 }));
  });
});
