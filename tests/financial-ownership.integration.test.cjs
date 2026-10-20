const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createHarness } = require('./helpers/mongodb-integration.cjs');

const owners = ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb'];
const emptyOwner = 'cccccccccccccccccccccccc';
const secret = 'super-secret-key'; // Existing public development signing behavior.
const sign = (payload, key = secret) => jwt.sign(payload, key, { noTimestamp: true });
const tokens = Object.fromEntries([...owners, emptyOwner].map(owner => [owner, sign({ _id: owner, exp: 4102444800 })]));
const wire = value => JSON.parse(JSON.stringify(value));
const messages = {
  expenses: { missing: 'Расход не найден', deleted: 'Расход успешно удалён' },
  incomes: { missing: 'Доход не найден', deleted: 'Доход успешно удалён' },
};
const bodies = {
  expenses: { amount: 23.45, date: '2026-01-15T12:00:00.000Z', title: 'Synthetic title',
    recipient: 'Synthetic recipient', category: 'Synthetic category', comment: 'Synthetic create' },
  incomes: { amount: 67.89, date: '2026-01-15T12:00:00.000Z', source: 'Synthetic source', comment: 'Synthetic create' },
};
const fixtureId = (kind, owner, index) => {
  const prefix = ['1a', '2b', '3c', '4d'][(kind === 'expenses' ? 0 : 2) + owners.indexOf(owner)];
  return prefix.repeat(11) + prefix[1] + (index + 1);
};

// Only this suite opens MongoDB. No persistence/controller/auth doubles, bootstrap,
// login calls, user accounts or external service requests are involved.
describe('real MongoDB financial ownership through compiled Express', { concurrency: false, timeout: 120000 }, () => {
  let harness;
  let mongoose;
  let models;
  const objectId = value => new mongoose.Types.ObjectId(value);
  const raw = (kind, id) => models[kind].collection.findOne({ _id: objectId(id) });
  const ownRows = (kind, owner, indices = [1, 0, 2]) => Promise.all(indices.map(index => raw(kind, fixtureId(kind, owner, index))));
  const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(models).map(async ([kind, Model]) => {
    const documents = await Model.collection.find({}).sort({ _id: 1 }).toArray();
    // Compare BSON bytes, including owner, __v and timestamps, on rejected writes.
    return [kind, documents.map(document => mongoose.mongo.BSON.serialize(document))];
  })));
  const request = (owner, method, endpoint, body, token = tokens[owner]) => harness.request(method, endpoint, body, token);
  const json = (response, status, expected) => {
    assert.equal(response.status, status);
    assert.match(response.contentType, /application\/json/);
    assert.deepEqual(response.body, wire(expected));
  };
  const validation = (response, segment, key) => {
    assert.equal(response.status, 400);
    assert.equal(response.body.statusCode, 400);
    assert.equal(response.body.error, 'Bad Request');
    assert.equal(response.body.message, 'Validation failed');
    assert.equal(response.body.validation[segment].source, segment);
    assert.deepEqual(response.body.validation[segment].keys, [key]);
  };
  const read = async (kind, owner, query, indices, page = 1, limit = 20, total = indices.length) => {
    const response = await request(owner, 'GET', `/${kind}${query ? `?${query}` : ''}`);
    json(response, 200, { total, page, limit, [kind]: await ownRows(kind, owner, indices) });
    for (const document of response.body[kind]) {
      assert.equal(document.owner, owner);
      assert.equal(typeof document._id, 'string');
      assert.equal(Object.hasOwn(document, '$__'), false);
    }
    return response;
  };

  before(async () => {
    harness = await createHarness(process.env);
    ({ mongoose, models } = harness);
  });
  beforeEach(async () => {
    harness.assertDatabase();
    for (const [kind, Model] of Object.entries(models)) {
      await Model.deleteMany({}); // Guarded, unique, test-process-owned database only.
      const fixtures = owners.flatMap((owner, ownerIndex) => [
        { date: '2026-01-05T12:00:00.000Z', createdAt: '2026-01-07T12:00:00.000Z', amount: 12.34 },
        { date: '2026-01-05T12:00:00.000Z', createdAt: '2026-01-06T12:00:00.000Z', amount: 56.78 },
        { date: '2026-02-05T12:00:00.000Z', createdAt: '2026-02-06T12:00:00.000Z', amount: 90.12 },
      ].map((entry, index) => ({
        _id: objectId(fixtureId(kind, owner, index)), owner: objectId(owner),
        date: new Date(entry.date), createdAt: new Date(entry.createdAt), updatedAt: new Date(entry.createdAt),
        amount: entry.amount + ownerIndex * 100, comment: 'Synthetic fixture',
        ...(kind === 'expenses' ? { title: index === 1 ? 'Synthetic train' : 'Synthetic groceries',
          recipient: index === 1 ? 'Synthetic station' : 'Synthetic shop',
          category: index === 1 ? 'Synthetic Travel' : 'Synthetic Food' }
          : { source: index === 1 ? 'Synthetic Gift' : 'Synthetic Salary' }),
      })));
      await Model.create([fixtures[5], fixtures[0], fixtures[3], fixtures[2], fixtures[1], fixtures[4]]);
    }
  });
  after(async () => {
    if (!harness) return; // Failed setup cleans its own partially opened resources.
    const result = await harness.close();
    assert.deepEqual(result, { dropped: true, disconnected: true, listenerClosed: true,
      logsClosed: true, directoryRemoved: true, environmentRestored: true });
    console.info('Owned generated MongoDB database dropped and verified empty; connection, listener, logs, cwd and environment released.');
  });

  it('uses real ObjectId storage, compiled models/controllers/routes and a live standalone connection', async () => {
    assert.equal(mongoose.connection.readyState, 1);
    assert.equal(mongoose.connection.name, harness.databaseName);
    assert.match(harness.databaseName, /^budget_ownership_it_[a-f0-9]{32}$/);
    for (const kind of ['expenses', 'incomes']) {
      assert.ok(require.cache[require.resolve(`../dist/controllers/${kind}.js`)]);
      assert.ok(require.cache[require.resolve(`../dist/routes/${kind}.js`)]);
      assert.equal(await models[kind].countDocuments({}), 6);
      const document = await raw(kind, fixtureId(kind, owners[0], 0));
      assert.ok(document._id instanceof mongoose.Types.ObjectId);
      assert.ok(document.owner instanceof mongoose.Types.ObjectId);
    }
    assert.equal(require.cache[require.resolve('../dist/server.js')], undefined);
  });

  for (const kind of ['expenses', 'incomes']) {
    describe(kind, { concurrency: false }, () => {
      for (const [index, owner] of owners.entries()) {
        const label = index === 0 ? 'A' : 'B';
        const foreign = owners[1 - index];
        it(`${label}: default GET sorts date/createdAt and counts only owned records`, () => read(kind, owner, '', [1, 0, 2]));
        it(`${label}: page two returns the owned row with owner-specific total`, () => read(kind, owner, 'page=2&limit=1', [0], 2, 1, 3));
        it(`${label}: noPagination returns all and only owned records in deterministic order`, () => read(kind, owner, 'noPagination=true', [1, 0, 2], 1, 3));
        it(`${label}: creates a real document owned by the JWT identity with an empty 201 response`, async () => {
          const before = await snapshot();
          const response = await request(owner, 'POST', `/${kind}`, bodies[kind]);
          assert.equal(response.status, 201); assert.equal(response.text, '');
          const created = await models[kind].collection.findOne({ comment: bodies[kind].comment });
          assert.ok(created._id instanceof mongoose.Types.ObjectId);
          assert.ok(created.owner instanceof mongoose.Types.ObjectId);
          assert.equal(String(created.owner), owner);
          for (const [field, value] of Object.entries(bodies[kind])) {
            assert.deepEqual(created[field], field === 'date' ? new Date(value) : value);
          }
          assert.equal(await models[kind].countDocuments({ owner: objectId(owner) }), 4);
          const after = await snapshot();
          assert.deepEqual(after[kind].filter(bytes => !bytes.equals(mongoose.mongo.BSON.serialize(created))), before[kind]);
          assert.deepEqual(after[kind === 'expenses' ? 'incomes' : 'expenses'], before[kind === 'expenses' ? 'incomes' : 'expenses']);
        });
        it(`${label}: updates the owned document and returns its persisted shape`, async () => {
          const id = fixtureId(kind, owner, 0);
          const foreignBefore = await raw(kind, fixtureId(kind, foreign, 0));
          const before = await raw(kind, id);
          const body = { amount: 45.67, comment: 'Synthetic update' };
          const response = await request(owner, 'PATCH', `/${kind}/${id}`, body);
          const persisted = await raw(kind, id);
          json(response, 200, persisted);
          assert.equal(persisted.amount, body.amount); assert.equal(persisted.comment, body.comment);
          assert.equal(String(persisted.owner), owner);
          for (const field of Object.keys(before).filter(field => !['amount', 'comment', 'updatedAt'].includes(field))) {
            assert.deepEqual(persisted[field], before[field]);
          }
          assert.deepEqual(await raw(kind, fixtureId(kind, foreign, 0)), foreignBefore);
          assert.equal(await models[kind].countDocuments({}), 6);
        });
        it(`${label}: deletes only the owned document and keeps the exact success contract`, async () => {
          const id = fixtureId(kind, owner, 0);
          const before = await snapshot();
          const deleted = await raw(kind, id);
          json(await request(owner, 'DELETE', `/${kind}/${id}`), 200, { message: messages[kind].deleted });
          assert.equal(await raw(kind, id), null);
          const after = await snapshot();
          assert.deepEqual(after[kind], before[kind].filter(bytes => !bytes.equals(mongoose.mongo.BSON.serialize(deleted))));
          assert.deepEqual(after[kind === 'expenses' ? 'incomes' : 'expenses'], before[kind === 'expenses' ? 'incomes' : 'expenses']);
        });
        for (const method of ['PATCH', 'DELETE']) {
          it(`${label}: cross-owner ${method} is 404 with every persisted BSON byte unchanged`, async () => {
            const before = await snapshot();
            json(await request(owner, method, `/${kind}/${fixtureId(kind, foreign, 0)}`,
              method === 'PATCH' ? bodies[kind] : undefined), 404, { message: messages[kind].missing });
            assert.deepEqual(await snapshot(), before);
          });
        }
      }
      it('alternating A to B to A HTTP requests never leak another owner', async () => {
        for (const owner of [owners[0], owners[1], owners[0]]) await read(kind, owner, 'noPagination=true', [1, 0, 2], 1, 3);
      });
      const filters = [
        ['inclusive UTC date range', 'startDate=2026-01-05T12:00:00.000Z&endDate=2026-01-05T12:00:00.000Z', [1, 0]],
        ['month and year away from timezone boundaries', 'month=1&year=2026', [1, 0]],
        ['year only away from timezone boundaries', 'year=2026', [1, 0, 2]],
        ...(kind === 'expenses' ? [
          ['exact category', 'category=Synthetic%20Food', [0, 2]],
          ['case-insensitive title', 'title=GROCER', [0, 2]],
          ['case-insensitive recipient', 'recipient=SHOP', [0, 2]],
          ['combined category and UTC range', 'category=Synthetic%20Food&startDate=2026-01-01T00:00:00.000Z&endDate=2026-01-31T23:59:59.999Z', [0]],
        ] : [['case-insensitive source', 'source=SALARY', [0, 2]]]),
      ];
      for (const [label, query, indices] of filters) {
        it(`${label} filtering preserves owner isolation and exact totals`, async () => {
          for (const owner of owners) {
            await read(kind, owner, query, indices);
            await read(kind, owner, `noPagination=true&${query}`, indices, 1, indices.length);
          }
        });
      }
      it('a syntactically valid owner with no records receives the existing empty shapes', async () => {
        await read(kind, emptyOwner, '', [], 1, 20);
        await read(kind, emptyOwner, 'noPagination=true', [], 1, 0);
      });
      it('a page beyond owned records keeps the owner-specific total', async () => {
        for (const owner of owners) await read(kind, owner, 'page=4&limit=2', [], 4, 2, 3);
      });
      it('uppercase JWT owner and operation ID cast to the real ObjectIds', async () => {
        const id = fixtureId(kind, owners[0], 0);
        const token = sign({ _id: owners[0].toUpperCase(), exp: 4102444800 });
        json(await request(owners[0], 'PATCH', `/${kind}/${id.toUpperCase()}`, { amount: 99.5 }, token),
          200, await raw(kind, id));
        assert.equal((await raw(kind, id)).amount, 99.5);
        assert.equal(String((await raw(kind, id)).owner), owners[0]);
      });
      it('missing document update/delete returns the existing 404 without any mutation', async () => {
        const before = await snapshot();
        for (const method of ['PATCH', 'DELETE']) {
          json(await request(owners[0], method, `/${kind}/eeeeeeeeeeeeeeeeeeeeeeee`, method === 'PATCH' ? { amount: 10 } : undefined),
            404, { message: messages[kind].missing });
          assert.deepEqual(await snapshot(), before);
        }
      });
      for (const [label, token, message] of [
        ['missing JWT', undefined, 'Необходима авторизация.'],
        ['invalid signature', sign({ _id: owners[0], exp: 4102444800 }, 'synthetic-wrong-key'), 'Необходима авторизация!'],
        ['expired JWT', sign({ _id: owners[0], exp: 1 }), 'Необходима авторизация!'],
        ['invalid signed owner claim', sign({ _id: 'not-an-owner-id', exp: 4102444800 }), 'Необходима авторизация!'],
      ]) {
        it(`${label} rejects every CRUD route before any persisted change`, async () => {
          const before = await snapshot();
          for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
            const endpoint = `/${kind}${['PATCH', 'DELETE'].includes(method) ? `/${fixtureId(kind, owners[0], 0)}` : ''}`;
            // Use the harness directly so undefined really means no header (no default token).
            json(await harness.request(method, endpoint, ['POST', 'PATCH'].includes(method) ? bodies[kind] : undefined, token),
              401, { message });
            assert.deepEqual(await snapshot(), before);
          }
        });
      }
      it('invalid operation IDs are rejected by Celebrate without changing either collection', async () => {
        const before = await snapshot();
        for (const method of ['PATCH', 'DELETE']) {
          validation(await request(owners[0], method, `/${kind}/not-an-object-id`, method === 'PATCH' ? { amount: 10 } : undefined), 'params', 'id');
          assert.deepEqual(await snapshot(), before);
        }
      });
      it('owner in POST/PATCH body is rejected and cannot override the JWT owner', async () => {
        const before = await snapshot();
        for (const method of ['POST', 'PATCH']) {
          const endpoint = `/${kind}${method === 'PATCH' ? `/${fixtureId(kind, owners[0], 0)}` : ''}`;
          validation(await request(owners[0], method, endpoint, { ...bodies[kind], owner: owners[1] }), 'body', 'owner');
          assert.deepEqual(await snapshot(), before);
        }
      });
      it('owner in GET query is rejected without changing stored documents', async () => {
        const before = await snapshot();
        validation(await request(owners[0], 'GET', `/${kind}?owner=${owners[1]}`), 'query', 'owner');
        assert.deepEqual(await snapshot(), before);
      });
      it('ignored write-query owner cannot reassign a creation or override update/delete scoping', async () => {
        const foreignId = fixtureId(kind, owners[1], 0);
        const foreignBefore = await raw(kind, foreignId);
        const create = await request(owners[0], 'POST', `/${kind}?owner=${owners[1]}`, bodies[kind]);
        assert.equal(create.status, 201); assert.equal(create.text, '');
        const created = await models[kind].collection.findOne({ comment: bodies[kind].comment });
        assert.equal(String(created.owner), owners[0]);
        for (const method of ['PATCH', 'DELETE']) {
          const before = await snapshot();
          json(await request(owners[0], method, `/${kind}/${foreignId}?owner=${owners[1]}`,
            method === 'PATCH' ? { amount: 1 } : undefined), 404, { message: messages[kind].missing });
          assert.deepEqual(await snapshot(), before);
        }
        assert.deepEqual(await raw(kind, foreignId), foreignBefore);
      });
      it('invalid financial payloads fail validation without persistence', async () => {
        const before = await snapshot();
        for (const method of ['POST', 'PATCH']) {
          const endpoint = `/${kind}${method === 'PATCH' ? `/${fixtureId(kind, owners[0], 0)}` : ''}`;
          validation(await request(owners[0], method, endpoint, { ...bodies[kind], amount: -1 }), 'body', 'amount');
          assert.deepEqual(await snapshot(), before);
        }
      });
      it('real model validation/casting rejects invalid fixture data without writing a document', async () => {
        const before = await snapshot();
        for (const invalid of [{ owner: 'not-an-object-id' }, { amount: -1 }]) {
          await assert.rejects(models[kind].create({ ...bodies[kind], owner: objectId(owners[0]), ...invalid }),
            error => error.name === 'ValidationError');
          assert.deepEqual(await snapshot(), before);
        }
      });
    });
  }
});
