import { Types, type mongo } from 'mongoose';
import {
  fields,
  dataset,
  groupId,
  id,
} from '../../domain/classification/groups';
import {
  ruleFromBson,
  ruleDigest,
  reject,
} from '../../persistence/classificationGroups';
import { getGroup, historicalGroup, oid, writeOptions } from './catalog';
export const ruleView = async (
  db: mongo.Db,
  owner: string,
  raw: unknown,
): Promise<{
  id: string;
  dataset: 'expenses' | 'incomes';
  enabled: boolean;
  category?: string;
  title?: string;
  source?: string;
  groupId: string;
  group: Awaited<ReturnType<typeof historicalGroup>>;
  etag: string;
  revision: number;
  diagnostic: string;
  createdAt: string;
  updatedAt: string;
}> => {
  const r = ruleFromBson(raw);
  if (!r) reject(503, 'invalid_rule_record');
  const rule = r!,
    group = await historicalGroup(db, owner, rule.groupId, rule.dataset);
  return {
    id: rule._id.toHexString(),
    dataset: rule.dataset,
    enabled: rule.enabled,
    ...(rule.dataset === 'expenses'
      ? {
          category: rule.category,
          ...(rule.title === undefined ? {} : { title: rule.title }),
        }
      : { source: rule.source }),
    groupId: rule.groupId,
    group,
    etag: ruleDigest(rule),
    revision: rule.revision,
    diagnostic: !rule.enabled
      ? 'disabled'
      : !group || 'virtual' in group
        ? 'group_missing'
        : group.status !== 'active'
          ? 'group_inactive'
          : 'ready',
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
};
export const listRules = async (db: mongo.Db, owner: string) => {
  const raws = await db
    .collection('classification_rules')
    .find({ owner: oid(owner) }, { maxTimeMS: 3000, promoteLongs: false })
    .sort({ _id: 1 })
    .limit(5001)
    .toArray();
  if (raws.length > 5000) reject(503, 'rule_limit_exceeded');
  return Promise.all(raws.map((r) => ruleView(db, owner, r)));
};
const normalize = (v: unknown) =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= 8192 &&
  Buffer.from(v, 'utf8').toString('utf8') === v
    ? v.trim().toLowerCase()
    : null;
export const mutateRule = async (
  db: mongo.Db,
  owner: string,
  input: unknown,
  target: string | undefined,
  remove: boolean,
  attempt: () => void,
) => {
  const r = fields(
    input,
    remove
      ? ['expectedEtag']
      : target
        ? ['expectedEtag', 'enabled', 'category', 'title', 'source', 'groupId']
        : ['dataset', 'enabled', 'category', 'title', 'source', 'groupId'],
  );
  if (!r || !Object.keys(r).length || (target && !id(target)))
    reject(400, 'invalid_rule');
  const previous = target
    ? await db
        .collection('classification_rules')
        .findOne(
          { _id: oid(target), owner: oid(owner) },
          { maxTimeMS: 3000, promoteLongs: false },
        )
    : null;
  if (target && !previous) reject(404, 'rule_not_found');
  const checked = previous ? ruleFromBson(previous) : null;
  if (previous && !checked) reject(503, 'invalid_rule_record');
  if (checked && r!.expectedEtag !== ruleDigest(checked))
    reject(409, 'rule_revision_conflict');
  // Include every observed field so even legacy same-millisecond changes cannot
  // be overwritten; old API writes exclude records converted to group references.
  const filter = previous
    ? {
        ...previous,
        groupId: previous.groupId ?? { $exists: false },
        title: previous.title ?? { $exists: false },
      }
    : {};
  if (remove) {
    attempt();
    const deleted = await db
      .collection('classification_rules')
      .deleteOne(filter, writeOptions);
    if (!deleted.acknowledged) reject(503, 'rule_write_unknown');
    if (deleted.deletedCount !== 1) reject(409, 'rule_revision_conflict');
    return { deleted: true };
  }
  const ds = checked?.dataset ?? r!.dataset,
    targetGroup = Object.hasOwn(r!, 'groupId') ? r!.groupId : checked?.groupId,
    enabled = Object.hasOwn(r!, 'enabled')
      ? r!.enabled
      : (checked?.enabled ?? true);
  if (!dataset(ds) || !groupId(targetGroup) || typeof enabled !== 'boolean')
    reject(400, 'invalid_rule');
  if (
    (ds === 'expenses' && Object.hasOwn(r!, 'source')) ||
    (ds === 'incomes' &&
      (Object.hasOwn(r!, 'category') || Object.hasOwn(r!, 'title')))
  )
    reject(400, 'invalid_rule');
  const category =
      ds === 'expenses'
        ? normalize(
            Object.hasOwn(r!, 'category') ? r!.category : checked?.category,
          )
        : null,
    source =
      ds === 'incomes'
        ? normalize(Object.hasOwn(r!, 'source') ? r!.source : checked?.source)
        : null;
  const titleValue = Object.hasOwn(r!, 'title') ? r!.title : checked?.title,
    title =
      titleValue === undefined || titleValue === null
        ? undefined
        : normalize(titleValue);
  if (
    (ds === 'expenses' && !category) ||
    (ds === 'incomes' && !source) ||
    title === null
  )
    reject(400, 'invalid_rule');
  const group = await getGroup(db, owner, targetGroup, ds);
  // Disabling an existing reference is safe even after its group was archived;
  // a new/changed target still has to be active.
  if (
    !group ||
    (group.status !== 'active' &&
      !(checked && checked.groupId === targetGroup && enabled === false))
  )
    reject(409, 'group_unavailable');
  if (checked?.revision === Number.MAX_SAFE_INTEGER)
    reject(409, 'revision_overflow');
  const now = new Date(Math.max(Date.now(), checked?.updatedAt.getTime() ?? 0));
  const doc = {
    _id: checked ? checked._id : new Types.ObjectId(),
    owner: oid(owner),
    dataset: ds,
    enabled,
    version: 3,
    revision: checked ? checked.revision + 1 : 1,
    groupId: targetGroup,
    ...(ds === 'expenses'
      ? { category, ...(title === undefined ? {} : { title }) }
      : { source }),
    createdAt: checked?.createdAt ?? now,
    updatedAt: now,
  };
  if (!ruleFromBson(doc)) reject(400, 'invalid_rule');
  attempt();
  if (checked) {
    const result = await db
      .collection('classification_rules')
      .replaceOne(filter, doc, writeOptions);
    if (!result.acknowledged) reject(503, 'rule_write_unknown');
    if (result.matchedCount !== 1) reject(409, 'rule_revision_conflict');
  } else {
    const result = await db
      .collection('classification_rules')
      .insertOne(doc, writeOptions);
    if (!result.acknowledged) reject(503, 'rule_write_unknown');
  }
  return ruleView(db, owner, doc);
};
/** Pure priority selection. Active specific rules outrank general category rules;
 * an unavailable specific target is diagnosed, never silently applied. */
export const matchRule = (
  rules: Awaited<ReturnType<typeof listRules>>,
  ds: 'expenses' | 'incomes',
  facts: { category?: string; title?: string; source?: string },
) => {
  const n = (s: string | undefined) => s?.trim().toLowerCase();
  const matches = rules
    .filter(
      (r) =>
        r.dataset === ds &&
        r.enabled &&
        (ds === 'expenses'
          ? r.category === n(facts.category) &&
            (r.title === undefined || r.title === n(facts.title))
          : r.source === n(facts.source)),
    )
    .sort(
      (a, b) =>
        Number(b.title !== undefined) - Number(a.title !== undefined) ||
        a.id.localeCompare(b.id),
    );
  if (!matches.length) return null;
  const r = matches[0];
  return {
    ruleId: r.id,
    ruleEtag: r.etag,
    groupId: r.groupId,
    diagnostic: r.diagnostic,
  };
};
