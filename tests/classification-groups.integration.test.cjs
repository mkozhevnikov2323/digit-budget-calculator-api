const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createHarness } = require('./helpers/mongodb-integration.cjs');
const A = 'a'.repeat(24),
  B = 'b'.repeat(24),
  ID = '1'.repeat(24),
  OTHER = '2'.repeat(24);
const flags = [
  'CLASSIFICATION_GROUPS_ENABLED',
  'CLASSIFICATION_C_WRITE_ENABLED',
  'CLASSIFICATION_READ_ENABLED',
  'CLASSIFICATION_HISTORY_READ_ENABLED',
];
const root = '/classification-groups',
  start = Date.UTC(2025, 0, 1),
  end = Date.UTC(2025, 1, 1);
describe(
  'custom classification groups: real HTTP, manifests and disposable MongoDB',
  { concurrency: false, timeout: 120000 },
  () => {
    let h, db, manifests, migrate, saved, oid;
    const token = (who = A) =>
      jwt.sign({ _id: who, exp: 4102444800 }, 'super-secret-key');
    const req = (method, path = '', body, who = A) =>
      h.request(
        method,
        root + path,
        body,
        who === null ? undefined : token(who),
        body === undefined
          ? {}
          : {
              headers: {
                'Content-Length': Buffer.byteLength(JSON.stringify(body)),
              },
            },
      );
    const op = (ds = 'expenses', id = ID) => `/operations/${ds}/${id}`;
    const options = (mode = 'dry-run') => ({
      dbName: h.databaseName,
      environment: 'test',
      mode,
      backupConfirmed: mode === 'apply' || mode === 'rollback',
    });
    const initialize = async (who = A) => {
      const r = await req('POST', '/initialize', {}, who);
      assert.equal(r.status, 200);
      assert.equal(r.body.result.initialized, true);
    };
    const create = async (
      name = 'Автомобиль',
      dataset = 'expenses',
      who = A,
    ) => {
      const r = await req('POST', '', { name, dataset }, who);
      assert.equal(r.status, 201);
      return r.body.result;
    };
    const read = async (ds = 'expenses', id = ID, who = A) => {
      const r = await req('GET', op(ds, id), undefined, who);
      assert.equal(r.status, 200);
      return r.body.result;
    };
    const command = async (groupId, ds = 'expenses', id = ID, extra = {}) => {
      const r = await read(ds, id);
      return {
        version: 'classification-group-decision-v3',
        requestId: randomUUID(),
        expectedRevision: r.decisionRevision,
        state: 'approved',
        groupId,
        expectedFacts: r.facts,
        ...extra,
      };
    };
    const put = (body, ds = 'expenses', id = ID, who = A) =>
      req('PUT', op(ds, id) + '/decision', body, who);
    const report = (extra = {}, who = A) =>
      req(
        'POST',
        '/report',
        {
          version: 'classification-group-report-v3',
          startInclusive: start,
          endExclusive: end,
          includeOperations: true,
          ...extra,
        },
        who,
      );
    const rule = (body, who = A) => req('POST', '/rules', body, who);
    before(async () => {
      h = await createHarness(process.env, true);
      db = h.mongoose.connection.db;
      oid = (x) => new h.mongoose.Types.ObjectId(x);
      const m = require('../dist/persistence/classificationGroupsManifest');
      manifests = [
        m.GROUPS_MANIFEST,
        m.GROUP_DECISION_MANIFEST,
        m.GROUP_RULES_MANIFEST,
      ];
      ({
        migrateClassificationGroups: migrate,
      } = require('../dist/scripts/migrateClassificationGroups'));
      saved = Object.fromEntries(flags.map((f) => [f, process.env[f]]));
    });
    beforeEach(async () => {
      mock.restoreAll();
      h.assertDatabase();
      flags.forEach((f) => {
        process.env[f] = '1';
      });
      for (const m of manifests) {
        if (await db.listCollections({ name: m.collectionName }).hasNext())
          await db.collection(m.collectionName).drop();
        await db.createCollection(m.collectionName, m.options);
        for (const i of m.indexes)
          await db.collection(m.collectionName).createIndex(i.key, i.options);
      }
      for (const n of ['users', 'expenses', 'incomes'])
        await db.collection(n).deleteMany({});
      await db
        .collection('users')
        .insertMany([{ _id: oid(A) }, { _id: oid(B) }]);
      for (const ds of ['expenses', 'incomes'])
        await db.collection(ds).insertOne({
          _id: oid(ID),
          owner: oid(A),
          amount: 12.34,
          date: new Date('2025-01-15T12:00:00Z'),
          ...(ds === 'expenses'
            ? {
                category: 'Транспорт',
                title: 'Топливо',
                recipient: 'Synthetic',
              }
            : { source: 'Зарплата' }),
        });
    });
    after(async () => {
      mock.restoreAll();
      for (const f of flags) {
        if (saved[f] === undefined) delete process.env[f];
        else process.env[f] = saved[f];
      }
      assert.deepEqual(await h.close(), {
        dropped: true,
        disconnected: true,
        listenerClosed: true,
        logsClosed: true,
        directoryRemoved: true,
        environmentRestored: true,
      });
      console.info(
        'Groups test-owned database dropped and verified empty; resources released.',
      );
    });
    it('GET never initializes or creates data; initialize is explicit and idempotent', async () => {
      let r = await req('GET');
      assert.equal(r.status, 200);
      assert.equal(r.body.result.groups.length, 0);
      assert.equal(r.body.result.initialized, false);
      assert.equal(
        await db.collection('classification_groups').countDocuments({}),
        0,
      );
      await initialize();
      await initialize();
      r = await req('GET');
      assert.equal(r.body.result.groups.length, 13);
      assert.equal(r.body.result.initialized, true);
    });
    it('supports custom create/rename/disable/archive/restore and normalized uniqueness', async () => {
      await initialize();
      let g = await create();
      assert.match(g.groupId, /^custom:/);
      assert.equal(
        (await req('POST', '', { dataset: 'expenses', name: 'автомобиль' }))
          .status,
        409,
      );
      const income = await create('Автомобиль', 'incomes');
      assert.notEqual(income.groupId, g.groupId);
      for (const patch of [
        { name: 'Семья' },
        { status: 'disabled' },
        { status: 'active' },
      ]) {
        const r = await req('PATCH', '/' + g.groupId, {
          expectedRevision: g.revision,
          ...patch,
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.result.groupId, g.groupId);
        g = r.body.result;
      }
      let r = await req('DELETE', '/' + g.groupId, {
        expectedRevision: g.revision,
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.result.status, 'archived');
      g = r.body.result;
      r = await req('PATCH', '/' + g.groupId, {
        expectedRevision: g.revision,
        status: 'active',
      });
      assert.equal(r.status, 200);
      assert.equal(
        await db
          .collection('classification_groups')
          .countDocuments({ groupId: g.groupId }),
        1,
      );
    });
    it('isolates system customization, resets name and forbids system deletion', async () => {
      await initialize();
      await initialize(B);
      const id = 'system:expenses:everyday';
      let r = await req('PATCH', '/' + id, {
        expectedRevision: 1,
        name: 'Дом',
        status: 'disabled',
      });
      assert.equal(r.status, 200);
      assert.equal(
        (await req('GET', '', undefined, B)).body.result.groups.find(
          (g) => g.groupId === id,
        ).name,
        'Повседневные расходы',
      );
      assert.equal(
        (await req('DELETE', '/' + id, { expectedRevision: 2 })).status,
        409,
      );
      r = await req('PATCH', '/' + id, {
        expectedRevision: 2,
        resetName: true,
        status: 'active',
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.result.name, 'Повседневные расходы');
    });
    it('enforces authentication, owner isolation, strict fields and safe error contracts', async () => {
      assert.equal((await req('GET', '', undefined, null)).status, 401);
      await initialize();
      const g = await create();
      for (const body of [
        { name: '', dataset: 'expenses' },
        { name: 'Name', dataset: 'expenses', owner: B },
        { name: 7, dataset: 'expenses' },
        { name: 'Name', dataset: 'loans' },
      ])
        assert.equal((await req('POST', '', body)).status, 400);
      assert.equal(
        (
          await req(
            'PATCH',
            '/' + g.groupId,
            { expectedRevision: 1, name: 'Other' },
            B,
          )
        ).status,
        404,
      );
      assert.equal((await req('GET', '?owner=' + B)).status, 400);
      assert.equal(
        (
          await req('PATCH', '/' + g.groupId, {
            expectedRevision: 2,
            name: 'Other',
          })
        ).status,
        409,
      );
      assert.equal(
        (await req('GET', op('expenses', ID), undefined, B)).status,
        404,
      );
      assert.equal(
        (await req('GET', '', undefined, 'c'.repeat(24))).status,
        401,
      );
    });
    it('paginates catalog without duplicates and rejects oversized limits', async () => {
      await initialize();
      const all = [];
      let cursor;
      do {
        const r = await req(
          'GET',
          `?dataset=expenses&limit=3${cursor ? '&after=' + cursor : ''}`,
        );
        assert.equal(r.status, 200);
        all.push(...r.body.result.groups.map((g) => g.groupId));
        cursor = r.body.result.nextCursor;
      } while (cursor);
      assert.equal(all.length, 8);
      assert.equal(new Set(all).size, 8);
      assert.equal((await req('GET', '?limit=101')).status, 400);
    });
    it('assigns and changes expense/income groups atomically, clears and preserves source BSON', async () => {
      await initialize();
      const expense = await create(),
        income = await create('Возврат личного займа', 'incomes'),
        beforeE = await db.collection('expenses').findOne({}),
        beforeI = await db.collection('incomes').findOne({});
      let r = await put(await command(expense.groupId));
      assert.equal(r.status, 200);
      assert.equal(r.body.result.decision.groupId, expense.groupId);
      r = await put(await command('system:expenses:irregular'));
      assert.equal(r.body.result.decision.decisionRevision, 2);
      r = await put(await command(income.groupId, 'incomes'), 'incomes');
      assert.equal(r.status, 200);
      assert.equal(r.body.result.decision.groupId, income.groupId);
      for (const state of ['explicit_unclassified', 'cleared']) {
        const body = await command(expense.groupId, 'expenses', ID, { state });
        delete body.groupId;
        r = await put(body);
        assert.equal(r.status, 200);
        assert.equal(r.body.result.decision.status, state);
        assert.equal(r.body.result.decision.groupId, null);
      }
      assert.deepEqual(await db.collection('expenses').findOne({}), beforeE);
      assert.deepEqual(await db.collection('incomes').findOne({}), beforeI);
      const raw = await db
        .collection('operation_classifications')
        .findOne({ dataset: 'incomes' });
      assert.equal(raw.taxonomyVersion, 'financial-classification-groups-v3');
      assert.equal(Object.hasOwn(raw, 'assignment'), false);
      assert.equal(
        await db.collection('operation_classifications').countDocuments({}),
        2,
      );
    });
    it('rejects missing/inactive/foreign/wrong-dataset groups and absent/changed sources', async () => {
      await initialize();
      await initialize(B);
      const g = await create(),
        foreign = await create('Other', 'expenses', B),
        inc = await create('Salary', 'incomes');
      for (const target of [
        foreign.groupId,
        inc.groupId,
        `custom:${randomUUID()}`,
      ])
        assert.equal((await put(await command(target))).status, 409);
      assert.equal(
        (await put(await command(g.groupId), 'expenses', OTHER)).status,
        404,
      );
      await req('PATCH', '/' + g.groupId, {
        expectedRevision: 1,
        status: 'disabled',
      });
      assert.equal((await put(await command(g.groupId))).status, 409);
      const body = await command('system:expenses:everyday');
      body.expectedFacts.title = 'Changed';
      assert.equal((await put(body)).status, 409);
      assert.equal(
        await db.collection('operation_classifications').countDocuments({}),
        0,
      );
    });
    it('rejects non-explicit intentions and extra assignments without persistence', async () => {
      await initialize();
      const body = await command('system:expenses:everyday');
      for (const patch of [
        { expectedFacts: undefined },
        { expectedRevision: undefined },
        { confirmed: true },
        { assignment: { economicRole: 'ordinary_expense', layer: 'everyday' } },
        { state: 'cleared' },
        { requestId: body.requestId + '\n' },
      ]) {
        const r = await put({ ...body, ...patch });
        assert.ok([400, 409].includes(r.status));
      }
      assert.equal(
        await db.collection('operation_classifications').countDocuments({}),
        0,
      );
    });
    it('replays exactly once; same requestId with changed intent and old revisions conflict', async () => {
      await initialize();
      const body = await command('system:expenses:everyday');
      assert.equal((await put(body)).status, 200);
      let r = await put(body);
      assert.equal(r.body.result.outcome, 'replayed');
      assert.equal(r.body.result.decision.decisionRevision, 1);
      assert.equal(
        (await put({ ...body, groupId: 'system:expenses:irregular' })).status,
        409,
      );
      assert.equal(
        (await put({ ...body, requestId: randomUUID() })).status,
        409,
      );
      assert.equal(
        await db.collection('operation_classifications').countDocuments({}),
        1,
      );
    });
    it('concurrent group and decision edits have a single CAS winner', async () => {
      await initialize();
      const g = await create();
      const edits = await Promise.all(
        ['One', 'Two'].map((name) =>
          req('PATCH', '/' + g.groupId, { expectedRevision: 1, name }),
        ),
      );
      assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
      const c = await command(g.groupId);
      const writes = await Promise.all([
        put(c),
        put({
          ...c,
          requestId: randomUUID(),
          groupId: 'system:expenses:everyday',
        }),
      ]);
      assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
      assert.equal((await read()).decisionRevision, 1);
    });
    it('renaming/archiving keeps historical links and statistics; archived groups cannot be newly assigned', async () => {
      await initialize();
      let g = await create();
      const body = await command(g.groupId);
      await put(body);
      g = (
        await req('PATCH', '/' + g.groupId, {
          expectedRevision: 1,
          name: 'Инвестиции',
        })
      ).body.result;
      await req('DELETE', '/' + g.groupId, { expectedRevision: g.revision });
      let r = await read();
      assert.equal(r.group.name, 'Инвестиции');
      assert.equal(r.group.status, 'archived');
      assert.equal(r.status, 'approved');
      assert.equal((await put(body)).body.result.outcome, 'replayed');
      assert.equal((await put(await command(g.groupId))).status, 409);
      r = await report({ groupId: g.groupId });
      assert.equal(r.status, 200);
      assert.equal(r.body.result.operations.length, 1);
      assert.equal(
        r.body.result.groups.find((x) => x.groupId === g.groupId).kopecks,
        1234,
      );
    });
    it('uses freshness after source changes and never treats stale approval as effective', async () => {
      await initialize();
      const g = await create();
      await put(await command(g.groupId));
      await db
        .collection('expenses')
        .updateOne({ _id: oid(ID) }, { $set: { title: 'Repair', amount: 20 } });
      const r = await read();
      assert.equal(r.status, 'stale');
      assert.equal(r.groupId, null);
      assert.equal(r.storedGroupId, g.groupId);
      const stats = (await report()).body.result;
      assert.equal(stats.totals.expenses.kopecks, 2000);
      assert.equal(
        stats.groups.find((x) => x.dataset === 'expenses').groupId,
        null,
      );
      await db.collection('expenses').deleteOne({ _id: oid(ID) });
      assert.equal((await req('GET', op())).status, 404);
    });
    it('lost acknowledgement remains unknown; reconcile only observes and never writes', async () => {
      await initialize();
      const body = await command('system:expenses:everyday'),
        proto = Object.getPrototypeOf(
          db.collection('operation_classifications'),
        ),
        original = proto.insertOne;
      let writes = 0;
      const m = mock.method(proto, 'insertOne', async function (...args) {
        const r = await original.apply(this, args);
        if (this.collectionName === 'operation_classifications') {
          writes++;
          throw new Error('Synthetic lost acknowledgement');
        }
        return r;
      });
      let r = await put(body);
      assert.equal(r.status, 503);
      assert.equal(r.body.persistence, 'unknown');
      r = await req('POST', op() + '/reconcile', body);
      assert.equal(r.status, 200);
      assert.equal(r.body.result.outcome, 'observed_matching');
      assert.equal(writes, 1);
      assert.equal((await read()).decisionRevision, 1);
      m.mock.restore();
      const changed = { ...body, groupId: 'system:expenses:irregular' };
      assert.equal(
        (await req('POST', op() + '/reconcile', changed)).body.result.outcome,
        'unresolved',
      );
    });
    it('post-write source failure cannot claim success and never triggers a second save', async () => {
      await initialize();
      const body = await command('system:expenses:everyday'),
        proto = Object.getPrototypeOf(
          db.collection('operation_classifications'),
        ),
        insert = proto.insertOne,
        find = proto.findOne;
      let writes = 0;
      mock.method(proto, 'insertOne', async function (...args) {
        const r = await insert.apply(this, args);
        if (this.collectionName === 'operation_classifications') writes++;
        return r;
      });
      mock.method(proto, 'findOne', async function (...args) {
        if (writes && this.collectionName === 'expenses')
          throw new Error('Synthetic source outage');
        return find.apply(this, args);
      });
      const r = await put(body);
      assert.equal(r.status, 503);
      assert.equal(r.body.persistence, 'unknown');
      assert.equal(writes, 1);
    });
    it('preserves strict legacy decisions and old API behavior; upgrades only explicit selected records', async () => {
      await initialize();
      const facts = (await read()).facts;
      let r = await h.request(
        'PUT',
        `/classifications/expenses/${ID}/decision`,
        {
          version: 'classification-decision-v1',
          requestId: randomUUID(),
          expectedRevision: null,
          state: 'approved',
          assignment: { economicRole: 'ordinary_expense', layer: 'everyday' },
          expectedFacts: facts,
        },
        token(),
      );
      assert.equal(r.status, 201);
      const original = await db
        .collection('operation_classifications')
        .findOne({});
      r = await req('GET', op());
      assert.equal(r.body.result.legacy, true);
      assert.equal(r.body.result.groupId, 'system:expenses:everyday');
      await report();
      assert.deepEqual(
        await db.collection('operation_classifications').findOne({}),
        original,
      );
      r = await h.request(
        'GET',
        `/classifications/expenses/${ID}`,
        undefined,
        token(),
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'approved');
      const g = await create();
      r = await put(await command(g.groupId));
      assert.equal(r.status, 200);
      assert.equal(r.body.result.decision.decisionRevision, 2);
      assert.equal(
        await db.collection('operation_classifications').countDocuments({}),
        1,
      );
      r = await h.request(
        'GET',
        `/classifications/expenses/${ID}`,
        undefined,
        token(),
      );
      assert.equal(r.body.status, 'blocked');
    });
    it('supports normalized category/title priority, income/source and read-only preview', async () => {
      await initialize();
      const general = await create(),
        specific = await create('Ремонт'),
        income = await create('Работа', 'incomes');
      for (const body of [
        {
          dataset: 'expenses',
          category: ' ТРАНСПОРТ ',
          groupId: general.groupId,
        },
        {
          dataset: 'expenses',
          category: 'транспорт',
          title: ' ТОПЛИВО ',
          groupId: specific.groupId,
        },
        { dataset: 'incomes', source: ' ЗАРПЛАТА ', groupId: income.groupId },
      ])
        assert.equal((await rule(body)).status, 201);
      const preview = () =>
        req('POST', '/preview', {
          version: 'classification-group-preview-v3',
          startInclusive: start,
          endExclusive: end,
          operations: [
            { dataset: 'expenses', operationId: ID },
            { dataset: 'incomes', operationId: ID },
          ],
        });
      let r = await preview();
      assert.equal(r.status, 200);
      assert.equal(r.body.result.proposals[0].match.groupId, specific.groupId);
      assert.equal(r.body.result.proposals[1].match.groupId, income.groupId);
      assert.ok(r.body.result.proposals.every((x) => x.eligible));
      assert.equal(
        await db.collection('operation_classifications').countDocuments({}),
        0,
      );
      await req('DELETE', '/' + specific.groupId, { expectedRevision: 1 });
      r = await preview();
      assert.equal(r.body.result.proposals[0].eligible, false);
      assert.equal(
        r.body.result.proposals[0].match.diagnostic,
        'group_inactive',
      );
      assert.equal(r.body.result.proposals[0].match.groupId, specific.groupId);
    });
    it('updates/deletes rules with etag CAS and owner isolation, preserves renamed target', async () => {
      await initialize();
      const g = await create();
      let r = await rule({
        dataset: 'expenses',
        category: 'ТРАНСПОРТ',
        groupId: g.groupId,
      });
      assert.equal(r.status, 201);
      let x = r.body.result;
      assert.equal(
        (
          await rule({
            dataset: 'expenses',
            category: 'транспорт',
            groupId: g.groupId,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await req(
            'PATCH',
            '/rules/' + x.id,
            { expectedEtag: x.etag, enabled: false },
            B,
          )
        ).status,
        404,
      );
      r = await req('PATCH', '/rules/' + x.id, {
        expectedEtag: x.etag,
        title: 'Ремонт',
      });
      assert.equal(r.status, 200);
      assert.equal(
        (
          await req('PATCH', '/rules/' + x.id, {
            expectedEtag: x.etag,
            enabled: false,
          })
        ).status,
        409,
      );
      x = r.body.result;
      await req('PATCH', '/' + g.groupId, {
        expectedRevision: 1,
        name: 'Семья',
      });
      assert.equal(
        (await req('GET', '/rules')).body.result.rules[0].group.name,
        'Семья',
      );
      assert.equal(
        (await req('DELETE', '/rules/' + x.id, { expectedEtag: x.etag }))
          .status,
        200,
      );
      assert.equal((await req('GET', '/rules')).body.result.rules.length, 0);
    });
    it('retains all eight seed rules, converts one explicitly, old API cannot overwrite v3', async () => {
      await initialize();
      const {
        seedInitialClassificationRules,
      } = require('../dist/scripts/seedClassificationRules');
      let seeded = await seedInitialClassificationRules(
        h.mongoose.connection,
        A,
        true,
      );
      assert.equal(seeded.created, 8);
      const originals = await db
        .collection('classification_rules')
        .find({})
        .sort({ _id: 1 })
        .toArray();
      let r = await req('GET', '/rules');
      assert.equal(r.body.result.rules.length, 8);
      assert.ok(
        r.body.result.rules.every((x) =>
          x.groupId.startsWith('system:expenses:'),
        ),
      );
      assert.deepEqual(
        await db
          .collection('classification_rules')
          .find({})
          .sort({ _id: 1 })
          .toArray(),
        originals,
      );
      const old = r.body.result.rules[0];
      const g = await create();
      r = await req('PATCH', '/rules/' + old.id, {
        expectedEtag: old.etag,
        groupId: g.groupId,
      });
      assert.equal(r.status, 200);
      r = await h.request('GET', '/classification-rules', undefined, token());
      assert.equal(r.status, 200);
      assert.equal(r.body.rules.length, 7);
      r = await h.request(
        'PATCH',
        '/classification-rules/' + old.id,
        { layer: 'irregular' },
        token(),
      );
      assert.equal(r.status, 404);
      const legacyId = originals
        .find((x) => x._id.toHexString() !== old.id)
        ._id.toHexString();
      r = await h.request(
        'PATCH',
        '/classification-rules/' + legacyId,
        { enabled: false },
        token(),
      );
      assert.equal(r.status, 200);
      assert.equal(
        (await seedInitialClassificationRules(h.mongoose.connection, A, true))
          .created,
        0,
      );
    });
    it('reconciles all cashflows without exclusions, with archived and unclassified buckets', async () => {
      await initialize();
      const g = await create('Выданные личные займы'),
        inc = await create('Возврат личного займа', 'incomes');
      await put(await command(g.groupId));
      await put(await command(inc.groupId, 'incomes'), 'incomes');
      await db.collection('expenses').insertOne({
        _id: oid(OTHER),
        owner: oid(A),
        amount: 0.01,
        date: new Date(start),
        category: 'Перевод',
        title: 'Инвестиции',
        recipient: 'Synthetic',
      });
      await db.collection('expenses').insertOne({
        _id: oid('3'.repeat(24)),
        owner: oid(B),
        amount: 999,
        date: new Date(start),
        category: 'Other',
        title: 'Other',
        recipient: 'Other',
      });
      await req('DELETE', '/' + g.groupId, { expectedRevision: 1 });
      let r = await report();
      assert.equal(r.status, 200);
      const x = r.body.result;
      assert.deepEqual(x.totals.expenses, {
        kopecks: 1235,
        signedKopecks: -1235,
        count: 2,
      });
      assert.deepEqual(x.totals.incomes, {
        kopecks: 1234,
        signedKopecks: 1234,
        count: 1,
      });
      assert.equal(
        x.groups
          .filter((x) => x.dataset === 'expenses')
          .reduce((s, g) => s + g.kopecks, 0),
        1235,
      );
      assert.equal(
        x.operations.find((x) => x.operationId === OTHER).groupId,
        null,
      );
      r = await report({ dataset: 'incomes', groupId: inc.groupId });
      assert.equal(r.body.result.operations.length, 1);
      assert.equal(r.body.result.totals.expenses.kopecks, 1235);
      assert.equal(
        (await report({ startInclusive: 0, endExclusive: 367 * 86400000 }))
          .status,
        400,
      );
      await db
        .collection('expenses')
        .updateOne({ _id: oid(OTHER) }, { $set: { amount: 0.123 } });
      assert.equal((await report()).status, 503);
    });
    it('fails readiness closed for missing indexes and disabled feature gates with no DDL', async () => {
      await initialize();
      for (const f of flags) {
        delete process.env[f];
        const path =
          f === 'CLASSIFICATION_READ_ENABLED'
            ? op()
            : f === 'CLASSIFICATION_HISTORY_READ_ENABLED'
              ? '/report'
              : f === 'CLASSIFICATION_C_WRITE_ENABLED'
                ? op() + '/decision'
                : '';
        const method =
          f === 'CLASSIFICATION_HISTORY_READ_ENABLED'
            ? 'POST'
            : f === 'CLASSIFICATION_C_WRITE_ENABLED'
              ? 'PUT'
              : 'GET';
        assert.equal(
          (await req(method, path, method === 'GET' ? undefined : {})).status,
          503,
        );
        process.env[f] = '1';
      }
      await db
        .collection('classification_groups')
        .dropIndex('ux_group_owner_identity');
      assert.equal((await req('GET')).status, 503);
      assert.equal(
        (await req('POST', '', { dataset: 'expenses', name: 'Other' })).status,
        503,
      );
      assert.equal(
        (await db.collection('classification_groups').listIndexes().toArray())
          .length,
        2,
      );
    });
    it('migration dry-run is repeatable and never writes; apply/verify is idempotent; rollback preserves catalog', async () => {
      for (const m of manifests) await db.collection(m.collectionName).drop();
      const client = h.mongoose.connection.getClient(),
        commands = [];
      const listener = (e) => commands.push(e.commandName);
      client.on('commandStarted', listener);
      const a = await migrate(db, options()),
        b = await migrate(db, options());
      client.off('commandStarted', listener);
      assert.deepEqual(a, b);
      assert.ok(
        !commands.some((x) =>
          [
            'insert',
            'update',
            'delete',
            'create',
            'createIndexes',
            'collMod',
            'drop',
          ].includes(x),
        ),
      );
      assert.equal(a.plan.filter((p) => p.action === 'create').length, 3);
      await migrate(db, options('apply'));
      await migrate(db, options('apply'));
      assert.equal((await migrate(db, options('verify'))).verified, true);
      await initialize();
      const original = await db
        .collection('classification_groups')
        .find({})
        .toArray();
      assert.equal(
        (await migrate(db, options('rollback'))).catalogPreserved,
        true,
      );
      assert.deepEqual(
        await db.collection('classification_groups').find({}).toArray(),
        original,
      );
      await migrate(db, options('apply'));
      assert.equal((await migrate(db, options('verify'))).verified, true);
    });
    it('migration extends legacy validators without rewriting decisions or eight rules', async () => {
      for (const m of manifests) await db.collection(m.collectionName).drop();
      const old =
        require('../dist/persistence/classificationManifest').CLASSIFICATION_MANIFEST;
      await db.createCollection(old.collectionName, old.options);
      await db
        .collection(old.collectionName)
        .createIndex(old.index.key, old.index.options);
      const Model = h.mongoose.connection.models.ClassificationRule;
      await db.createCollection('classification_rules');
      for (const [key, opts] of Model.schema.indexes())
        await db.collection('classification_rules').createIndex(key, opts);
      const {
        seedInitialClassificationRules: seed,
      } = require('../dist/scripts/seedClassificationRules');
      assert.equal((await seed(h.mongoose.connection, A, true)).created, 8);
      const rows = await db
        .collection('classification_rules')
        .find({})
        .toArray();
      const plan = await migrate(db, options());
      assert.equal(plan.counts.rules, 8);
      assert.equal(plan.plan.filter((x) => x.action === 'extend').length, 2);
      await migrate(db, options('apply'));
      assert.deepEqual(
        await db.collection('classification_rules').find({}).toArray(),
        rows,
      );
      assert.equal((await migrate(db, options('verify'))).verified, true);
    });
    it('migration rejects wrong database, missing backup, unexpected indexes/documents and unsafe rollback', async () => {
      await assert.rejects(
        migrate(db, { ...options(), dbName: 'other' }),
        (e) => e.code === 'unsafe_migration_configuration',
      );
      await assert.rejects(
        migrate(db, { ...options('apply'), backupConfirmed: false }),
        (e) => e.code === 'unsafe_migration_configuration',
      );
      await db
        .collection('classification_groups')
        .createIndex({ owner: 1 }, { name: 'unexpected' });
      await assert.rejects(
        migrate(db, options()),
        (e) => e.code === 'incompatible_indexes_or_options',
      );
      await db.collection('classification_groups').dropIndex('unexpected');
      await initialize();
      await put(await command('system:expenses:everyday'));
      await assert.rejects(
        migrate(db, options('rollback')),
        (e) => e.code === 'rollback_would_hide_group_assignments',
      );
      await db.command({
        collMod: 'classification_rules',
        validator: {},
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await db
        .collection('classification_rules')
        .insertOne({ _id: oid(OTHER), owner: oid(A), unexpected: true });
      await assert.rejects(
        migrate(db, options()),
        (e) => e.code === 'invalid_rule_record',
      );
    });
    it('validates strict MongoDB manifests independently of application DTOs', async () => {
      await initialize();
      const g = await create();
      const raw = await db
        .collection('classification_groups')
        .findOne({ groupId: g.groupId });
      for (const patch of [
        { origin: 'system' },
        { dataset: 'loans' },
        { extra: true },
        { revision: 0 },
      ])
        await assert.rejects(
          db.collection('classification_groups').insertOne({
            ...raw,
            _id: new h.mongoose.Types.ObjectId(),
            groupId: `custom:${randomUUID()}`,
            ...patch,
          }),
          (e) => e.code === 121,
        );
      await put(await command(g.groupId));
      const stored = await db
        .collection('operation_classifications')
        .findOne({});
      for (const patch of [
        { assignment: { economicRole: 'ordinary_expense', layer: 'everyday' } },
        { groupId: 'system:incomes:refund' },
        {
          lastMutation: {
            ...stored.lastMutation,
            requestId: randomUUID() + '\n',
          },
        },
      ])
        await assert.rejects(
          db
            .collection('operation_classifications')
            .replaceOne({ _id: stored._id }, { ...stored, ...patch }),
          (e) => e.code === 121,
        );
    });
    it('handles v1 loan history without inventing a layer and without rewriting it', async () => {
      await initialize();
      await put(await command('system:expenses:everyday'));
      const raw = await db.collection('operation_classifications').findOne({});
      const old = {
        ...raw,
        taxonomyVersion: 'financial-classification-v1',
        assignment: { economicRole: 'loan_issuance', layer: null },
      };
      delete old.groupId;
      await db
        .collection('operation_classifications')
        .replaceOne({ _id: old._id }, old);
      const original = await db
        .collection('operation_classifications')
        .findOne({});
      const r = await read();
      assert.equal(r.legacy, true);
      assert.equal(r.groupId, 'system:expenses:role:loan_issuance');
      assert.equal(r.group.status, 'disabled');
      assert.equal(
        (await report()).body.result.totals.expenses.signedKopecks,
        -1234,
      );
      assert.deepEqual(
        await db.collection('operation_classifications').findOne({}),
        original,
      );
    });
    it('source deletion after an acknowledged write yields unknown rather than a false success', async () => {
      await initialize();
      const body = await command('system:expenses:everyday'),
        proto = Object.getPrototypeOf(
          db.collection('operation_classifications'),
        ),
        insert = proto.insertOne;
      let writes = 0;
      mock.method(proto, 'insertOne', async function (...args) {
        const r = await insert.apply(this, args);
        if (this.collectionName === 'operation_classifications') {
          writes++;
          await db.collection('expenses').deleteOne({ _id: oid(ID) });
        }
        return r;
      });
      const r = await put(body);
      assert.equal(r.status, 503);
      assert.equal(r.body.persistence, 'unknown');
      assert.equal(writes, 1);
      assert.equal(
        await db.collection('operation_classifications').countDocuments({}),
        1,
      );
    });
    it('concurrent group archive after write is unknown; historical group still resolves', async () => {
      await initialize();
      const g = await create(),
        body = await command(g.groupId),
        proto = Object.getPrototypeOf(
          db.collection('operation_classifications'),
        ),
        insert = proto.insertOne;
      mock.method(proto, 'insertOne', async function (...args) {
        const r = await insert.apply(this, args);
        if (this.collectionName === 'operation_classifications')
          await db
            .collection('classification_groups')
            .updateOne(
              { groupId: g.groupId },
              { $set: { status: 'archived' }, $inc: { revision: 1 } },
            );
        return r;
      });
      const r = await put(body);
      assert.equal(r.status, 503);
      assert.equal(r.body.persistence, 'unknown');
      assert.equal((await read()).group.status, 'archived');
      assert.equal(
        (await put({ ...body, requestId: randomUUID(), expectedRevision: 1 }))
          .status,
        409,
      );
    });
    it('report rejects membership/fact changes instead of publishing partial or mismatched totals', async () => {
      await initialize();
      const proto = Object.getPrototypeOf(db.collection('expenses')),
        find = proto.find;
      let reads = 0;
      mock.method(proto, 'find', function (...args) {
        const cursor = find.apply(this, args);
        if (this.collectionName === 'expenses' && ++reads === 2) {
          const toArray = cursor.toArray;
          mock.method(cursor, 'toArray', async function (...a) {
            await db
              .collection('expenses')
              .updateOne({ _id: oid(ID) }, { $set: { amount: 99 } });
            return toArray.apply(this, a);
          });
        }
        return cursor;
      });
      const r = await report();
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'history_changed');
    });
    it('read-only routes cannot repair a missing collection or activate flags', async () => {
      await db.collection('classification_groups').drop();
      assert.equal((await req('GET')).status, 503);
      assert.equal(
        await db.listCollections({ name: 'classification_groups' }).hasNext(),
        false,
      );
      delete process.env.CLASSIFICATION_GROUPS_ENABLED;
      assert.equal((await req('POST', '/initialize', {})).status, 503);
      assert.equal(
        await db.listCollections({ name: 'classification_groups' }).hasNext(),
        false,
      );
    });
    it('rules reject foreign, wrong-dataset and inactive targets; no financial writes occur', async () => {
      await initialize();
      await initialize(B);
      const foreign = await create('Other', 'expenses', B),
        income = await create('Подработка', 'incomes');
      for (const groupId of [
        foreign.groupId,
        income.groupId,
        `custom:${randomUUID()}`,
      ])
        assert.equal(
          (await rule({ dataset: 'expenses', category: 'транспорт', groupId }))
            .status,
          409,
        );
      const g = await create();
      await req('PATCH', '/' + g.groupId, {
        expectedRevision: 1,
        status: 'disabled',
      });
      assert.equal(
        (
          await rule({
            dataset: 'expenses',
            category: 'транспорт',
            groupId: g.groupId,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await rule({
            dataset: 'expenses',
            category: 'транспорт',
            groupId: 'system:expenses:everyday',
            owner: B,
          })
        ).status,
        400,
      );
      assert.equal(
        await db.collection('classification_rules').countDocuments({}),
        0,
      );
      assert.equal(
        await db.collection('operation_classifications').countDocuments({}),
        0,
      );
    });
    it('rejects expired sessions and malformed transport without exposing exception metadata', async () => {
      const expired = jwt.sign({ _id: A, exp: 1 }, 'super-secret-key');
      assert.equal(
        (await h.request('GET', root, undefined, expired)).status,
        401,
      );
      const raw = '{"name":"one","name":"two","dataset":"expenses"}';
      const r = await h.request('POST', root, undefined, token(), {
        rawBody: raw,
        headers: { 'Content-Length': Buffer.byteLength(raw) },
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.persistence, 'not_applied');
      assert.equal(Object.hasOwn(r.body, 'stack'), false);
      const origin = await h.request(
        'POST',
        root,
        { name: 'Group', dataset: 'expenses' },
        token(),
        { headers: { Origin: 'https://invalid.example' } },
      );
      assert.equal(origin.status, 403);
    });
    it('rejects explicit null patch values instead of treating them as omitted fields', async () => {
      await initialize();
      const g = await create();
      for (const patch of [{ name: null }, { status: null }])
        assert.equal(
          (
            await req('PATCH', '/' + g.groupId, {
              expectedRevision: 1,
              ...patch,
            })
          ).status,
          400,
        );
      const r = await rule({
        dataset: 'expenses',
        category: 'транспорт',
        groupId: g.groupId,
      });
      assert.equal(r.status, 201);
      const x = r.body.result;
      for (const patch of [
        { groupId: null },
        { enabled: null },
        { category: null },
      ])
        assert.equal(
          (
            await req('PATCH', '/rules/' + x.id, {
              expectedEtag: x.etag,
              ...patch,
            })
          ).status,
          400,
        );
      assert.equal((await req('GET', '?limit=1%0A')).status, 400);
      const stats = await report({ groupId: null });
      assert.equal(stats.status, 200);
      assert.equal(stats.body.result.operations.length, 2);
      assert.ok(stats.body.result.operations.every((x) => x.groupId === null));
    });
    it('can explicitly disable a historical rule after its group is archived, without reactivating it', async () => {
      await initialize();
      const g = await create();
      const created = await rule({
        dataset: 'expenses',
        category: 'транспорт',
        groupId: g.groupId,
      });
      assert.equal(created.status, 201);
      const x = created.body.result;
      assert.equal(
        (await req('DELETE', '/' + g.groupId, { expectedRevision: 1 })).status,
        200,
      );
      const r = await req('PATCH', '/rules/' + x.id, {
        expectedEtag: x.etag,
        enabled: false,
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.result.diagnostic, 'disabled');
      assert.equal(r.body.result.group.status, 'archived');
      assert.equal(
        await db.collection('operation_classifications').countDocuments({}),
        0,
      );
      assert.equal(
        (
          await req('PATCH', '/rules/' + x.id, {
            expectedEtag: r.body.result.etag,
            enabled: true,
          })
        ).status,
        409,
      );
    });
  },
);
