import { isDeepStrictEqual } from 'node:util';
import type { mongo } from 'mongoose';
import { CLASSIFICATION_MANIFEST as legacy } from './classificationManifest';
import { SYSTEM_GROUPS } from '../domain/classification/groups';
import { FINANCIAL_LAYERS } from '../domain/classification';
const integer = {
  bsonType: ['int', 'long', 'double'],
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
};
const text = { bsonType: 'string', minLength: 1, maxLength: 8192 };
const oid = { bsonType: 'objectId' };
const digest = {
  bsonType: 'string',
  pattern: '^[a-f0-9]{64}$',
  minLength: 64,
  maxLength: 64,
};
const customRef = {
  bsonType: 'string',
  minLength: 43,
  maxLength: 43,
  pattern:
    '^custom:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
};
const groupRef = {
  bsonType: 'string',
  anyOf: [{ enum: SYSTEM_GROUPS.map((g) => g.groupId) }, customRef],
};
const scopedReference = {
  $or: ['expenses', 'incomes'].map((dataset) => ({
    dataset,
    $or: [
      {
        groupId: {
          $in: SYSTEM_GROUPS.filter((g) => g.dataset === dataset).map(
            (g) => g.groupId,
          ),
        },
      },
      { groupId: { $regex: customRef.pattern, $type: 'string' } },
    ],
  })),
};
const options = (validator: object) => ({
  collation: { locale: 'simple' },
  validationLevel: 'strict' as const,
  validationAction: 'error' as const,
  validator,
});
const strict = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required,
    properties,
  },
});
export const GROUPS_MANIFEST = {
  collectionName: 'classification_groups',
  options: options({
    $and: [
      strict({
        _id: oid,
        owner: oid,
        dataset: { enum: ['expenses', 'incomes'] },
        groupId: groupRef,
        name: { ...text, maxLength: 120 },
        normalizedName: { ...text, maxLength: 120 },
        origin: { enum: ['system', 'custom'] },
        status: { enum: ['active', 'disabled', 'archived'] },
        revision: integer,
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
      }),
      {
        $or: [
          ...SYSTEM_GROUPS.map((g) => ({
            groupId: g.groupId,
            dataset: g.dataset,
            origin: 'system',
            status: { $in: ['active', 'disabled'] },
          })),
          { origin: 'custom', groupId: { $regex: customRef.pattern } },
        ],
      },
      { $expr: { $lte: ['$createdAt', '$updatedAt'] } },
    ],
  }),
  indexes: [
    {
      key: { owner: 1, groupId: 1 } as const,
      options: {
        name: 'ux_group_owner_identity',
        unique: true,
        collation: { locale: 'simple' },
      },
    },
    {
      key: { owner: 1, dataset: 1, normalizedName: 1 } as const,
      options: {
        name: 'ux_group_owner_dataset_name',
        unique: true,
        collation: { locale: 'simple' },
      },
    },
  ],
};
const v3 = strict(
  {
    _id: oid,
    owner: oid,
    dataset: { enum: ['expenses', 'incomes'] },
    operationId: oid,
    taxonomyVersion: { enum: ['financial-classification-groups-v3'] },
    decisionOrigin: { enum: ['manual'] },
    decisionRevision: integer,
    state: { enum: ['approved', 'explicit_unclassified', 'cleared'] },
    groupId: groupRef,
    sourceFingerprint: digest,
    sourceFingerprintVersion: { enum: [1] },
    sourceObservedAt: { bsonType: 'date' },
    createdAt: { bsonType: 'date' },
    updatedAt: { bsonType: 'date' },
    lastMutation: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'requestId',
        'commandFingerprint',
        'commandFingerprintVersion',
      ],
      properties: {
        requestId: {
          bsonType: 'string',
          minLength: 36,
          maxLength: 36,
          pattern:
            '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
        },
        commandFingerprint: digest,
        commandFingerprintVersion: { enum: [1] },
      },
    },
  },
  [
    '_id',
    'owner',
    'dataset',
    'operationId',
    'taxonomyVersion',
    'decisionOrigin',
    'decisionRevision',
    'state',
    'sourceFingerprint',
    'sourceFingerprintVersion',
    'sourceObservedAt',
    'createdAt',
    'updatedAt',
    'lastMutation',
  ],
);
export const GROUP_DECISION_MANIFEST = {
  collectionName: legacy.collectionName,
  options: options({
    $or: [
      legacy.options.validator,
      {
        $and: [
          v3,
          {
            $or: [
              { state: 'approved', $and: [scopedReference] },
              {
                state: { $in: ['explicit_unclassified', 'cleared'] },
                groupId: { $exists: false },
              },
            ],
          },
          { $expr: { $lte: ['$createdAt', '$updatedAt'] } },
        ],
      },
    ],
  }),
  indexes: [legacy.index],
};
// Keep legacy rule records unchanged; v3 uses a stable group reference instead of fake roles.
const common = {
  _id: oid,
  owner: oid,
  dataset: { enum: ['expenses', 'incomes'] },
  enabled: { bsonType: 'bool' },
  category: text,
  title: text,
  source: text,
  economicRole: { bsonType: 'string' },
  layer: { bsonType: ['string', 'null'] },
  groupId: groupRef,
  version: { enum: [3] },
  revision: integer,
  createdAt: { bsonType: 'date' },
  updatedAt: { bsonType: 'date' },
};
export const GROUP_RULES_MANIFEST = {
  collectionName: 'classification_rules',
  options: options({
    $and: [
      strict(common, [
        '_id',
        'owner',
        'dataset',
        'enabled',
        'createdAt',
        'updatedAt',
      ]),
      {
        $or: [
          {
            groupId: { $exists: false },
            version: { $exists: false },
            revision: { $exists: false },
            $or: [
              {
                dataset: 'expenses',
                economicRole: 'ordinary_expense',
                layer: { $in: [...FINANCIAL_LAYERS] },
              },
              {
                dataset: 'incomes',
                economicRole: {
                  $in: [
                    'ordinary_income',
                    'loan_repayment',
                    'refund',
                    'internal_transfer',
                    'capital_movement',
                  ],
                },
                layer: { $type: 'null' },
              },
            ],
          },
          {
            $and: [scopedReference],
            version: 3,
            revision: { $gte: 1 },
            economicRole: { $exists: false },
            layer: { $exists: false },
          },
        ],
      },
      {
        $or: [
          {
            dataset: 'expenses',
            category: { $type: 'string' },
            source: { $exists: false },
          },
          {
            dataset: 'incomes',
            source: { $type: 'string' },
            category: { $exists: false },
            title: { $exists: false },
          },
        ],
      },
      { $expr: { $lte: ['$createdAt', '$updatedAt'] } },
    ],
  }),
  indexes: [
    {
      key: { owner: 1, dataset: 1, category: 1, title: 1 } as const,
      options: {
        name: 'ux_rule_owner_expense_match',
        unique: true,
        partialFilterExpression: { dataset: 'expenses' },
        collation: { locale: 'simple' },
      },
    },
    {
      key: { owner: 1, dataset: 1, source: 1 } as const,
      options: {
        name: 'ux_rule_owner_income_match',
        unique: true,
        partialFilterExpression: { dataset: 'incomes' },
        collation: { locale: 'simple' },
      },
    },
  ],
};
export type GroupManifest =
  | typeof GROUPS_MANIFEST
  | typeof GROUP_RULES_MANIFEST
  | typeof GROUP_DECISION_MANIFEST;
export const manifestReady = async (db: mongo.Db, m: GroupManifest) => {
  const list = await db
    .listCollections(
      { name: m.collectionName },
      { nameOnly: false, maxTimeMS: 3000 },
    )
    .toArray();
  if (list.length !== 1 || list[0].type !== 'collection') return false;
  const o = list[0].options;
  if (
    !o ||
    o.capped ||
    o.timeseries ||
    o.validationLevel !== 'strict' ||
    o.validationAction !== 'error' ||
    !isDeepStrictEqual(o.validator, m.options.validator) ||
    !isDeepStrictEqual(o.collation ?? { locale: 'simple' }, m.options.collation)
  )
    return false;
  const indexes = await db
    .collection(m.collectionName)
    .listIndexes({ maxTimeMS: 3000 })
    .toArray();
  return (
    indexes.length === m.indexes.length + 1 &&
    m.indexes.every((e) =>
      indexes.some(
        (i) =>
          i.name === e.options.name &&
          isDeepStrictEqual(Object.entries(i.key), Object.entries(e.key)) &&
          i.unique === true &&
          !i.sparse &&
          !i.hidden &&
          i.expireAfterSeconds === undefined &&
          isDeepStrictEqual(
            i.partialFilterExpression,
            'partialFilterExpression' in e.options
              ? e.options.partialFilterExpression
              : undefined,
          ) &&
          isDeepStrictEqual(
            i.collation ?? { locale: 'simple' },
            e.options.collation,
          ),
      ),
    )
  );
};
export const groupsReady = async (db: mongo.Db) =>
  (await manifestReady(db, GROUPS_MANIFEST)) &&
  (await manifestReady(db, GROUP_DECISION_MANIFEST)) &&
  (await manifestReady(db, GROUP_RULES_MANIFEST));
