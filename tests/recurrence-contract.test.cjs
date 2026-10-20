const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeRecurrence } = require('../dist/domain/recurrence.js');

const owner = 'aaaaaaaaaaaaaaaaaaaaaaaa', other = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const months = Array.from({ length: 12 }, (_, n) => '2025-' + String(n + 1).padStart(2, '0'));
let serial = 0;
const expense = (day, extra = {}) => ({
  id: 'expense-' + (++serial), ownerId: owner, dataset: 'expenses',
  occurredAt: day + 'T12:00:00.000Z',
  category: { provenance: 'label_only', value: 'Food' },
  title: 'Groceries', recipient: 'Fictional store', ...extra,
});
const income = (day, extra = {}) => ({
  id: 'income-' + (++serial), ownerId: owner, dataset: 'incomes',
  occurredAt: day + 'T12:00:00.000Z', source: 'Salary', ...extra,
});
const run = (operations = [], override = {}) => analyzeRecurrence({
  ownerId: owner, startMonth: '2025-01', endMonthExclusive: '2026-01',
  completeMonths: months, operations, ...override,
});
const matches = (result, level, dataset = 'expenses') => result.observations.filter(
  value => value.group.level === level && value.group.dataset === dataset,
);

describe('pure UTC recurrence observations (synthetic, zero I/O)', () => {
  it('counts fifteen checks in one month as one active month', () => {
    const result = run(Array.from({ length: 15 }, () => expense('2025-03-15')));
    assert.equal(result.state, 'complete');
    assert.equal(matches(result, 'category_or_source')[0].operationCount, 15);
    assert.deepEqual(matches(result, 'category_or_source')[0].activeMonths, ['2025-03']);
    assert.equal(matches(result, 'similar_expense')[0].activeMonthCount, 1);
  });
  it('keeps category-level and particular-payment series independent', () => {
    const ops = months.map((month, i) => expense(month + '-15', {
      title: i ? 'Food' : 'Laptop', recipient: i ? 'Store' : 'Electronics',
    }));
    const result = run(ops);
    assert.equal(matches(result, 'category_or_source')[0].activeMonthCount, 12);
    assert.deepEqual(matches(result, 'similar_expense').map(x => x.activeMonthCount).sort((a,b)=>a-b), [1,11]);
  });
  it('ignores changing amounts for the evidence of a continuing payment', () => {
    const ops = months.slice(0, 3).map((m, i) => expense(m + '-01', {
      amount: 500 + 30 * i, category: { provenance: 'verified_id', value: 'rent-id' },
      title: 'Rent', recipient: 'Fictional landlord',
    }));
    const found = matches(run(ops), 'similar_expense')[0];
    assert.deepEqual(found.intervalsInMonths, [1,1]);
    assert.equal(found.longestConsecutiveMonths, 3);
  });
  it('does not collapse label-only and verified IDs with identical text', () => {
    const result = run([
      expense('2025-01-01', { category: { provenance: 'verified_id', value: 'Food' } }),
      expense('2025-02-01', { category: { provenance: 'label_only', value: 'Food' } }),
    ]);
    assert.equal(matches(result, 'category_or_source').length, 2);
  });
  it('does not invent identity for uncategorized expenses or missing descriptors', () => {
    const result = run([expense('2025-01-01', { category: null }),
      expense('2025-02-01', { title: '', recipient: '' })]);
    assert.equal(matches(result, 'category_or_source').length, 1);
    assert.equal(matches(result, 'similar_expense').length, 0);
  });
  it('never merges income and expense IDs and never invents an income payer', () => {
    const result = run([income('2025-01-01', { id: 'same' }),
      expense('2025-01-01', { id: 'same' })]);
    assert.equal(matches(result, 'category_or_source').length, 1);
    assert.equal(matches(result, 'category_or_source', 'incomes').length, 1);
    assert.equal(matches(result, 'similar_expense', 'incomes').length, 0);
  });
  it('reports gaps and streaks but no unapproved classification labels', () => {
    const result = run(['2025-01-01','2025-03-01','2025-04-01','2025-05-01'].map(expense));
    const evidence = matches(result, 'similar_expense')[0];
    assert.deepEqual(evidence.intervalsInMonths, [2,1,1]);
    assert.equal(evidence.longestConsecutiveMonths, 3);
    assert.equal(Object.hasOwn(evidence, 'regularity'), false);
    assert.equal(Object.hasOwn(evidence, 'economicRole'), false);
  });
  it('handles December/January gaps and a real leap-day UTC timestamp', () => {
    assert.deepEqual(matches(run([expense('2025-01-01'), expense('2025-12-31')]),
      'similar_expense')[0].intervalsInMonths, [11]);
    const leap = analyzeRecurrence({ ownerId: owner, startMonth: '2024-02',
      endMonthExclusive: '2024-04', completeMonths: ['2024-02','2024-03'],
      operations: [expense('2024-02-29')] });
    assert.deepEqual(matches(leap, 'category_or_source')[0].activeMonths, ['2024-02']);
  });
  it('refuses to treat incomplete history as observed zeros', () => {
    const result = run([expense('2025-01-01')], { completeMonths: months.filter(x => x !== '2025-02') });
    assert.equal(result.state, 'insufficient_coverage');
    assert.deepEqual(result.missingMonths, ['2025-02']);
    assert.deepEqual(result.observations, []);
  });
  it('rejects duplicate, outside, and invalid coverage markers', () => {
    assert.throws(() => run([], { completeMonths: [...months, months[0]] }), /coverage/);
    assert.throws(() => run([], { completeMonths: [...months, '2026-01'] }), /coverage/);
    assert.throws(() => run([], { completeMonths: ['2025-99'] }), /month/);
  });
  it('rejects future/older events and invalid or offset timestamps', () => {
    assert.throws(() => run([expense('2026-01-01')]), /outside/);
    assert.throws(() => run([expense('2024-12-31')]), /outside/);
    assert.throws(() => run([expense('2025-02-30')]), /timestamp/);
    assert.throws(() => run([expense('2025-01-01',
      { occurredAt: '2025-01-01T00:00:00+02:00' })]), /timestamp/);
  });
  it('rejects cross-owner operation snapshots', () => {
    assert.throws(() => run([expense('2025-01-01', { ownerId: other })]), /owner/);
  });
  it('rejects duplicate IDs per dataset without conflating incomes and expenses', () => {
    assert.throws(() => run([expense('2025-01-01', { id: 'dup' }),
      expense('2025-02-01', { id: 'dup' })]), /Duplicate/);
    assert.equal(run([expense('2025-01-01', { id: 'same' }),
      income('2025-01-01', { id: 'same' })]).state, 'complete');
  });
  it('rejects empty, reversed, and unbounded time ranges', () => {
    assert.throws(() => run([], { startMonth: '2026-01' }), /window/);
    assert.throws(() => run([], { startMonth: '0000-01' }), /month/);
    assert.throws(() => run([], { startMonth: '2010-01' }), /window/);
  });
  it('is invariant under permutation of operations and coverage', () => {
    const ops = [expense('2025-01-01'), expense('2025-02-01'), income('2025-04-01')];
    assert.deepEqual(run(ops), run([...ops].reverse(), { completeMonths: [...months].reverse() }));
  });
  it('never mutates input arrays and object fixtures', () => {
    const operations = Object.freeze([Object.freeze(expense('2025-01-01'))]);
    assert.equal(run(operations, { completeMonths: Object.freeze([...months]) }).state, 'complete');
    assert.equal(operations.length, 1);
  });
  it('returns empty observed groups only for a complete verified empty history', () => {
    const result = run();
    assert.equal(result.state, 'complete');
    assert.deepEqual(result.missingMonths, []);
    assert.deepEqual(result.observations, []);
  });
});
