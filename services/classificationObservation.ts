/** One owner-scoped source observation supplies BOTH display facts and hash. */
import { Types, type mongo } from 'mongoose';
import type { Dataset } from '../domain/classification';
import { sourceFingerprintFromBson } from '../persistence/classificationSource';
import { classificationFromBson } from '../persistence/classification';
import { CLASSIFICATION_MANIFEST as manifest } from '../persistence/classificationManifest';
import type { SourceFingerprint } from '../domain/classification/sourceFingerprint';

export type SourceFacts = Readonly<{ amount: { format: 'binary64-roundtrip-decimal'; value: string };
  dateEpochMs: number; date: string; comment: { kind: 'missing' } | { kind: 'null' } | { kind: 'value'; value: string };
  category?: string; title?: string; recipient?: string; source?: string }>;
export const sourceProjection = (dataset: Dataset) => ({ _id: 1, owner: 1, amount: 1, date: 1, comment: 1,
  ...(dataset === 'expenses' ? { category: 1, title: 1, recipient: 1 } : { source: 1 }) });

export const presentSource = (raw: unknown, identity: { owner: string; dataset: Dataset; operationId: string }) => {
  const checked = sourceFingerprintFromBson(raw, identity);
  if (!checked.ok) return null;
  // The mapper established own data fields, exact native date and primitive amount.
  const r = raw as Record<string, unknown>, amount = r.amount as number;
  const dateEpochMs = Date.prototype.getTime.call(r.date);
  if (dateEpochMs < -62135596800000 || dateEpochMs >= 253402300800000) return null;
  const names = identity.dataset === 'expenses' ? ['category', 'title', 'recipient'] : ['source'];
  for (const key of [...names, 'comment']) {
    if (typeof r[key] === 'string' && Buffer.byteLength(r[key], 'utf8') > 8192) return null;
    // Reject lone surrogates: UTF-8 cannot preserve them exactly.
    if (typeof r[key] === 'string' && Buffer.from(r[key], 'utf8').toString('utf8') !== r[key]) return null;
  }
  const comment: SourceFacts['comment'] = !Object.hasOwn(r, 'comment') ? { kind: 'missing' }
    : r.comment === null ? { kind: 'null' } : { kind: 'value', value: r.comment as string };
  const facts: SourceFacts = { amount: { format: 'binary64-roundtrip-decimal', value: Object.is(amount, -0) ? '-0' : String(amount) },
    dateEpochMs, date: new Date(dateEpochMs).toISOString(), comment,
    ...Object.fromEntries(names.map(key => [key, r[key]])) };
  if (Buffer.byteLength(JSON.stringify(facts), 'utf8') > 32768) return null;
  return { facts, fingerprint: checked.value };
};

export const readSourceObservation = async (db: mongo.Db, owner: string, dataset: Dataset, operationId: string) => {
  const raw: unknown = await db.collection(dataset).findOne({ owner: new Types.ObjectId(owner), _id: new Types.ObjectId(operationId) },
    { projection: sourceProjection(dataset), maxTimeMS: 3000, promoteLongs: false });
  if (raw === null) return { status: 'missing' as const };
  const value = presentSource(raw, { owner, dataset, operationId });
  return value ? { status: 'ok' as const, value } : { status: 'invalid' as const };
};

export const readStoredDecision = async (db: mongo.Db, owner: string, dataset: Dataset, operationId: string) =>
  db.collection(manifest.collectionName).findOne({ owner: new Types.ObjectId(owner), dataset, operationId: new Types.ObjectId(operationId) },
    { maxTimeMS: 3000, promoteLongs: false });

export const effectiveClassification = (raw: unknown, owner: string, dataset: Dataset, operationId: string, current: SourceFingerprint) => {
  const base = { version: 'classification-read-v1' as const, dataset, operationId, consistency: 'observed_only_non_atomic' as const };
  if (raw === null) return { ...base, status: 'unreviewed', storedState: null, decisionRevision: null, confirmed: null };
  const parsed = classificationFromBson(raw);
  if (!parsed.ok || parsed.value.owner !== owner || parsed.value.dataset !== dataset || parsed.value.operationId !== operationId)
    return { ...base, status: 'blocked', storedState: null, decisionRevision: null, confirmed: null };
  const r = parsed.value, status = r.sourceFingerprint !== current.sourceFingerprint ? 'stale' : r.state;
  return { ...base, status, storedState: r.state, decisionRevision: r.decisionRevision, confirmed: status === 'approved' ? r.assignment : null };
};
