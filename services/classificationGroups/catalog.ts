import { randomUUID } from 'node:crypto';
import { Types, type mongo } from 'mongoose';
import {
  SYSTEM_GROUPS,
  systemGroup,
  groupId,
  normalizeGroupName,
  validGroupName,
  fields,
  dataset,
  revision,
  id,
} from '../../domain/classification/groups';
import { GROUPS_MANIFEST } from '../../persistence/classificationGroupsManifest';
import {
  groupFromBson,
  groupView,
  reject,
} from '../../persistence/classificationGroups';
import type { ClassificationGroup } from '../../models/classificationGroup';
export const writeOptions = {
  maxTimeMS: 3000,
  writeConcern: { w: 'majority' as const, wtimeoutMS: 3000 },
};
export const oid = (s: string) => new Types.ObjectId(s);
export const getGroup = async (
  db: mongo.Db,
  owner: string,
  target: string,
  ds?: string,
) => {
  if (!groupId(target)) return null;
  const raw = await db
    .collection(GROUPS_MANIFEST.collectionName)
    .findOne(
      { owner: oid(owner), groupId: target, ...(ds ? { dataset: ds } : {}) },
      { maxTimeMS: 3000, promoteLongs: false },
    );
  if (raw === null) return null;
  const parsed = groupFromBson(raw);
  if (!parsed) reject(503, 'invalid_group_record');
  return parsed;
};
export const historicalGroup = async (
  db: mongo.Db,
  owner: string,
  target: string,
  ds: string,
) => {
  const group = await getGroup(db, owner, target, ds);
  if (group) return groupView(group);
  const sys = systemGroup(target);
  return sys && sys.dataset === ds
    ? {
        groupId: target,
        dataset: ds,
        name: sys.name,
        origin: 'system',
        status: sys.compatibilityOnly ? 'disabled' : 'active',
        revision: 0,
        virtual: true,
      }
    : null;
};
export const initialized = async (db: mongo.Db, owner: string) => {
  const rows = await db
    .collection(GROUPS_MANIFEST.collectionName)
    .find(
      { owner: oid(owner), origin: 'system' },
      { maxTimeMS: 3000, promoteLongs: false },
    )
    .limit(SYSTEM_GROUPS.length + 1)
    .toArray();
  return (
    rows.length === SYSTEM_GROUPS.length &&
    rows.every((r) => !!groupFromBson(r)) &&
    new Set(rows.map((r) => r.groupId)).size === SYSTEM_GROUPS.length
  );
};
export const initializeGroups = async (
  db: mongo.Db,
  owner: string,
  attempt: () => void,
) => {
  for (const sys of SYSTEM_GROUPS) {
    const existing = await getGroup(db, owner, sys.groupId);
    if (existing) continue;
    const now = new Date(),
      doc: ClassificationGroup = {
        _id: new Types.ObjectId(),
        owner: oid(owner),
        dataset: sys.dataset,
        groupId: sys.groupId,
        name: sys.name,
        normalizedName: normalizeGroupName(sys.name),
        origin: 'system',
        status: sys.compatibilityOnly ? 'disabled' : 'active',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
    attempt();
    const result = await db
      .collection(GROUPS_MANIFEST.collectionName)
      .updateOne(
        { owner: oid(owner), groupId: sys.groupId },
        { $setOnInsert: doc },
        { ...writeOptions, upsert: true },
      );
    if (!result.acknowledged) reject(503, 'catalog_write_unknown');
  }
  return { initialized: await initialized(db, owner) };
};
export const listGroups = async (
  db: mongo.Db,
  owner: string,
  query: Record<string, unknown>,
) => {
  if (
    Object.keys(query).some(
      (k) => !['dataset', 'after', 'limit'].includes(k),
    ) ||
    (query.dataset !== undefined && !dataset(query.dataset)) ||
    (query.after !== undefined && !id(query.after)) ||
    (query.limit !== undefined &&
      (typeof query.limit !== 'string' ||
        !/^[1-9]\d{0,2}$/.test(query.limit) ||
        Number(query.limit) > 100 ||
        String(Number(query.limit)) !== query.limit))
  )
    reject(400, 'invalid_catalog_query');
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  const rows = await db
    .collection(GROUPS_MANIFEST.collectionName)
    .find(
      {
        owner: oid(owner),
        ...(query.dataset ? { dataset: query.dataset } : {}),
        ...(query.after ? { _id: { $gt: oid(query.after as string) } } : {}),
      },
      { maxTimeMS: 3000, promoteLongs: false },
    )
    .sort({ _id: 1 })
    .limit(limit + 1)
    .toArray();
  const parsed = rows.slice(0, limit).map((r) => {
    const g = groupFromBson(r);
    if (!g) reject(503, 'invalid_group_record');
    return groupView(g!);
  });
  return {
    groups: parsed,
    nextCursor: rows.length > limit ? rows[limit - 1]._id.toHexString() : null,
    initialized: await initialized(db, owner),
    systemDefinitions: SYSTEM_GROUPS,
  };
};
export const createGroup = async (
  db: mongo.Db,
  owner: string,
  input: unknown,
  attempt: () => void,
) => {
  const r = fields(input, ['dataset', 'name']);
  if (
    !r ||
    Object.keys(r).length !== 2 ||
    !dataset(r.dataset) ||
    !validGroupName(r.name)
  )
    reject(400, 'invalid_group');
  if (!(await initialized(db, owner))) reject(409, 'catalog_not_initialized');
  const now = new Date(),
    doc = {
      _id: new Types.ObjectId(),
      owner: oid(owner),
      dataset: r!.dataset,
      groupId: 'custom:' + randomUUID(),
      name: r!.name as string,
      normalizedName: normalizeGroupName(r!.name as string),
      origin: 'custom',
      status: 'active',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
  if (!groupFromBson(doc)) reject(400, 'invalid_group');
  attempt();
  const result = await db
    .collection(GROUPS_MANIFEST.collectionName)
    .insertOne(doc, writeOptions);
  if (!result.acknowledged) reject(503, 'catalog_write_unknown');
  return groupView(groupFromBson(doc)!);
};
export const updateGroup = async (
  db: mongo.Db,
  owner: string,
  target: string,
  input: unknown,
  remove: boolean,
  attempt: () => void,
) => {
  const r = fields(
    input,
    remove
      ? ['expectedRevision']
      : ['expectedRevision', 'name', 'status', 'resetName'],
  );
  if (
    !r ||
    !revision(r.expectedRevision) ||
    (!remove && Object.keys(r).length < 2) ||
    (Object.hasOwn(r ?? {}, 'resetName') && r!.resetName !== true) ||
    (Object.hasOwn(r ?? {}, 'name') && Object.hasOwn(r ?? {}, 'resetName'))
  )
    reject(400, 'invalid_group_patch');
  const previous = await getGroup(db, owner, target);
  if (!previous) reject(404, 'group_not_found');
  const g = previous!;
  if (g.revision !== r!.expectedRevision)
    reject(409, 'group_revision_conflict');
  if (g.revision === Number.MAX_SAFE_INTEGER) reject(409, 'revision_overflow');
  if (remove && g.origin === 'system')
    reject(409, 'system_group_cannot_be_deleted');
  const name = Object.hasOwn(r!, 'resetName')
    ? systemGroup(target)?.name
    : Object.hasOwn(r!, 'name')
      ? r!.name
      : g.name;
  const status = remove
    ? 'archived'
    : Object.hasOwn(r!, 'status')
      ? r!.status
      : g.status;
  if (
    !validGroupName(name) ||
    !['active', 'disabled', 'archived'].some((v) => v === status) ||
    (g.origin === 'system' && status === 'archived') ||
    (r!.resetName && g.origin !== 'system')
  )
    reject(400, 'invalid_group_patch');
  const doc = {
    ...g,
    name: name as string,
    normalizedName: normalizeGroupName(name as string),
    status: status as ClassificationGroup['status'],
    revision: g.revision + 1,
    updatedAt: new Date(Math.max(Date.now(), g.updatedAt.getTime())),
  };
  attempt();
  const result = await db
    .collection(GROUPS_MANIFEST.collectionName)
    .replaceOne(
      { _id: g._id, owner: oid(owner), groupId: target, revision: g.revision },
      doc,
      writeOptions,
    );
  if (!result.acknowledged) reject(503, 'catalog_write_unknown');
  if (result.matchedCount !== 1) reject(409, 'group_revision_conflict');
  return groupView(doc);
};
