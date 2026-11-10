import { isDeepStrictEqual } from 'node:util';
import { Types, type mongo } from 'mongoose';
import {
  GROUP_TAXONOMY,
  fields,
  dataset,
  id,
  uuid,
  revision,
  groupId,
} from '../../domain/classification/groups';
import {
  groupDecisionFromBson,
  hash,
  reject,
} from '../../persistence/classificationGroups';
import {
  readSourceObservation,
  readStoredDecision,
} from '../classificationObservation';
import { getGroup, historicalGroup, oid, writeOptions } from './catalog';
import { groupsReady } from '../../persistence/classificationGroupsManifest';
export const observedGroupDecision = async (
  raw: unknown,
  source: NonNullable<
    Extract<
      Awaited<ReturnType<typeof readSourceObservation>>,
      { status: 'ok' }
    >['value']
  >,
  owner: string,
  ds: 'expenses' | 'incomes',
  operationId: string,
  lookup: (target: string) => ReturnType<typeof historicalGroup>,
) => {
  const stored = raw === null ? null : groupDecisionFromBson(raw);
  if (raw !== null && !stored) reject(503, 'blocked_decision');
  if (
    stored &&
    (stored.owner !== owner ||
      stored.dataset !== ds ||
      stored.operationId !== operationId)
  )
    reject(503, 'blocked_decision');
  const status = stored
    ? stored.sourceFingerprint === source.fingerprint.sourceFingerprint
      ? stored.state
      : 'stale'
    : 'unreviewed';
  const group = stored?.groupId ? await lookup(stored.groupId) : null;
  if (stored?.groupId && !group) reject(503, 'group_reference_missing');
  return {
    version: 'classification-group-read-v3',
    dataset: ds,
    operationId,
    facts: source.facts,
    sourceFingerprint: source.fingerprint.sourceFingerprint,
    sourceFingerprintVersion: 1,
    decisionRevision: stored?.decisionRevision ?? null,
    status,
    storedState: stored?.state ?? null,
    storedGroupId: stored?.groupId ?? null,
    groupId: status === 'approved' ? (stored?.groupId ?? null) : null,
    group,
    consistency: 'observed_only_non_atomic',
    legacy: stored !== null && stored.taxonomyVersion !== GROUP_TAXONOMY,
  };
};
export const groupDecisionRead = async (
  db: mongo.Db,
  owner: string,
  ds: 'expenses' | 'incomes',
  operationId: string,
) => {
  const source = await readSourceObservation(db, owner, ds, operationId);
  if (source.status === 'missing') reject(404, 'source_not_found');
  if (source.status !== 'ok') reject(503, 'source_unavailable');
  return observedGroupDecision(
    await readStoredDecision(db, owner, ds, operationId),
    source.value!,
    owner,
    ds,
    operationId,
    (target) => historicalGroup(db, owner, target, ds),
  );
};
export const writeGroupDecision = async (
  db: mongo.Db,
  owner: string,
  ds: unknown,
  operationId: unknown,
  input: unknown,
  attempt: () => void,
) => {
  const r = fields(input, [
    'version',
    'requestId',
    'expectedRevision',
    'state',
    'groupId',
    'expectedFacts',
  ]);
  if (
    !dataset(ds) ||
    !id(operationId) ||
    !r ||
    r.version !== 'classification-group-decision-v3' ||
    !uuid(r.requestId) ||
    (r.expectedRevision !== null && !revision(r.expectedRevision)) ||
    !['approved', 'explicit_unclassified', 'cleared'].some(
      (v) => v === r.state,
    ) ||
    (r.state === 'approved' && !groupId(r.groupId))
  )
    reject(400, 'invalid_group_decision');
  // Explicit facts/revision describe the confirmed intent. A confirmation boolean
  // alone is never accepted. No implicit classification from rules/catalog writes.
  if (
    !r ||
    (r.state !== 'approved' && Object.hasOwn(r, 'groupId')) ||
    !dataset(ds) ||
    !id(operationId)
  )
    reject(400, 'invalid_group_decision');
  const source = await readSourceObservation(db, owner, ds, operationId);
  if (source.status === 'missing') reject(404, 'source_not_found');
  if (source.status !== 'ok') reject(503, 'source_unavailable');
  if (!isDeepStrictEqual(r.expectedFacts, source.value!.facts))
    reject(409, 'source_facts_conflict');
  const previousRaw = await readStoredDecision(db, owner, ds, operationId),
    previous = previousRaw === null ? null : groupDecisionFromBson(previousRaw);
  if (previousRaw !== null && !previous) reject(503, 'blocked_decision');
  const digest = hash([
    'group-decision-v3',
    owner,
    ds,
    operationId,
    r.requestId,
    r.expectedRevision,
    r.state,
    r.groupId ?? null,
    source.value!.fingerprint.sourceFingerprint,
  ]);
  if (previous?.lastMutation.requestId === r.requestId) {
    if (
      previous.taxonomyVersion !== GROUP_TAXONOMY ||
      previous.lastMutation.commandFingerprint !== digest ||
      previous.decisionRevision !==
        (r.expectedRevision === null
          ? 1
          : (r.expectedRevision as number) + 1) ||
      previous.state !== r.state ||
      previous.groupId !== (r.groupId ?? undefined) ||
      previous.sourceFingerprint !== source.value!.fingerprint.sourceFingerprint
    )
      reject(409, 'request_id_conflict');
    return {
      outcome: 'replayed',
      decision: await groupDecisionRead(db, owner, ds, operationId),
    };
  }
  if ((previous?.decisionRevision ?? null) !== r.expectedRevision)
    reject(409, 'revision_conflict');
  if (previous?.decisionRevision === Number.MAX_SAFE_INTEGER)
    reject(409, 'revision_overflow');
  const group =
    r.state === 'approved'
      ? await getGroup(db, owner, r.groupId as string, ds)
      : null;
  if (r.state === 'approved' && (!group || group.status !== 'active'))
    reject(409, 'group_unavailable');
  if (!(await groupsReady(db))) reject(503, 'infrastructure_unavailable');
  const finalSource = await readSourceObservation(db, owner, ds, operationId);
  if (finalSource.status === 'missing') reject(404, 'source_not_found');
  if (finalSource.status !== 'ok') reject(503, 'source_unavailable');
  if (
    finalSource.value!.fingerprint.sourceFingerprint !==
    source.value!.fingerprint.sourceFingerprint
  )
    reject(409, 'source_facts_conflict');
  if (group) {
    const latest = await getGroup(db, owner, group.groupId, ds);
    if (
      !latest ||
      latest.status !== 'active' ||
      latest.revision !== group.revision
    )
      reject(409, 'group_changed');
  }
  const now = new Date(
    Math.max(Date.now(), previous?.updatedAt.getTime() ?? 0),
  );
  const doc = {
    _id: previous ? oid(previous._id) : new Types.ObjectId(),
    owner: oid(owner),
    dataset: ds,
    operationId: oid(operationId),
    taxonomyVersion: GROUP_TAXONOMY,
    decisionOrigin: 'manual',
    decisionRevision: previous ? previous.decisionRevision + 1 : 1,
    state: r.state,
    ...(r.state === 'approved' ? { groupId: r.groupId } : {}),
    ...source.value!.fingerprint,
    sourceObservedAt: now,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastMutation: {
      requestId: r.requestId,
      commandFingerprint: digest,
      commandFingerprintVersion: 1,
    },
  };
  if (!groupDecisionFromBson(doc)) reject(503, 'invalid_candidate');
  attempt();
  if (previous) {
    const result = await db
      .collection('operation_classifications')
      .replaceOne(
        {
          _id: doc._id,
          owner: doc.owner,
          dataset: ds,
          operationId: doc.operationId,
          decisionRevision: r.expectedRevision,
        },
        doc,
        writeOptions,
      );
    if (!result.acknowledged) reject(503, 'write_unknown');
    if (result.matchedCount !== 1) reject(409, 'revision_conflict');
  } else {
    const result = await db
      .collection('operation_classifications')
      .insertOne(doc, writeOptions);
    if (!result.acknowledged) reject(503, 'write_unknown');
  }
  const read = await groupDecisionRead(db, owner, ds, operationId);
  if (
    read.decisionRevision !== doc.decisionRevision ||
    read.storedState !== r.state ||
    read.storedGroupId !== (r.groupId ?? null)
  )
    reject(503, 'write_unknown');
  // Concurrent source PATCH/DELETE or group archive is not a transaction. Never
  // claim an active assignment if the final observation no longer establishes it.
  if (group) {
    const finalGroup = await getGroup(db, owner, group.groupId, ds);
    if (
      !finalGroup ||
      finalGroup.status !== 'active' ||
      finalGroup.revision !== group.revision
    )
      reject(503, 'write_unknown');
  }
  return { outcome: previous ? 'updated' : 'created', decision: read };
};

export const reconcileGroupDecision = async (
  db: mongo.Db,
  owner: string,
  ds: 'expenses' | 'incomes',
  operationId: string,
  input: unknown,
) => {
  const r = fields(input, [
    'version',
    'requestId',
    'expectedRevision',
    'state',
    'groupId',
    'expectedFacts',
  ]);
  if (
    !r ||
    r.version !== 'classification-group-decision-v3' ||
    !uuid(r.requestId) ||
    (r.expectedRevision !== null && !revision(r.expectedRevision)) ||
    !['approved', 'explicit_unclassified', 'cleared'].some(
      (v) => v === r.state,
    ) ||
    (r.state === 'approved' ? !groupId(r.groupId) : Object.hasOwn(r, 'groupId'))
  )
    reject(400, 'invalid_reconcile');
  const read = await groupDecisionRead(db, owner, ds, operationId),
    raw = await readStoredDecision(db, owner, ds, operationId),
    stored = raw === null ? null : groupDecisionFromBson(raw);
  const digest = isDeepStrictEqual(r!.expectedFacts, read.facts)
    ? hash([
        'group-decision-v3',
        owner,
        ds,
        operationId,
        r!.requestId,
        r!.expectedRevision,
        r!.state,
        r!.groupId ?? null,
        read.sourceFingerprint,
      ])
    : null;
  const matching =
    stored?.taxonomyVersion === GROUP_TAXONOMY &&
    read.decisionRevision === stored.decisionRevision &&
    read.storedState === stored.state &&
    read.storedGroupId === (stored.groupId ?? null) &&
    read.status !== 'stale' &&
    stored.sourceFingerprint === read.sourceFingerprint &&
    stored.lastMutation.requestId === r!.requestId &&
    stored.lastMutation.commandFingerprint === digest &&
    stored.decisionRevision ===
      (r!.expectedRevision === null
        ? 1
        : (r!.expectedRevision as number) + 1) &&
    stored.state === r!.state &&
    stored.groupId === (r!.groupId ?? undefined);
  return {
    version: 'classification-group-reconcile-v3',
    outcome: matching ? 'observed_matching' : 'unresolved',
    decision: read,
    consistency: 'observed_only_non_atomic',
  };
};
