const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { performance } = require('node:perf_hooks');
const { createHarness } = require('./helpers/mongodb-integration.cjs');
const owner = 'a'.repeat(24),
  foreign = 'b'.repeat(24),
  id = '1'.repeat(24),
  version = 'classification-c-v1';
describe(
  'Architecture C: compiled HTTP and disposable MongoDB',
  { concurrency: false, timeout: 120000 },
  () => {
    let h, db, manifest, saved, collection;
    const token = (who = owner, extra = {}) =>
      jwt.sign(
        { _id: who, iat: 1700000000, exp: 4102444800, ...extra },
        'super-secret-key',
      );
    const call = (action, body, credential = token(), dataset = 'expenses') =>
      h.request(
        'POST',
        `/classifications/${dataset}/${id}/c-v1/${action}`,
        body,
        credential,
      );
    const command = (extra = {}) => ({
      kind: 'manual_classification',
      dataset: 'expenses',
      operationId: id,
      requestId: randomUUID(),
      expectedRevision: null,
      state: 'approved',
      assignment: { economicRole: 'ordinary_expense', layer: 'everyday' },
      ...extra,
    });
    const prepare = async (c = command()) => {
      const r = await call(
        'prepare',
        { version, command: c },
        token(),
        c.dataset,
      );
      assert.equal(r.status, 200);
      return r.body;
    };
    const apply = (p, extra = {}, credential = token()) =>
      call(
        'apply',
        {
          version,
          preparationId: p.preparationId,
          confirmation: 'confirm_prepared_intent',
          ...extra,
        },
        credential,
        p.command.dataset,
      );
    const reconcile = (p) =>
      call(
        'reconcile',
        { version, preparationId: p.preparationId },
        token(),
        p.command.dataset,
      );
    const oid = (x) => new h.mongoose.Types.ObjectId(x);
    before(async () => {
      h = await createHarness(process.env);
      db = h.mongoose.connection.db;
      manifest =
        require('../dist/persistence/classificationManifest').CLASSIFICATION_MANIFEST;
      saved = process.env.CLASSIFICATION_C_WRITE_ENABLED;
      const info = await db.admin().serverInfo();
      console.info('Disposable MongoDB version: ' + info.version);
    });
    beforeEach(async () => {
      process.env.CLASSIFICATION_C_WRITE_ENABLED = '1';
      mock.restoreAll();
      h.assertDatabase();
      for (const name of ['expenses', 'incomes', 'users'])
        await db.collection(name).deleteMany({});
      await db
        .collection('users')
        .insertMany([{ _id: oid(owner) }, { _id: oid(foreign) }]);
      await db.collection('expenses').insertOne({
        _id: oid(id),
        owner: oid(owner),
        amount: 12.34,
        date: new Date('2025-01-15T12:00:00Z'),
        category: 'Транспорт',
        title: 'Synthetic fuel',
        recipient: 'Synthetic',
      });
      await db.collection('incomes').insertOne({
        _id: oid(id),
        owner: oid(owner),
        amount: 30,
        date: new Date('2025-01-15T12:00:00Z'),
        source: 'Synthetic salary',
      });
      if (await db.listCollections({ name: manifest.collectionName }).hasNext())
        await db.collection(manifest.collectionName).drop();
      await db.createCollection(manifest.collectionName, manifest.options);
      await db
        .collection(manifest.collectionName)
        .createIndex(manifest.index.key, manifest.index.options);
      collection = db.collection(manifest.collectionName);
    });
    after(async () => {
      mock.restoreAll();
      if (saved === undefined)
        delete process.env.CLASSIFICATION_C_WRITE_ENABLED;
      else process.env.CLASSIFICATION_C_WRITE_ENABLED = saved;
      if (h) {
        assert.deepEqual(await h.close(), {
          dropped: true,
          disconnected: true,
          listenerClosed: true,
          logsClosed: true,
          directoryRemoved: true,
          environmentRestored: true,
        });
        console.info(
          'C test-owned MongoDB dropped and verified empty; HTTP/logs released.',
        );
      }
    });
    it('default-off and legacy P11 stays disabled', async () => {
      delete process.env.CLASSIFICATION_C_WRITE_ENABLED;
      assert.equal(
        (await call('prepare', { version, command: command() })).status,
        503,
      );
      assert.equal(
        (
          await h.request(
            'POST',
            `/classifications/expenses/${id}/reviews`,
            {},
            token(),
          )
        ).status,
        503,
      );
    });
    it('requires real JWT, expiration and existing account', async () => {
      for (const credential of [
        '',
        'invalid',
        token(owner, { exp: 1 }),
        token('c'.repeat(24)),
      ])
        assert.equal(
          (await call('prepare', { version, command: command() }, credential))
            .status,
          401,
        );
    });
    it('isolates owner before facts are exposed', async () => {
      assert.equal(
        (await call('prepare', { version, command: command() }, token(foreign)))
          .status,
        404,
      );
    });
    it('requires prior preparation and explicit confirmation', async () => {
      const p = await prepare();
      assert.equal(await collection.countDocuments(), 0);
      assert.equal((await apply(p, { confirmation: undefined })).status, 400);
      assert.equal(
        (await apply(p, { preparationId: 'x'.repeat(43) })).status,
        410,
      );
      assert.equal(await collection.countDocuments(), 0);
    });
    it('binds exact bearer session and owner', async () => {
      const p = await prepare();
      for (const t of [token(foreign), token(owner, { jti: 'new-session' })])
        assert.equal((await apply(p, {}, t)).status, 403);
      assert.equal((await apply(p, {}, '')).status, 401);
      assert.equal(await collection.countDocuments(), 0);
    });
    it('returns current facts and decision, never writes sources', async () => {
      const before = await db.collection('expenses').findOne({ _id: oid(id) }),
        p = await prepare();
      assert.equal(p.facts.amount.value, '12.34');
      assert.equal(p.currentDecision.decisionRevision, null);
      const r = await apply(p);
      assert.equal(r.status, 201);
      assert.equal(r.body.result.value.decisionRevision, 1);
      assert.equal(r.body.result.value.confirmed, null);
      assert.deepEqual(
        await db.collection('expenses').findOne({ _id: oid(id) }),
        before,
      );
    });
    it('duplicate apply returns receipt without another write', async () => {
      const p = await prepare();
      assert.equal((await apply(p)).status, 201);
      assert.equal((await apply(p)).status, 200);
      assert.equal((await collection.findOne({})).decisionRevision, 1);
      assert.equal((await reconcile(p)).body.outcome, 'latest_applied');
    });
    it('cannot alter prepared intent or supply financial facts', async () => {
      const p = await prepare();
      for (const extra of [
        { command: command() },
        { owner },
        { sourceFingerprint: 'f'.repeat(64) },
        { expectedRevision: 1 },
      ])
        assert.equal((await apply(p, extra)).status, 400);
      assert.equal(await collection.countDocuments(), 0);
    });
    it('concurrent same-context apply has one admission', async () => {
      const p = await prepare();
      const r = await Promise.all([apply(p), apply(p)]);
      assert.equal(r.filter((x) => x.status === 201).length, 1);
      assert.equal((await collection.findOne({})).decisionRevision, 1);
    });
    it('concurrent different intents have one CAS winner', async () => {
      const p = await prepare(),
        q = await prepare(
          command({
            assignment: {
              economicRole: 'ordinary_expense',
              layer: 'irregular',
            },
          }),
        );
      const r = await Promise.all([apply(p), apply(q)]);
      assert.equal(r.filter((x) => x.body.result?.ok).length, 1);
      assert.equal(await collection.countDocuments(), 1);
    });
    it('same requestId and intent replay across preparations is idempotent', async () => {
      const c = command(),
        p = await prepare(c),
        q = await prepare(c);
      assert.equal((await apply(p)).status, 201);
      const r = await apply(q);
      assert.equal(r.body.result.value.outcome, 'replayed');
      assert.equal((await collection.findOne({})).decisionRevision, 1);
    });
    it('same requestId with different intent conflicts', async () => {
      const c = command(),
        p = await prepare(c),
        q = await prepare({
          ...c,
          assignment: { economicRole: 'ordinary_expense', layer: 'irregular' },
        });
      await apply(p);
      assert.equal(
        (await apply(q)).body.result.error.code,
        'request_id_conflict',
      );
    });
    it('rejects stale expected revision at preparation', async () => {
      await apply(await prepare());
      assert.equal(
        (await call('prepare', { version, command: command() })).status,
        409,
      );
    });
    it('updates decision with current revision and preserves source', async () => {
      await apply(await prepare());
      const p = await prepare(
        command({
          expectedRevision: 1,
          state: 'cleared',
          assignment: undefined,
        }),
      );
      assert.equal((await apply(p)).body.result.value.decisionRevision, 2);
    });
    for (const dataset of ['expenses', 'incomes'])
      for (const change of ['amount', 'delete'])
        it(`rejects ${change} after ${dataset} preparation`, async () => {
          const p = await prepare(
            command({
              dataset,
              assignment:
                dataset === 'expenses'
                  ? { economicRole: 'ordinary_expense', layer: 'everyday' }
                  : { economicRole: 'ordinary_income', layer: null },
            }),
          );
          if (change === 'delete')
            await db.collection(dataset).deleteOne({ _id: oid(id) });
          else
            await db
              .collection(dataset)
              .updateOne({ _id: oid(id) }, { $set: { amount: 99 } });
          const r = await apply(p);
          assert.equal(r.body.result.ok, false);
          assert.equal(
            r.body.result.error.code,
            change === 'delete' ? 'source_not_found' : 'stale_review',
          );
          assert.equal(await collection.countDocuments(), 0);
        });
    it('income apply leaves financial source unchanged', async () => {
      const before = await db.collection('incomes').findOne({});
      const p = await prepare(
        command({
          dataset: 'incomes',
          assignment: { economicRole: 'refund', layer: null },
        }),
      );
      assert.equal((await apply(p)).status, 201);
      assert.deepEqual(await db.collection('incomes').findOne({}), before);
    });
    it('expired preparation cannot apply', async () => {
      const p = await prepare();
      const tick = performance.now();
      mock.method(performance, 'now', () => tick + 300001);
      assert.equal((await apply(p)).status, 410);
    });
    it('lost acknowledgement is reconciled by read only, never retried', async () => {
      const p = await prepare();
      const proto = h.mongoose.mongo.Collection.prototype,
        original = proto.insertOne;
      let writes = 0;
      mock.method(proto, 'insertOne', async function (...args) {
        writes++;
        const result = await Reflect.apply(original, this, args);
        if (this.collectionName === manifest.collectionName)
          throw new Error('Synthetic lost acknowledgement');
        return result;
      });
      const r = await apply(p);
      assert.equal(r.body.result.persistence, 'unknown');
      assert.equal((await reconcile(p)).body.outcome, 'latest_applied');
      await apply(p);
      assert.equal(writes, 1);
    });
    it('reconcile never creates absent decisions', async () => {
      const p = await prepare();
      assert.equal((await reconcile(p)).status, 409);
      assert.equal(await collection.countDocuments(), 0);
    });
    it('reconcile remains indeterminate after newer decision', async () => {
      const p = await prepare();
      await apply(p);
      await apply(
        await prepare(
          command({
            expectedRevision: 1,
            state: 'cleared',
            assignment: undefined,
          }),
        ),
      );
      assert.equal((await reconcile(p)).body.outcome, 'indeterminate');
    });
    it('new process-local handler rejects previous preparation without writer access', async () => {
      const p = await prepare();
      const {
        createClassificationC,
      } = require('../dist/services/classificationC');
      const handler = createClassificationC(h.mongoose.connection);
      let status, body;
      const res = {
        set() {
          return this;
        },
        vary() {
          return this;
        },
        status(x) {
          status = x;
          return this;
        },
        json(x) {
          body = x;
          return this;
        },
      };
      await handler(
        {
          headers: { authorization: 'Bearer ' + token() },
          user: { _id: owner, exp: 4102444800 },
          path: '/expenses/' + id + '/c-v1/apply',
          params: { dataset: 'expenses', operationId: id },
          body: {
            version,
            preparationId: p.preparationId,
            confirmation: 'confirm_prepared_intent',
          },
        },
        res,
        () => {},
      );
      assert.equal(status, 410);
      assert.equal(body.persistence, 'unknown');
      assert.equal(await collection.countDocuments(), 0);
    });
    it('rejects duplicate JSON keys and foreign origins on C endpoints', async () => {
      assert.equal(
        (
          await h.request(
            'POST',
            `/classifications/expenses/${id}/c-v1/prepare`,
            undefined,
            token(),
            { rawBody: '{"version":1,"version":2}' },
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await h.request(
            'POST',
            `/classifications/expenses/${id}/c-v1/prepare`,
            {},
            token(),
            { headers: { Origin: 'https://untrusted.invalid' } },
          )
        ).status,
        403,
      );
    });
    it('malformed source fails closed before any preparation can authorize writing', async () => {
      await db
        .collection('expenses')
        .updateOne({ _id: oid(id) }, { $set: { amount: '12.34' } });
      assert.equal(
        (await call('prepare', { version, command: command() })).status,
        503,
      );
      assert.equal(await collection.countDocuments(), 0);
    });
    it('missing manifest is not repaired by the protocol', async () => {
      await collection.drop();
      assert.equal(
        (await call('prepare', { version, command: command() })).status,
        503,
      );
      assert.equal(
        await db.listCollections({ name: manifest.collectionName }).hasNext(),
        false,
      );
    });
    it('read and history APIs remain compatible after C write', async () => {
      await apply(await prepare());
      const old = process.env.CLASSIFICATION_READ_ENABLED;
      const oldHistory = process.env.CLASSIFICATION_HISTORY_READ_ENABLED;
      process.env.CLASSIFICATION_HISTORY_READ_ENABLED = '1';
      process.env.CLASSIFICATION_READ_ENABLED = '1';
      try {
        const r = await h.request(
          'GET',
          `/classifications/expenses/${id}`,
          undefined,
          token(),
        );
        assert.equal(r.status, 200);
        assert.equal(r.body.status, 'approved');
        const history = await h.request(
          'POST',
          '/classifications/history/read',
          {
            version: 'classification-history-read-request-v1',
            startInclusive: Date.parse('2025-01-01T00:00:00Z'),
            endExclusive: Date.parse('2025-02-01T00:00:00Z'),
            operations: [{ dataset: 'expenses', operationId: id }],
          },
          token(),
        );
        assert.equal(history.status, 200);
        assert.equal(
          history.body.operations[0].classification.status,
          'approved',
        );
      } finally {
        if (oldHistory === undefined)
          delete process.env.CLASSIFICATION_HISTORY_READ_ENABLED;
        else process.env.CLASSIFICATION_HISTORY_READ_ENABLED = oldHistory;
        if (old === undefined) delete process.env.CLASSIFICATION_READ_ENABLED;
        else process.env.CLASSIFICATION_READ_ENABLED = old;
      }
    });
    it('wall-clock rollback does not extend preparation lifetime', async () => {
      const p = await prepare(),
        tick = performance.now();
      mock.method(Date, 'now', () => p.expiresAt - 600000);
      mock.method(performance, 'now', () => tick + 300001);
      assert.equal((await apply(p)).status, 410);
      assert.equal(await collection.countDocuments(), 0);
    });
    it('bounds retained preparations and refuses excess without writes', async () => {
      let full = false;
      for (let i = 0; i <= 256; i++) {
        const r = await call('prepare', { version, command: command() });
        if (r.status === 503) {
          assert.equal(r.body.error.code, 'capacity_exceeded');
          full = true;
          break;
        }
        assert.equal(r.status, 200);
      }
      assert.equal(full, true);
      assert.equal(await collection.countDocuments(), 0);
    });
  },
);
