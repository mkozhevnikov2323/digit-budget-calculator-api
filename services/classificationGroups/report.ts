import type { mongo } from 'mongoose';
import {
  fields,
  id,
  dataset,
  groupId,
} from '../../domain/classification/groups';
import { groupDecisionRead, observedGroupDecision } from './decisions';
import {
  groupDecisionFromBson,
  groupFromBson,
  groupView,
} from '../../persistence/classificationGroups';
import { systemGroup } from '../../domain/classification/groups';
import { oid } from './catalog';
import { reject } from '../../persistence/classificationGroups';
import { sourceProjection, presentSource } from '../classificationObservation';
import { matchRule, listRules } from './rules';
export const windowFields = (r: Record<string, unknown>) => {
  const a = r.startInclusive,
    b = r.endExclusive;
  if (
    typeof a !== 'number' ||
    typeof b !== 'number' ||
    !Number.isSafeInteger(a) ||
    !Number.isSafeInteger(b) ||
    a < -62135596800000 ||
    b > 253402300800000 ||
    a >= b ||
    b - a > 366 * 86400000
  )
    reject(400, 'invalid_period');
  return { startInclusive: a as number, endExclusive: b as number };
};
const safeAdd = (a: number, b: number) => {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) reject(503, 'amount_overflow');
  return sum;
};
const kopecks = (facts: { amount: { value: string } }) => {
  const text = facts.amount.value;
  if (!/^(?:-0|\d+)(?:\.\d{1,2})?$/.test(text))
    reject(503, 'unsupported_precision');
  const [whole, fraction = ''] = text.replace('-0', '0').split('.'),
    n = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) reject(503, 'amount_overflow');
  return Number(n);
};
const membership = async (
  db: mongo.Db,
  owner: string,
  p: { startInclusive: number; endExclusive: number },
) => {
  const result: Record<
    string,
    NonNullable<ReturnType<typeof presentSource>>
  > = Object.create(null);
  for (const ds of ['expenses', 'incomes'] as const) {
    const raws = await db
      .collection(ds)
      .find(
        {
          owner: oid(owner),
          date: {
            $gte: new Date(p.startInclusive),
            $lt: new Date(p.endExclusive),
          },
        },
        {
          projection: sourceProjection(ds),
          maxTimeMS: 3000,
          promoteLongs: false,
        },
      )
      .sort({ _id: 1 })
      .limit(50001)
      .toArray();
    if (Object.keys(result).length + raws.length > 50000)
      reject(503, 'history_limit_exceeded');
    for (const raw of raws) {
      const opId = raw._id.toHexString(),
        source = presentSource(raw, { owner, dataset: ds, operationId: opId });
      if (!source) reject(503, 'source_unavailable');
      result[`${ds}/${opId}`] = source!;
    }
  }
  return result;
};
export const groupReport = async (
  db: mongo.Db,
  owner: string,
  input: unknown,
) => {
  const r = fields(input, [
    'version',
    'startInclusive',
    'endExclusive',
    'dataset',
    'groupId',
    'includeOperations',
  ]);
  if (
    !r ||
    r.version !== 'classification-group-report-v3' ||
    (r.dataset !== undefined && !dataset(r.dataset)) ||
    (r.groupId !== undefined && r.groupId !== null && !groupId(r.groupId)) ||
    (r.includeOperations !== undefined &&
      typeof r.includeOperations !== 'boolean')
  )
    reject(400, 'invalid_report');
  const p = windowFields(r!),
    before = await membership(db, owner, p),
    operations: Awaited<ReturnType<typeof groupDecisionRead>>[] = [],
    groups = new Map<
      string,
      {
        dataset: string;
        groupId: string | null;
        name: string | null;
        status: string | null;
        kopecks: number;
        count: number;
      }
    >();
  const totals = {
    expenses: { kopecks: 0, signedKopecks: 0, count: 0 },
    incomes: { kopecks: 0, signedKopecks: 0, count: 0 },
  };
  const decisions = new Map<string, unknown>(),
    targets = new Set<string>();
  for (const ds of ['expenses', 'incomes'] as const) {
    const ids = Object.keys(before)
      .filter((k) => k.startsWith(ds + '/'))
      .map((k) => oid(k.split('/')[1]));
    for (let start = 0; start < ids.length; start += 500) {
      const rows = await db
        .collection('operation_classifications')
        .find(
          {
            owner: oid(owner),
            dataset: ds,
            operationId: { $in: ids.slice(start, start + 500) },
          },
          { maxTimeMS: 3000, promoteLongs: false },
        )
        .limit(501)
        .toArray();
      if (rows.length > 500) reject(503, 'invalid_decision_count');
      for (const raw of rows) {
        const stored = groupDecisionFromBson(raw);
        if (
          !stored ||
          stored.owner !== owner ||
          stored.dataset !== ds ||
          !before[`${ds}/${stored.operationId}`] ||
          decisions.has(`${ds}/${stored.operationId}`)
        )
          reject(503, 'blocked_decision');
        decisions.set(`${ds}/${stored!.operationId}`, raw);
        if (stored!.groupId) targets.add(stored!.groupId);
      }
    }
  }
  const catalog = new Map<string, ReturnType<typeof groupView>>(),
    targetIds = [...targets];
  for (let start = 0; start < targetIds.length; start += 500) {
    const docs = await db
      .collection('classification_groups')
      .find(
        {
          owner: oid(owner),
          groupId: { $in: targetIds.slice(start, start + 500) },
        },
        { maxTimeMS: 3000, promoteLongs: false },
      )
      .limit(501)
      .toArray();
    if (docs.length > 500) reject(503, 'invalid_group_count');
    for (const raw of docs) {
      const group = groupFromBson(raw);
      if (!group || catalog.has(group.groupId))
        reject(503, 'invalid_group_record');
      catalog.set(group!.groupId, groupView(group!));
    }
  }
  for (const key of Object.keys(before)) {
    const [ds, opId] = key.split('/') as ['expenses' | 'incomes', string];
    const read = await observedGroupDecision(
      decisions.get(key) ?? null,
      before[key],
      owner,
      ds,
      opId,
      async (target) => {
        const g = catalog.get(target);
        if (g) return g.dataset === ds ? g : null;
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
      },
    );
    const amount = kopecks(read.facts),
      total = totals[ds];
    total.kopecks = safeAdd(total.kopecks, amount);
    total.count++;
    total.signedKopecks = ds === 'expenses' ? -total.kopecks : total.kopecks;
    const groupKey = `${ds}/${read.groupId ?? 'unclassified'}`,
      bucket = groups.get(groupKey) ?? {
        dataset: ds,
        groupId: read.groupId,
        name: read.groupId ? (read.group?.name ?? null) : null,
        status: read.groupId ? (read.group?.status ?? null) : null,
        kopecks: 0,
        count: 0,
      };
    bucket.kopecks = safeAdd(bucket.kopecks, amount);
    bucket.count++;
    groups.set(groupKey, bucket);
    if (
      r!.includeOperations === true &&
      (r!.dataset === undefined || r!.dataset === ds) &&
      (r!.groupId === undefined || r!.groupId === read.groupId)
    ) {
      if (operations.length >= 1000) reject(503, 'operation_response_limit');
      operations.push({
        ...read,
        kopecks: amount,
        signedKopecks: ds === 'expenses' ? -amount : amount,
      } as typeof read);
    }
  }
  const after = await membership(db, owner, p);
  if (JSON.stringify(before) !== JSON.stringify(after))
    reject(409, 'history_changed');
  for (const ds of ['expenses', 'incomes'] as const) {
    const entries = [...groups.values()].filter((g) => g.dataset === ds);
    if (
      entries.reduce((n, g) => safeAdd(n, g.kopecks), 0) !==
        totals[ds].kopecks ||
      entries.reduce((n, g) => n + g.count, 0) !== totals[ds].count
    )
      reject(503, 'reconciliation_failed');
  }
  return {
    version: 'classification-group-report-v3',
    window: p,
    totals,
    groups: [...groups.values()].map((g) => ({
      ...g,
      signedKopecks: g.dataset === 'expenses' ? -g.kopecks : g.kopecks,
    })),
    operations,
    coverage: 'complete_recorded_period',
    filtered: r!.dataset !== undefined || r!.groupId !== undefined,
    consistency: 'observed_only_non_atomic',
  };
};
export const groupPreview = async (
  db: mongo.Db,
  owner: string,
  input: unknown,
) => {
  const r = fields(input, [
    'version',
    'startInclusive',
    'endExclusive',
    'operations',
  ]);
  if (
    !r ||
    r.version !== 'classification-group-preview-v3' ||
    !Array.isArray(r.operations) ||
    r.operations.length < 1 ||
    r.operations.length > 100
  )
    reject(400, 'invalid_preview');
  const p = windowFields(r!),
    seen = new Set<string>(),
    rules = await listRules(db, owner),
    proposals = [];
  for (const input of r!.operations as unknown[]) {
    const op = fields(input, ['dataset', 'operationId']);
    if (
      !op ||
      Object.keys(op).length !== 2 ||
      !dataset(op.dataset) ||
      !id(op.operationId) ||
      seen.has(`${op.dataset}/${op.operationId}`)
    )
      reject(400, 'invalid_preview');
    seen.add(`${op!.dataset}/${op!.operationId}`);
    const read = await groupDecisionRead(
      db,
      owner,
      op!.dataset as 'expenses' | 'incomes',
      op!.operationId as string,
    );
    if (
      read.facts.dateEpochMs < p.startInclusive ||
      read.facts.dateEpochMs >= p.endExclusive
    )
      reject(409, 'history_changed');
    const matched = matchRule(rules, read.dataset, read.facts);
    proposals.push({
      dataset: read.dataset,
      operationId: read.operationId,
      expectedFacts: read.facts,
      expectedRevision: read.decisionRevision,
      sourceStatus: read.status,
      eligible: read.status === 'unreviewed' && matched?.diagnostic === 'ready',
      match: matched,
    });
  }
  return {
    version: 'classification-group-preview-v3',
    window: p,
    proposals,
    consistency: 'observed_only_non_atomic',
  };
};
