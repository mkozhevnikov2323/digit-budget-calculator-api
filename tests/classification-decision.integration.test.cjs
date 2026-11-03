const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createHarness } = require('./helpers/mongodb-integration.cjs');
const owner = 'a'.repeat(24),
  foreign = 'b'.repeat(24),
  id = '1'.repeat(24),
  version = 'classification-decision-v1';
describe(
  'Single PUT decision: real compiled app and disposable MongoDB',
  { concurrency: false, timeout: 120000 },
  () => {
    let h, db, manifest, saved;
    const token = (who = owner) =>
      jwt.sign({ _id: who, exp: 4102444800 }, 'super-secret-key');
    const oid = (x) => new h.mongoose.Types.ObjectId(x);
    const facts = {
      amount: { format: 'binary64-roundtrip-decimal', value: '12.34' },
      dateEpochMs: 1736942400000,
      date: '2025-01-15T12:00:00.000Z',
      category: 'Транспорт',
      title: 'Synthetic fuel',
      recipient: 'Synthetic',
      comment: { kind: 'missing' },
    };
    const command = (extra = {}) => ({
      version,
      requestId: randomUUID(),
      expectedRevision: null,
      state: 'approved',
      assignment: { economicRole: 'ordinary_expense', layer: 'everyday' },
      expectedFacts: facts,
      ...extra,
    });
    const put = (body, who = owner, dataset = 'expenses') =>
      h.request(
        'PUT',
        `/classifications/${dataset}/${id}/decision`,
        body,
        token(who),
      );
    before(async () => {
      h = await createHarness(process.env);
      db = h.mongoose.connection.db;
      manifest =
        require('../dist/persistence/classificationManifest').CLASSIFICATION_MANIFEST;
      saved = process.env.CLASSIFICATION_C_WRITE_ENABLED;
    });
    beforeEach(async () => {
      mock.restoreAll();
      process.env.CLASSIFICATION_C_WRITE_ENABLED = '1';
      h.assertDatabase();
      for (const name of ['users', 'expenses', 'incomes'])
        await db.collection(name).deleteMany({});
      await db
        .collection('users')
        .insertMany([{ _id: oid(owner) }, { _id: oid(foreign) }]);
      await db
        .collection('expenses')
        .insertOne({
          _id: oid(id),
          owner: oid(owner),
          amount: 12.34,
          date: new Date(facts.date),
          category: facts.category,
          title: facts.title,
          recipient: facts.recipient,
        });
      await db
        .collection('incomes')
        .insertOne({
          _id: oid(id),
          owner: oid(owner),
          amount: 12.34,
          date: new Date(facts.date),
          source: 'Synthetic salary',
        });
      if (await db.listCollections({ name: manifest.collectionName }).hasNext())
        await db.collection(manifest.collectionName).drop();
      await db.createCollection(manifest.collectionName, manifest.options);
      await db
        .collection(manifest.collectionName)
        .createIndex(manifest.index.key, manifest.index.options);
    });
    after(async () => {
      mock.restoreAll();
      if (saved === undefined)
        delete process.env.CLASSIFICATION_C_WRITE_ENABLED;
      else process.env.CLASSIFICATION_C_WRITE_ENABLED = saved;
      assert.deepEqual(await h.close(), {
        dropped: true,
        disconnected: true,
        listenerClosed: true,
        logsClosed: true,
        directoryRemoved: true,
        environmentRestored: true,
      });
      console.info(
        'Decision test-owned database dropped and verified empty; resources released.',
      );
    });
    it('creates, updates and replaces approval with explicit unclassified in one PUT each, sources unchanged', async () => {
      const before = await db.collection('expenses').findOne({ _id: oid(id) });
      let r = await put(command());
      assert.equal(r.status, 201);
      assert.equal(r.body.outcome, 'created');
      assert.equal(r.body.decision.status, 'approved');
      assert.deepEqual(r.body.decision.confirmed, {
        economicRole: 'ordinary_expense',
        layer: 'everyday',
      });
      assert.equal(r.body.decision.decisionRevision, 1);
      r = await put(
        command({
          expectedRevision: 1,
          assignment: { economicRole: 'ordinary_expense', layer: 'irregular' },
        }),
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.outcome, 'updated');
      assert.equal(r.body.decision.confirmed.layer, 'irregular');
      const body = command({
        expectedRevision: 2,
        state: 'explicit_unclassified',
      });
      delete body.assignment;
      r = await put(body);
      assert.equal(r.status, 200);
      assert.equal(r.body.decision.status, 'explicit_unclassified');
      assert.equal(r.body.decision.confirmed, null);
      assert.equal(r.body.decision.decisionRevision, 3);
      assert.deepEqual(
        await db.collection('expenses').findOne({ _id: oid(id) }),
        before,
      );
    });
    it('rejects foreign ownership, mismatched facts, cleared and extra assignment without writes', async () => {
      assert.equal((await put(command(), foreign)).status, 404);
      assert.equal(
        (
          await put(
            command({ expectedFacts: { ...facts, title: 'Different' } }),
          )
        ).status,
        409,
      );
      assert.equal((await put(command({ state: 'cleared' }))).status, 400);
      assert.equal(
        (await put(command({ state: 'explicit_unclassified' }))).status,
        400,
      );
      assert.equal(
        await db.collection(manifest.collectionName).countDocuments({}),
        0,
      );
    });
    it('replays the same request without incrementing revision and conflicts on reused or stale intents', async () => {
      const body = command();
      assert.equal((await put(body)).status, 201);
      const repeat = await put(body);
      assert.equal(repeat.status, 200);
      assert.equal(repeat.body.outcome, 'replayed');
      assert.equal(repeat.body.decision.decisionRevision, 1);
      assert.equal(
        (
          await put({
            ...body,
            assignment: {
              economicRole: 'ordinary_expense',
              layer: 'irregular',
            },
          })
        ).status,
        409,
      );
      assert.equal((await put(command())).status, 409);
      assert.equal(
        await db.collection(manifest.collectionName).countDocuments({}),
        1,
      );
    });
    it('supports incomes and preserves missing/null comments exactly', async () => {
      const expectedFacts = {
        amount: facts.amount,
        date: facts.date,
        dateEpochMs: facts.dateEpochMs,
        source: 'Synthetic salary',
        comment: { kind: 'null' },
      };
      assert.equal(
        (
          await put(
            command({
              expectedFacts,
              assignment: { economicRole: 'ordinary_income', layer: null },
            }),
            owner,
            'incomes',
          )
        ).status,
        409,
      );
      await db
        .collection('incomes')
        .updateOne({ _id: oid(id) }, { $set: { comment: null } });
      const r = await put(
        command({
          expectedFacts,
          assignment: { economicRole: 'ordinary_income', layer: null },
        }),
        owner,
        'incomes',
      );
      assert.equal(r.status, 201);
      assert.equal(r.body.decision.confirmed.economicRole, 'ordinary_income');
    });
    it('uses the existing default-off gate', async () => {
      delete process.env.CLASSIFICATION_C_WRITE_ENABLED;
      assert.equal((await put(command())).status, 503);
    });
    it('never reports success for a lost acknowledgement', async () => {
      const proto = Object.getPrototypeOf(
          db.collection(manifest.collectionName),
        ),
        original = proto.insertOne;
      mock.method(proto, 'insertOne', async function (...args) {
        const result = await original.apply(this, args);
        if (this.collectionName === manifest.collectionName)
          throw new Error('Synthetic lost acknowledgement');
        return result;
      });
      const r = await put(command());
      assert.equal(r.status, 503);
      assert.equal(r.body.persistence, 'unknown');
      assert.equal(
        await db.collection(manifest.collectionName).countDocuments({}),
        1,
      );
    });
    it('reports stale when a source edit is observed after the classification write', async () => {
      const proto = Object.getPrototypeOf(
          db.collection(manifest.collectionName),
        ),
        original = proto.insertOne;
      mock.method(proto, 'insertOne', async function (...args) {
        const result = await original.apply(this, args);
        if (this.collectionName === manifest.collectionName)
          await db
            .collection('expenses')
            .updateOne({ _id: oid(id) }, { $set: { amount: 13 } });
        return result;
      });
      const r = await put(command());
      assert.equal(r.status, 201);
      assert.equal(r.body.decision.status, 'stale');
      assert.equal(r.body.decision.confirmed, null);
    });
    it('fails unknown when post-write observation is unavailable', async () => {
      const proto = Object.getPrototypeOf(
          db.collection(manifest.collectionName),
        ),
        insert = proto.insertOne,
        find = proto.findOne;
      let written = false;
      mock.method(proto, 'insertOne', async function (...args) {
        const result = await insert.apply(this, args);
        if (this.collectionName === manifest.collectionName) written = true;
        return result;
      });
      mock.method(proto, 'findOne', async function (...args) {
        if (written && this.collectionName === 'expenses')
          throw new Error('Synthetic read outage');
        return find.apply(this, args);
      });
      const r = await put(command());
      assert.equal(r.status, 503);
      assert.equal(r.body.persistence, 'unknown');
    });
  },
);
