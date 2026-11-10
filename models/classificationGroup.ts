import {
  Schema,
  type Connection,
  type Types,
  type IndexDefinition,
} from 'mongoose';
import { groupFromBson } from '../persistence/classificationGroups';
import { GROUPS_MANIFEST } from '../persistence/classificationGroupsManifest';
export type ClassificationGroup = {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  dataset: 'expenses' | 'incomes';
  groupId: string;
  name: string;
  normalizedName: string;
  origin: 'system' | 'custom';
  status: 'active' | 'disabled' | 'archived';
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};
/** DDL is exclusively performed by the explicit migration tool. */
const schema = new Schema<ClassificationGroup>(
  {
    _id: { type: Schema.Types.ObjectId, required: true, cast: false },
    owner: { type: Schema.Types.ObjectId, required: true, cast: false },
    dataset: { type: String, required: true, cast: false },
    groupId: { type: String, required: true, cast: false },
    name: { type: String, required: true, cast: false },
    normalizedName: { type: String, required: true, cast: false },
    origin: { type: String, required: true, cast: false },
    status: { type: String, required: true, cast: false },
    revision: { type: Number, required: true, cast: false },
    createdAt: { type: Date, required: true, cast: false },
    updatedAt: { type: Date, required: true, cast: false },
  },
  {
    collection: 'classification_groups',
    strict: 'throw',
    strictQuery: 'throw',
    autoCreate: false,
    autoIndex: false,
    bufferCommands: false,
    versionKey: false,
  },
);
for (const index of GROUPS_MANIFEST.indexes) {
  const key: IndexDefinition = {};
  for (const [field, direction] of Object.entries(index.key)) {
    if (direction !== 1) throw new Error('unsupported_group_index');
    key[field] = direction;
  }
  schema.index(key, index.options);
}
schema.pre('validate', function () {
  if (!groupFromBson(this.toObject()))
    this.invalidate('groupId', 'invalid_group_record');
});
export const createClassificationGroupModel = (connection: Connection) =>
  connection.model<ClassificationGroup>(
    'ClassificationGroup',
    schema,
    'classification_groups',
  );
