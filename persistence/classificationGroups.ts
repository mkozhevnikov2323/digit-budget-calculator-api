import { createHash } from 'node:crypto';
import { type ClassificationGroup } from '../models/classificationGroup';
import { bsonId, bsonNumber, classificationFromBson } from './classification';
import {
  GROUP_TAXONOMY,
  fields,
  dataset,
  groupId,
  systemGroup,
  validGroupName,
  normalizeGroupName,
  revision,
  uuid,
  legacyGroup,
} from '../domain/classification/groups';
import { validateSourceFingerprint } from '../domain/classification/sourceFingerprint';
import { validateStableClassificationDecisionV2 } from '../domain/classification/stablePolicy';
export class GroupError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function reject(status: number, code: string): never {
  throw new GroupError(status, code);
}
const date = (v: unknown): v is Date => {
  try {
    return (
      !!v &&
      Object.getPrototypeOf(v) === Date.prototype &&
      Reflect.ownKeys(v).length === 0 &&
      Number.isSafeInteger(Date.prototype.getTime.call(v))
    );
  } catch {
    return false;
  }
};
export const groupFromBson = (raw: unknown): ClassificationGroup | null => {
  const r = fields(raw, [
    '_id',
    'owner',
    'dataset',
    'groupId',
    'name',
    'normalizedName',
    'origin',
    'status',
    'revision',
    'createdAt',
    'updatedAt',
  ]);
  if (
    !r ||
    Object.keys(r).length !== 11 ||
    !bsonId(r._id) ||
    !bsonId(r.owner) ||
    !dataset(r.dataset) ||
    !groupId(r.groupId) ||
    !validGroupName(r.name) ||
    r.normalizedName !== normalizeGroupName(r.name) ||
    !['system', 'custom'].some((v) => v === r.origin) ||
    !['active', 'disabled', 'archived'].some((v) => v === r.status) ||
    !revision(bsonNumber(r.revision)) ||
    !date(r.createdAt) ||
    !date(r.updatedAt) ||
    r.createdAt > r.updatedAt
  )
    return null;
  const sys = systemGroup(r.groupId);
  if (
    r.origin === 'system'
      ? !sys || sys.dataset !== r.dataset || r.status === 'archived'
      : !!sys
  )
    return null;
  return { ...r, revision: bsonNumber(r.revision) } as ClassificationGroup;
};
export const groupView = (g: ClassificationGroup) => ({
  groupId: g.groupId,
  dataset: g.dataset,
  name: g.name,
  origin: g.origin,
  status: g.status,
  revision: g.revision,
  createdAt: g.createdAt.toISOString(),
  updatedAt: g.updatedAt.toISOString(),
});
export type GroupDecision = {
  _id: string;
  owner: string;
  dataset: 'expenses' | 'incomes';
  operationId: string;
  taxonomyVersion: string;
  decisionRevision: number;
  state: 'approved' | 'explicit_unclassified' | 'cleared';
  groupId?: string;
  sourceFingerprint: string;
  sourceFingerprintVersion: 1;
  sourceObservedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastMutation: {
    requestId: string;
    commandFingerprint: string;
    commandFingerprintVersion: 1;
  };
};
export const groupDecisionFromBson = (raw: unknown): GroupDecision | null => {
  const old = classificationFromBson(raw);
  if (old.ok) {
    const r = old.value;
    return {
      ...r,
      ...(r.state === 'approved'
        ? { groupId: legacyGroup(r.dataset, r.assignment) }
        : {}),
    };
  }
  const r = fields(raw, [
    '_id',
    'owner',
    'dataset',
    'operationId',
    'taxonomyVersion',
    'decisionOrigin',
    'decisionRevision',
    'state',
    'groupId',
    'sourceFingerprint',
    'sourceFingerprintVersion',
    'sourceObservedAt',
    'createdAt',
    'updatedAt',
    'lastMutation',
  ]);
  if (
    !r ||
    Object.keys(r).length !== (r.state === 'approved' ? 15 : 14) ||
    r.taxonomyVersion !== GROUP_TAXONOMY ||
    r.decisionOrigin !== 'manual' ||
    !bsonId(r._id) ||
    !bsonId(r.owner) ||
    !bsonId(r.operationId) ||
    !dataset(r.dataset) ||
    !revision(bsonNumber(r.decisionRevision)) ||
    !['approved', 'explicit_unclassified', 'cleared'].some(
      (v) => v === r.state,
    ) ||
    !date(r.sourceObservedAt) ||
    !date(r.createdAt) ||
    !date(r.updatedAt) ||
    r.createdAt > r.updatedAt ||
    !validateSourceFingerprint({
      sourceFingerprint: r.sourceFingerprint,
      sourceFingerprintVersion: bsonNumber(r.sourceFingerprintVersion),
    }).ok
  )
    return null;
  if (
    r.state === 'approved'
      ? !groupId(r.groupId) ||
        (systemGroup(r.groupId)?.dataset !== undefined &&
          systemGroup(r.groupId)?.dataset !== r.dataset)
      : Object.hasOwn(r, 'groupId')
  )
    return null;
  const m = fields(r.lastMutation, [
    'requestId',
    'commandFingerprint',
    'commandFingerprintVersion',
  ]);
  if (
    !m ||
    Object.keys(m).length !== 3 ||
    !uuid(m.requestId) ||
    !validateSourceFingerprint({
      sourceFingerprint: m.commandFingerprint,
      sourceFingerprintVersion: bsonNumber(m.commandFingerprintVersion),
    }).ok
  )
    return null;
  return {
    ...r,
    _id: bsonId(r._id),
    owner: bsonId(r.owner),
    operationId: bsonId(r.operationId),
    decisionRevision: bsonNumber(r.decisionRevision),
    sourceFingerprintVersion: 1,
    lastMutation: { ...m, commandFingerprintVersion: 1 },
  } as GroupDecision;
};
export type GroupRule = {
  _id: import('mongoose').Types.ObjectId;
  owner: import('mongoose').Types.ObjectId;
  dataset: 'expenses' | 'incomes';
  enabled: boolean;
  category?: string;
  title?: string;
  source?: string;
  groupId: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};
export const ruleFromBson = (raw: unknown): GroupRule | null => {
  const r = fields(raw, [
    '_id',
    'owner',
    'dataset',
    'enabled',
    'category',
    'title',
    'source',
    'economicRole',
    'layer',
    'groupId',
    'version',
    'revision',
    'createdAt',
    'updatedAt',
  ]);
  if (
    !r ||
    !bsonId(r._id) ||
    !bsonId(r.owner) ||
    !dataset(r.dataset) ||
    typeof r.enabled !== 'boolean' ||
    !date(r.createdAt) ||
    !date(r.updatedAt) ||
    r.createdAt > r.updatedAt
  )
    return null;
  const match = (v: unknown) =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 8192 &&
    v === v.trim().toLowerCase() &&
    Buffer.from(v, 'utf8').toString('utf8') === v;
  if (
    r.dataset === 'expenses'
      ? !match(r.category) ||
        Object.hasOwn(r, 'source') ||
        (Object.hasOwn(r, 'title') && !match(r.title))
      : !match(r.source) ||
        Object.hasOwn(r, 'category') ||
        Object.hasOwn(r, 'title')
  )
    return null;
  let target: string;
  if (Object.hasOwn(r, 'groupId')) {
    if (
      r.version !== 3 ||
      !revision(bsonNumber(r.revision)) ||
      !groupId(r.groupId) ||
      Object.hasOwn(r, 'economicRole') ||
      Object.hasOwn(r, 'layer')
    )
      return null;
    target = r.groupId;
  } else {
    if (
      Object.hasOwn(r, 'version') ||
      Object.hasOwn(r, 'revision') ||
      (r.dataset === 'expenses' && r.economicRole !== 'ordinary_expense') ||
      !validateStableClassificationDecisionV2({
        owner: '0'.repeat(24),
        dataset: r.dataset,
        operationId: '0'.repeat(24),
        taxonomyVersion: 'financial-classification-v2',
        decisionOrigin: 'manual',
        decisionRevision: 1,
        state: 'approved',
        assignment: { economicRole: r.economicRole, layer: r.layer },
      }).ok
    )
      return null;
    target = legacyGroup(r.dataset, {
      economicRole: r.economicRole as string,
      layer: r.layer as string | null,
    });
  }
  if (systemGroup(target) && systemGroup(target)!.dataset !== r.dataset)
    return null;
  return {
    ...r,
    groupId: target,
    revision: Object.hasOwn(r, 'groupId') ? bsonNumber(r.revision) : 0,
  } as GroupRule;
};
/** Canonical server-owned snapshots only. No coercion hooks from HTTP objects. */
export const hash = (parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const ruleDigest = (r: GroupRule) =>
  hash([
    'group-rule-v3',
    bsonId(r._id),
    r.dataset,
    r.enabled,
    r.category ?? null,
    r.title ?? null,
    r.source ?? null,
    r.groupId,
    r.revision,
    r.updatedAt.toISOString(),
  ]);
