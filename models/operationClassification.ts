/** Explicit model factory only. No default connection, collection creation or index IO. */
import { Schema, type Connection } from 'mongoose';
import { ECONOMIC_ROLES, FINANCIAL_LAYERS, STABLE_TAXONOMY_VERSION } from '../domain/classification';
import { classificationFromBson, type BsonClassification } from '../persistence/classification';
import { CLASSIFICATION_MANIFEST } from '../persistence/classificationManifest';

const strictNested = { _id: false, strict: 'throw' as const, minimize: false };
const assignment = new Schema({
  economicRole: { type: String, cast: false, required: true, enum: [...ECONOMIC_ROLES] },
  layer: { type: String, cast: false, enum: [...FINANCIAL_LAYERS, null] },
}, strictNested);
const mutation = new Schema({
  requestId: { type: String, cast: false, required: true },
  commandFingerprint: { type: String, cast: false, required: true },
  commandFingerprintVersion: { type: Number, cast: false, required: true, enum: [1] },
}, strictNested);
const schema = new Schema<BsonClassification>({
  _id: { type: Schema.Types.ObjectId, auto: true, immutable: true, cast: false },
  owner: { type: Schema.Types.ObjectId, cast: false, required: true, immutable: true },
  dataset: { type: String, cast: false, required: true, immutable: true, enum: ['expenses', 'incomes'] },
  operationId: { type: Schema.Types.ObjectId, cast: false, required: true, immutable: true },
  state: { type: String, cast: false, required: true, enum: ['approved', 'explicit_unclassified', 'cleared'] },
  assignment: { type: assignment, default: undefined },
  taxonomyVersion: { type: String, cast: false, required: true, enum: [STABLE_TAXONOMY_VERSION] },
  decisionOrigin: { type: String, cast: false, required: true, enum: ['manual'] },
  decisionRevision: { type: Number, cast: false, required: true, min: 1, max: Number.MAX_SAFE_INTEGER,
    validate: Number.isSafeInteger },
  sourceFingerprint: { type: String, cast: false, required: true },
  sourceFingerprintVersion: { type: Number, cast: false, required: true, enum: [1] },
  sourceObservedAt: { type: Date, cast: false, required: true },
  lastMutation: { type: mutation, required: true },
  createdAt: { type: Date, cast: false, required: true, immutable: true },
  updatedAt: { type: Date, cast: false, required: true },
}, { collection: CLASSIFICATION_MANIFEST.collectionName, strict: 'throw', strictQuery: 'throw',
  versionKey: false, autoCreate: false, autoIndex: false, minimize: false, timestamps: false });

schema.index(CLASSIFICATION_MANIFEST.index.key, CLASSIFICATION_MANIFEST.index.options);
schema.pre('validate', function () {
  // Secondary full-document guard. Untrusted input must pass prepare first.
  const value: unknown = this.toObject({ getters: false, virtuals: false, transform: false, depopulate: true });
  if (!classificationFromBson(value).ok) throw new Error('invalid_classification_document');
});

export const createOperationClassificationModel = (connection: Connection) =>
  connection.model<BsonClassification>('OperationClassification', schema, CLASSIFICATION_MANIFEST.collectionName);
