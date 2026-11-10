const { describe, it, mock, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const g = require('../dist/domain/classification/groups');
const p = require('../dist/persistence/classificationGroups');
const { matchRule } = require('../dist/services/classificationGroups/rules');
const {
  windowFields,
} = require('../dist/services/classificationGroups/report');
const {
  parseGroupMigrationArguments: parse,
} = require('../dist/scripts/migrateClassificationGroups');
const forbidden = () => {
  throw new Error('Database access forbidden in unit tests');
};
const guards = [
  mock.method(mongoose, 'connect', forbidden),
  mock.method(mongoose, 'createConnection', forbidden),
];
after(() => {
  for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
  mock.restoreAll();
});
const doc = () => ({
  _id: new mongoose.Types.ObjectId(),
  owner: new mongoose.Types.ObjectId(),
  dataset: 'expenses',
  groupId: `custom:${randomUUID()}`,
  name: 'Автомобиль',
  normalizedName: 'автомобиль',
  origin: 'custom',
  status: 'active',
  revision: 1,
  createdAt: new Date(0),
  updatedAt: new Date(1),
});
describe('classification groups: pure identities, closed BSON mapping and migration safety', () => {
  it('model validates whole closed records, disables casting and implicit DDL', async () => {
    const connection = new mongoose.Mongoose().connection;
    const {
      createClassificationGroupModel,
    } = require('../dist/models/classificationGroup');
    const Model = createClassificationGroupModel(connection);
    assert.equal(Model.schema.options.autoCreate, false);
    assert.equal(Model.schema.options.autoIndex, false);
    assert.equal(Model.schema.indexes().length, 2);
    await new Model(doc()).validate();
    for (const patch of [
      { revision: '1' },
      { status: 'other' },
      { dataset: 'loans' },
      { normalizedName: 'other' },
      { name: '' },
      { origin: 'system' },
    ])
      await assert.rejects(new Model({ ...doc(), ...patch }).validate());
    assert.throws(() => new Model({ ...doc(), extra: true }));
  });
  it('defines ten primary system identities plus explicit historical compatibility identities', () => {
    assert.equal(
      g.SYSTEM_GROUPS.filter((x) => !x.compatibilityOnly).length,
      10,
    );
    assert.equal(
      new Set(g.SYSTEM_GROUPS.map((x) => x.groupId)).size,
      g.SYSTEM_GROUPS.length,
    );
    assert.equal(
      g.legacyGroup('expenses', {
        economicRole: 'ordinary_expense',
        layer: 'everyday',
      }),
      'system:expenses:everyday',
    );
    assert.equal(
      g.legacyGroup('expenses', { economicRole: 'loan_issuance', layer: null }),
      'system:expenses:role:loan_issuance',
    );
    assert.equal(
      g.legacyGroup('incomes', { economicRole: 'loan_repayment', layer: null }),
      'system:incomes:loan_repayment',
    );
  });
  it('rejects coercions, unknown system identities and trailing newlines', () => {
    for (const x of [null, {}, ['expenses'], 1, 'other'])
      assert.equal(g.dataset(x), false);
    for (const x of [
      'a'.repeat(24) + '\n',
      'A'.repeat(24),
      new String('a'.repeat(24)),
    ])
      assert.equal(g.id(x), false);
    for (const x of [
      `custom:${randomUUID()}\n`,
      'system:expenses:imaginary',
      `custom:${'a'.repeat(36)}`,
    ])
      assert.equal(g.groupId(x), false);
    assert.equal(g.uuid(randomUUID() + '\n'), false);
    assert.equal(g.groupId(doc().groupId), true);
  });
  it('validates display names without Unicode normalization and rejects invalid encodings', () => {
    assert.equal(g.normalizeGroupName('  СЕМЬЯ  '), 'семья');
    for (const x of ['', ' ', ' name', 'name\n', '\ud800', 'a'.repeat(121), 23])
      assert.equal(g.validGroupName(x), false);
    assert.equal(g.validGroupName('Ёж и семья'), true);
    assert.notEqual(g.normalizeGroupName('é'), g.normalizeGroupName('e\u0301'));
  });
  it('requires complete primitive BSON data, timestamps, origin and dataset consistency', () => {
    const row = doc();
    assert.ok(p.groupFromBson(row));
    for (const patch of [
      { revision: '1' },
      { revision: 0 },
      { dataset: 'loans' },
      { owner: row.owner.toHexString() },
      { normalizedName: 'other' },
      { updatedAt: new Date(-1) },
      { origin: 'system' },
      { groupId: 'system:incomes:refund' },
      { surprise: true },
    ])
      assert.equal(p.groupFromBson({ ...row, ...patch }), null);
    const system = {
      ...row,
      groupId: 'system:expenses:everyday',
      origin: 'system',
    };
    assert.ok(p.groupFromBson(system));
    assert.equal(p.groupFromBson({ ...system, status: 'archived' }), null);
  });
  it('never invokes accessors or toJSON while mapping groups', () => {
    let calls = 0;
    const row = doc();
    Object.defineProperty(row, 'name', {
      enumerable: true,
      get() {
        calls++;
        return 'unsafe';
      },
    });
    assert.equal(p.groupFromBson(row), null);
    assert.equal(
      p.groupFromBson({
        ...doc(),
        toJSON() {
          calls++;
        },
      }),
      null,
    );
    assert.equal(
      p.groupFromBson(Object.assign(Object.create({ extra: true }), doc())),
      null,
    );
    assert.equal(calls, 0);
  });
  it('preserves input objects and emits a safe metadata-only view', () => {
    const row = doc(),
      before = mongoose.mongo.BSON.serialize(row);
    const parsed = p.groupFromBson(row);
    assert.equal(p.groupView(parsed).name, 'Автомобиль');
    assert.deepEqual(mongoose.mongo.BSON.serialize(row), before);
    assert.equal(Object.hasOwn(p.groupView(parsed), 'owner'), false);
  });
  it('rejects malformed legacy/group rule combinations', () => {
    const row = { ...doc(), enabled: true, category: 'транспорт', version: 3 };
    delete row.name;
    delete row.normalizedName;
    delete row.origin;
    delete row.status;
    assert.ok(p.ruleFromBson(row));
    for (const patch of [
      { category: ' Транспорт ' },
      { source: 'salary' },
      { economicRole: 'ordinary_expense' },
      { version: 2 },
      { groupId: 'system:incomes:refund' },
    ])
      assert.equal(p.ruleFromBson({ ...row, ...patch }), null);
  });
  it('prefers category/title over category and never implicitly falls through inactive targets', () => {
    const general = {
        id: '1',
        dataset: 'expenses',
        enabled: true,
        category: 'транспорт',
        groupId: 'general',
        etag: 'a',
        diagnostic: 'ready',
      },
      specific = {
        ...general,
        id: '2',
        title: 'ремонт',
        groupId: 'specific',
        diagnostic: 'group_inactive',
      };
    assert.equal(
      matchRule([general, specific], 'expenses', {
        category: ' ТРАНСПОРТ ',
        title: ' РЕМОНТ ',
      }).groupId,
      'specific',
    );
    assert.equal(
      matchRule([general, specific], 'expenses', {
        category: 'транспорт',
        title: 'топливо',
      }).groupId,
      'general',
    );
    assert.equal(
      matchRule([{ ...specific, enabled: false }], 'expenses', {
        category: 'транспорт',
        title: 'ремонт',
      }),
      null,
    );
    assert.equal(
      matchRule(
        [{ ...general, dataset: 'incomes', source: 'зарплата' }],
        'incomes',
        { source: ' ЗАРПЛАТА ' },
      ).groupId,
      'general',
    );
  });
  it('bounds periods and rejects coercion, reversed dates and unbounded queries', () => {
    assert.deepEqual(windowFields({ startInclusive: 0, endExclusive: 1 }), {
      startInclusive: 0,
      endExclusive: 1,
    });
    for (const input of [
      { startInclusive: '0', endExclusive: 1 },
      { startInclusive: 1, endExclusive: 1 },
      { startInclusive: 0, endExclusive: 367 * 86400000 },
      { startInclusive: NaN, endExclusive: 1 },
    ])
      assert.throws(
        () => windowFields(input),
        (e) => e.code === 'invalid_period',
      );
  });
  it('defaults migration to read-only and requires explicit database and environment', () => {
    assert.deepEqual(parse(['--db', 'budget_test', '--environment', 'local']), {
      dbName: 'budget_test',
      environment: 'local',
      mode: 'dry-run',
      backupConfirmed: false,
    });
    assert.equal(
      parse([
        '--db',
        'budget_test',
        '--environment',
        'local',
        '--confirm-write',
        '--backup-confirmed',
      ]).mode,
      'apply',
    );
    for (const args of [
      [],
      ['--db', 'admin', '--environment', 'local'],
      ['--db', 'budget', '--environment', 'production'],
      ['--db', 'budget', '--db', 'other', '--environment', 'local'],
      [
        '--db',
        'budget',
        '--environment',
        'local',
        '--verify',
        '--confirm-write',
      ],
      ['--db', 'budget', '--environment', 'local', '--unknown'],
    ])
      assert.throws(() => parse(args));
  });
});
