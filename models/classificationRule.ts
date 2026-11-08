/** Isolated model foundation. Import/factory never creates a collection or indexes. */
import { Schema, type Connection, type Types } from 'mongoose';
import { ECONOMIC_ROLES_V2, FINANCIAL_LAYERS, TAXONOMY_VERSION_V2,
  type EconomicRoleV2, type FinancialLayer } from '../domain/classification';
import { validateStableClassificationDecisionV2 } from '../domain/classification/stablePolicy';

export const CLASSIFICATION_RULE_COLLECTION = 'classification_rules';
/** Canonical stored match values; internal spaces and Unicode spelling are preserved. */
export const normalizeRuleMatch = (value: string): string => value.trim().toLowerCase();
export type ClassificationRule = {
  _id: Types.ObjectId; owner: Types.ObjectId; enabled: boolean; createdAt: Date; updatedAt: Date;
} & (
  | { dataset: 'expenses'; category: string; title?: string; source?: never;
      economicRole: 'ordinary_expense'; layer: FinancialLayer }
  | { dataset: 'incomes'; source: string; category?: never; title?: never;
      economicRole: Exclude<EconomicRoleV2, 'ordinary_expense'>; layer: null }
);
const matchText = {
  type: String, cast: false,
  set: (value: unknown) => typeof value === 'string' ? normalizeRuleMatch(value) : value,
  validate: { validator: (value: unknown) => typeof value === 'string' && value.length > 0,
    message: 'invalid_rule_match' },
};
const validDate = (value: unknown): boolean =>
  value instanceof Date && Number.isFinite(Date.prototype.getTime.call(value));
const schema = new Schema<ClassificationRule>({
  _id: { type: Schema.Types.ObjectId, auto: true, required: true, immutable: true, cast: false },
  owner: { type: Schema.Types.ObjectId, required: true, immutable: true, cast: false },
  dataset: { type: String, required: true, immutable: true, cast: false, enum: ['expenses', 'incomes'] },
  enabled: { type: Boolean, required: true, cast: false },
  category: { ...matchText, required: function (this: { dataset: unknown }): boolean { return this.dataset === 'expenses'; } },
  title: matchText,
  source: { ...matchText, required: function (this: { dataset: unknown }): boolean { return this.dataset === 'incomes'; } },
  economicRole: { type: String, required: true, cast: false, enum: [...ECONOMIC_ROLES_V2] },
  layer: { type: String, cast: false, enum: [...FINANCIAL_LAYERS, null] },
  createdAt: { type: Date, required: true, default: () => new Date(), immutable: true, cast: false, validate: validDate },
  updatedAt: { type: Date, required: true, default: () => new Date(), cast: false, validate: validDate },
}, { collection: CLASSIFICATION_RULE_COLLECTION, strict: 'throw', strictQuery: 'throw',
  timestamps: true, versionKey: false, autoCreate: false, autoIndex: false, minimize: false });

// Missing title has the null index key; explicit null/empty title is invalid.
// Disabled rules still occupy their match key. No sparse index omits general rules.
schema.index({ owner: 1, dataset: 1, category: 1, title: 1 }, {
  name: 'ux_rule_owner_expense_match', unique: true,
  partialFilterExpression: { dataset: 'expenses' }, collation: { locale: 'simple' },
});
schema.index({ owner: 1, dataset: 1, source: 1 }, {
  name: 'ux_rule_owner_income_match', unique: true,
  partialFilterExpression: { dataset: 'incomes' }, collation: { locale: 'simple' },
});
schema.pre('validate', function () {
  // Treat unvalidated document fields as unknown, including impossible typed combinations.
  const dataset: unknown = this.get('dataset');
  if (dataset === 'expenses' && this.get('source') !== undefined)
    this.invalidate('source', 'unexpected_income_field');
  if (dataset === 'incomes' && (this.get('category') !== undefined || this.get('title') !== undefined))
    this.invalidate('category', 'unexpected_expense_field');
  if (dataset === 'expenses' && this.get('economicRole') !== 'ordinary_expense')
    this.invalidate('economicRole', 'expense_rule_requires_ordinary_expense');
  // Synthetic identities check domain compatibility only; they confer no owner authority.
  const decision = validateStableClassificationDecisionV2({
    owner: '000000000000000000000000', operationId: '000000000000000000000000',
    dataset: this.dataset, taxonomyVersion: TAXONOMY_VERSION_V2, decisionOrigin: 'manual',
    decisionRevision: 1, state: 'approved',
    assignment: { economicRole: this.economicRole, layer: this.layer },
  });
  if (!decision.ok) this.invalidate('economicRole', 'invalid_rule_assignment');
  if (this.createdAt && this.updatedAt && this.createdAt.getTime() > this.updatedAt.getTime())
    this.invalidate('updatedAt', 'invalid_rule_timestamps');
});

/** Future CRUD must authorize by owner and validate whole documents via save().
 * Query updates/bulk writes do not run the full document validation hook. */
export const createClassificationRuleModel = (connection: Connection) =>
  connection.model<ClassificationRule>('ClassificationRule', schema, CLASSIFICATION_RULE_COLLECTION);
