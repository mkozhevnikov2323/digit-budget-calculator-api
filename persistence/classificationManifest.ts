/** Data only. Importing this manifest never connects or installs anything. */
import { FINANCIAL_LAYERS, STABLE_TAXONOMY_VERSION, type EconomicRole } from '../domain/classification';
import { STABLE_ROLE_DATASETS } from '../domain/classification/stablePolicy';

const numeric = ['int', 'long', 'double'];
const integer = { bsonType: numeric, minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 };
const version = { bsonType: numeric, enum: [1] };
const digest = { bsonType: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' };
const approvedBranches = (Object.keys(STABLE_ROLE_DATASETS) as EconomicRole[]).map(role => ({
  required: ['assignment'],
  properties: {
    state: { enum: ['approved'] }, dataset: { enum: [...STABLE_ROLE_DATASETS[role]] },
    assignment: { properties: {
      economicRole: { enum: [role] }, layer: role === 'ordinary_expense'
        ? { bsonType: 'string', enum: [...FINANCIAL_LAYERS] } : { bsonType: 'null' },
    } },
  },
}));
const rootProperties = {
  _id: { bsonType: 'objectId' }, owner: { bsonType: 'objectId' }, operationId: { bsonType: 'objectId' },
  dataset: { bsonType: 'string', enum: ['expenses', 'incomes'] },
  state: { bsonType: 'string', enum: ['approved', 'explicit_unclassified', 'cleared'] },
  taxonomyVersion: { bsonType: 'string', enum: [STABLE_TAXONOMY_VERSION] },
  decisionOrigin: { bsonType: 'string', enum: ['manual'] }, decisionRevision: integer,
  sourceFingerprint: digest, sourceFingerprintVersion: version,
  sourceObservedAt: { bsonType: 'date' }, createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' },
  assignment: {
    bsonType: 'object', additionalProperties: false, required: ['economicRole', 'layer'],
    properties: { economicRole: { bsonType: 'string' }, layer: { bsonType: ['string', 'null'] } },
  },
  lastMutation: {
    bsonType: 'object', additionalProperties: false,
    required: ['requestId', 'commandFingerprint', 'commandFingerprintVersion'],
    properties: {
      requestId: { bsonType: 'string', minLength: 36, maxLength: 36,
        pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
      commandFingerprint: digest, commandFingerprintVersion: version,
    },
  },
};
const freeze = <T>(owned: T): T => {
  if (owned !== null && typeof owned === 'object') {
    Object.values(owned).forEach(freeze); Object.freeze(owned);
  }
  return owned;
};
export const CLASSIFICATION_MANIFEST = freeze({
  collectionName: 'operation_classifications',
  options: {
    collation: { locale: 'simple' }, validationLevel: 'strict', validationAction: 'error',
    validator: { $and: [
      { $jsonSchema: {
        bsonType: 'object', additionalProperties: false,
        required: Object.keys(rootProperties).filter(key => key !== 'assignment'), properties: rootProperties,
        oneOf: [...approvedBranches, {
          properties: { state: { enum: ['explicit_unclassified', 'cleared'] } }, not: { required: ['assignment'] },
        }],
      } },
      { $expr: { $lte: ['$createdAt', '$updatedAt'] } },
    ] },
  },
  index: {
    key: { owner: 1, dataset: 1, operationId: 1 } as const,
    options: { name: 'ux_owner_dataset_operation', unique: true, sparse: false, collation: { locale: 'simple' } },
  },
});
