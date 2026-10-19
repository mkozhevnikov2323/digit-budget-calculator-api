const assert = require('node:assert/strict');

const owners = ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb'];
const clone = value => structuredClone(value);
const fields = {
  expenses: ['amount', 'date', 'title', 'recipient', 'category', 'comment'],
  incomes: ['source', 'amount', 'date', 'comment'],
};

const fixtures = kind => owners.flatMap((owner, ownerIndex) => {
  const prefix = String((kind === 'expenses' ? 1 : 3) + ownerIndex);
  return [
    { date: '2026-01-05T12:00:00.000Z', createdAt: '2026-01-06T12:00:00.000Z', amount: 12.34 },
    { date: '2026-01-05T12:00:00.000Z', createdAt: '2026-01-07T12:00:00.000Z', amount: 56.78 },
    { date: '2026-02-05T12:00:00.000Z', createdAt: '2026-02-06T12:00:00.000Z', amount: 90.12 },
  ].map((entry, index) => ({
    _id: prefix.repeat(23) + (index + 1), owner, ...entry, comment: 'Synthetic fixture',
    ...(kind === 'expenses' ? {
      title: index === 1 ? 'Synthetic train' : 'Synthetic groceries',
      recipient: index === 1 ? 'Synthetic station' : 'Synthetic shop',
      category: index === 1 ? 'Synthetic Travel' : 'Synthetic Food',
    } : { source: index === 1 ? 'Synthetic Gift' : 'Synthetic Salary' }),
  }));
});

// A deliberately small persistence boundary, not an in-memory MongoDB engine.
// The expected actor comes from the HTTP test independently of the query. Never
// fill in a missing owner: fail before selecting or mutating any fixture.
const createPersistence = () => {
  let actor;
  let rows;
  const calls = [];
  const reset = () => {
    actor = undefined;
    rows = Object.fromEntries(['expenses', 'incomes'].map(kind => {
      const data = fixtures(kind);
      return [kind, [data[5], data[1], data[3], data[2], data[0], data[4]]];
    }));
    calls.length = 0;
  };
  const scope = filter => {
    assert.ok(owners.includes(actor), 'Persistence requires an independently expected HTTP actor');
    assert.ok(filter && Object.hasOwn(filter, 'owner'), 'Missing owner filter');
    assert.equal(filter.owner, actor, 'Query owner must equal the current verified-token actor');
  };
  const capture = (kind, method, args) => {
    const call = { model: kind, method, args: clone(args) };
    calls.push(call);
    return call;
  };
  const matches = (kind, filter) => {
    scope(filter);
    const allowed = ['owner', 'date', ...(kind === 'expenses' ? ['title', 'recipient', 'category'] : ['source'])];
    for (const key of Object.keys(filter)) assert.ok(allowed.includes(key), 'Unsupported test query field');
    return rows[kind].filter(row => Object.entries(filter).every(([key, condition]) => {
      if (key === 'date') {
        for (const operator of Object.keys(condition)) {
          assert.ok(['$gte', '$lte', '$lt'].includes(operator));
          assert.ok(condition[operator] instanceof Date);
          const actual = new Date(row.date).getTime();
          const expected = condition[operator].getTime();
          if (operator === '$gte' && actual < expected) return false;
          if (operator === '$lte' && actual > expected) return false;
          if (operator === '$lt' && actual >= expected) return false;
        }
        return true;
      }
      if (typeof condition === 'object') {
        assert.deepEqual(Object.keys(condition).sort(), ['$options', '$regex']);
        assert.equal(condition.$options, 'i');
        return new RegExp(condition.$regex, condition.$options).test(row[key]);
      }
      return row[key] === condition;
    }));
  };
  const methods = kind => ({
    find(filter) {
      const call = capture(kind, 'find', [filter]);
      const selected = matches(kind, filter);
      call.chain = [];
      let skip = 0;
      let limit;
      const query = {
        sort(order) {
          assert.deepEqual(order, { date: 1, createdAt: 1 });
          call.chain.push(['sort', clone(order)]);
          return query;
        },
        skip(value) { skip = value; call.chain.push(['skip', value]); return query; },
        limit(value) { limit = value; call.chain.push(['limit', value]); return query; },
        lean() { call.chain.push(['lean']); return query; },
        then(resolve, reject) {
          const sorted = [...selected].sort((a, b) =>
            new Date(a.date) - new Date(b.date) || new Date(a.createdAt) - new Date(b.createdAt));
          return Promise.resolve(clone(sorted.slice(skip, limit === undefined ? undefined : skip + limit)))
            .then(resolve, reject);
        },
      };
      return query;
    },
    countDocuments(filter) {
      capture(kind, 'countDocuments', [filter]);
      return Promise.resolve(matches(kind, filter).length);
    },
    create(payload) {
      capture(kind, 'create', [payload]);
      scope(payload);
      assert.deepEqual(Object.keys(payload).sort(), [...fields[kind], 'owner'].sort());
      const record = { _id: String(rows[kind].length + 1).padStart(24, '9'), ...clone(payload) };
      rows[kind].push(record);
      return Promise.resolve(clone(record));
    },
    findOneAndUpdate(filter, payload, options) {
      capture(kind, 'findOneAndUpdate', [filter, payload, options]);
      scope(filter);
      assert.deepEqual(Object.keys(filter).sort(), ['_id', 'owner']);
      assert.deepEqual(Object.keys(payload).sort(), fields[kind].toSorted());
      assert.deepEqual(options, { new: true, runValidators: true });
      const row = rows[kind].find(item => item._id === filter._id && item.owner === filter.owner);
      if (!row) return Promise.resolve(null);
      for (const [key, value] of Object.entries(payload)) if (value !== undefined) row[key] = clone(value);
      return Promise.resolve(clone(row));
    },
    findOneAndDelete(filter) {
      capture(kind, 'findOneAndDelete', [filter]);
      scope(filter);
      assert.deepEqual(Object.keys(filter).sort(), ['_id', 'owner']);
      const index = rows[kind].findIndex(item => item._id === filter._id && item.owner === filter.owner);
      if (index === -1) return Promise.resolve(null);
      return Promise.resolve(clone(rows[kind].splice(index, 1)[0]));
    },
  });
  reset();
  return {
    calls, reset, methods,
    setActor(value) { actor = value; },
    records(kind) { return clone(rows[kind]); },
  };
};

module.exports = { createPersistence, owners, fixtures };
