/** Disconnected internal service. No ambient connection, route, env, bootstrap or DDL. */
import { Types, mongo, type Connection } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { STABLE_TAXONOMY_VERSION, validateOperationIdentity } from '../domain/classification';
import { compareSourceFingerprints, type SourceFingerprint } from '../domain/classification/sourceFingerprint';
import { validateManualCommand, validateVerifiedReview, fingerprintClassificationCommand, readWriteFields,
  type ManualCommand, type VerifiedReview, type WriteValidationCode } from '../domain/classification/writeCommand';
import { classificationFromBson, prepareClassificationDocument, validateClassificationRecord,
  type ClassificationRecord } from '../persistence/classification';
import { CLASSIFICATION_MANIFEST as manifest } from '../persistence/classificationManifest';
import { classificationReadiness } from '../persistence/classificationReadiness';
import { sourceFingerprintFromBson } from '../persistence/classificationSource';

/** Mandatory trusted server configuration, NEVER supplied by an HTTP caller.
 * Implementations must authenticate context and verify prior manual review evidence.
 * No default/identity resolver or save-time review minting is provided by this module. */
export interface ClassificationWriteTrust {
  resolveAuthenticatedOwner(context: unknown): unknown | Promise<unknown>; // closed {owner}
  resolveVerifiedReview(context: unknown, evidence: unknown, command: ManualCommand): unknown | Promise<unknown>;
}
export type WriteErrorCode = WriteValidationCode | 'invalid_context' | 'source_not_found' | 'source_unavailable'
  | 'malformed_source' | 'stale_review' | 'revision_conflict' | 'request_id_conflict' | 'revision_overflow'
  | 'unsupported_taxonomy' | 'blocked_decision' | 'infrastructure_unavailable' | 'persistence_failure';
type SourceStatus = 'matching_observed' | 'stale' | 'missing' | 'invalid' | 'unavailable';
export type WriteResult =
  | Readonly<{ ok: false; error: { code: WriteErrorCode }; persistence: 'not_applied' | 'unknown' }>
  | Readonly<{ ok: true; value: Readonly<{
    version: 'classification-write-result-v1'; outcome: 'created' | 'updated' | 'replayed';
    storedState: ManualCommand['state']; decisionRevision: number; sourceStatus: SourceStatus;
    confirmed: null; consistency: 'observed_only_non_atomic';
  }> }>;
const failure = (code: WriteErrorCode, persistence: 'not_applied' | 'unknown' = 'not_applied'): WriteResult =>
  ({ ok: false, error: { code }, persistence });
const matches = (left: SourceFingerprint, right: SourceFingerprint): boolean => {
  // The versioned helper intentionally rejects any extra envelope fields.
  const projection = (r: SourceFingerprint): SourceFingerprint =>
    ({ sourceFingerprint: r.sourceFingerprint, sourceFingerprintVersion: r.sourceFingerprintVersion });
  const result = compareSourceFingerprints(projection(left), projection(right));
  return result.ok && result.value.matches;
};

export const createClassificationWriteService = (connection: Connection, trust: ClassificationWriteTrust) => {
  if (!trust || typeof trust.resolveAuthenticatedOwner !== 'function' || typeof trust.resolveVerifiedReview !== 'function')
    throw new Error('Classification write trust boundary required');
  // Capture the configured boundary, not mutable request-supplied functions.
  const resolveOwner = trust.resolveAuthenticatedOwner.bind(trust), resolveReview = trust.resolveVerifiedReview.bind(trust);

  const execute = async (context: unknown, commandInput: unknown, evidence: unknown): Promise<WriteResult> => {
    let owner: string;
    try {
      const r = readWriteFields(await resolveOwner(context), ['owner']);
      const identity = validateOperationIdentity({ owner: r?.owner, dataset: 'expenses', operationId: '000000000000000000000000' });
      if (!identity.ok) return failure('invalid_context');
      owner = identity.value.owner.toLowerCase();
    } catch { return failure('invalid_context'); }
    const command = validateManualCommand(commandInput);
    if (!command.ok) return failure(command.error.code);
    const c = command.value;
    let review: VerifiedReview;
    try {
      const checked = validateVerifiedReview(await resolveReview(context, evidence, c));
      if (!checked.ok) return failure(checked.error.code);
      review = checked.value;
    } catch { return failure('invalid_review'); }
    if (review.owner !== owner || review.dataset !== c.dataset || review.operationId !== c.operationId)
      return failure('review_mismatch');
    const commandHash = fingerprintClassificationCommand(owner, c, review, 1);
    if (!commandHash.ok) return failure(commandHash.error.code);
    const db = connection.readyState === 1 ? connection.db : undefined;
    if (!db) return failure('infrastructure_unavailable');
    const scope = { owner: new Types.ObjectId(owner), dataset: c.dataset, operationId: new Types.ObjectId(c.operationId) };
    const collection = db.collection(manifest.collectionName);
    const ready = async (): Promise<boolean> => {
      try { return await classificationReadiness(db); } catch { return false; }
    };
    const readSource = async (): Promise<{ ok: true; value: SourceFingerprint } | { ok: false; code: WriteErrorCode }> => {
      try {
        const projection = c.dataset === 'expenses'
          ? { _id: 1, owner: 1, amount: 1, date: 1, category: 1, title: 1, recipient: 1, comment: 1 }
          : { _id: 1, owner: 1, amount: 1, date: 1, source: 1, comment: 1 };
        const source: unknown = await db.collection(c.dataset).findOne({ _id: scope.operationId, owner: scope.owner },
          { projection, maxTimeMS: 3000, promoteLongs: false });
        if (source === null) return { ok: false, code: 'source_not_found' };
        const checked = sourceFingerprintFromBson(source, { owner, dataset: c.dataset, operationId: c.operationId });
        return checked.ok ? checked : { ok: false, code: 'malformed_source' };
      } catch { return { ok: false, code: 'source_unavailable' }; }
    };
    const readDecision = async () => {
      const raw: unknown = await collection.findOne(scope, { maxTimeMS: 3000, promoteLongs: false });
      if (raw === null) return { ok: true as const, value: null };
      const checked = classificationFromBson(raw);
      if (!checked.ok) {
        // The mapper has already established a closed own-data driver record before
        // reporting invalid_fingerprint. Revalidate with v1 solely to identify an
        // otherwise interpretable record carrying an unsupported fingerprint version.
        const unsupportedFingerprint = checked.error.code === 'invalid_fingerprint'
          && classificationFromBson({ ...(raw as Record<string, unknown>), sourceFingerprintVersion: 1 }).ok;
        return { ok: false as const, code: checked.error.code === 'unsupported_taxonomy'
          ? 'unsupported_taxonomy' as const : unsupportedFingerprint
            ? 'unsupported_fingerprint_version' as const : 'blocked_decision' as const };
      }
      const r = checked.value;
      return r.owner === owner && r.dataset === c.dataset && r.operationId === c.operationId
        ? { ok: true as const, value: r } : { ok: false as const, code: 'blocked_decision' as const };
    };
    const replay = (r: ClassificationRecord): 'same' | 'different' | 'invalid' | 'other' => {
      if (r.lastMutation.requestId !== c.requestId) return 'other';
      if (r.lastMutation.commandFingerprint !== commandHash.value.commandFingerprint) return 'different';
      // Verify actual persisted intent too; digest syntax alone is not proof of a replay.
      if (r.decisionRevision !== (c.expectedRevision === null ? 1 : c.expectedRevision + 1)
        || r.state !== c.state || !isDeepStrictEqual(r.assignment, c.assignment) || !matches(r, review)) return 'invalid';
      return 'same';
    };
    const finish = async (outcome: 'created' | 'updated' | 'replayed', r: ClassificationRecord): Promise<WriteResult> => {
      const post = await readSource();
      const sourceStatus: SourceStatus = post.ok ? matches(post.value, review) ? 'matching_observed' : 'stale'
        : post.code === 'source_not_found' ? 'missing' : post.code === 'malformed_source' ? 'invalid' : 'unavailable';
      return { ok: true, value: { version: 'classification-write-result-v1', outcome, storedState: r.state,
        decisionRevision: r.decisionRevision, sourceStatus, confirmed: null, consistency: 'observed_only_non_atomic' } };
    };
    const reconcile = async (): Promise<WriteResult> => {
      // One reread only, never reapply against a newer revision.
      if (!await ready()) return failure('infrastructure_unavailable');
      const latest = await readDecision();
      if (!latest.ok) return failure(latest.code);
      if (!latest.value) return failure('revision_conflict');
      const kind = replay(latest.value);
      return kind === 'same' ? finish('replayed', latest.value)
        : failure(kind === 'different' ? 'request_id_conflict' : kind === 'invalid' ? 'blocked_decision' : 'revision_conflict');
    };
    let writeAttempted = false;
    try {
      const initialSource = await readSource();
      if (!initialSource.ok) return failure(initialSource.code);
      if (!matches(initialSource.value, review)) return failure('stale_review');
      if (!await ready()) return failure('infrastructure_unavailable');
      const stored = await readDecision();
      if (!stored.ok) return failure(stored.code);
      const previous = stored.value;
      const repeat = previous ? replay(previous) : 'other';
      if (repeat === 'different') return failure('request_id_conflict');
      if (repeat === 'invalid') return failure('blocked_decision');
      if (repeat !== 'same') {
        if (previous ? c.expectedRevision !== previous.decisionRevision : c.expectedRevision !== null)
          return failure('revision_conflict');
        if (previous?.decisionRevision === Number.MAX_SAFE_INTEGER) return failure('revision_overflow');
      }
      // No positive readiness cache. DDL must still be administratively excluded during writes.
      if (!await ready()) return failure('infrastructure_unavailable');
      const finalSource = await readSource();
      if (!finalSource.ok) return failure(finalSource.code);
      if (!matches(finalSource.value, review)) return failure('stale_review');
      if (repeat === 'same' && previous) return finish('replayed', previous);
      const now = new Date(Math.max(Date.now(), previous?.updatedAt.getTime() ?? 0));
      const candidate = {
        owner, dataset: c.dataset, operationId: c.operationId, state: c.state,
        ...(c.state === 'approved' ? { assignment: c.assignment } : {}),
        taxonomyVersion: STABLE_TAXONOMY_VERSION, decisionOrigin: 'manual',
        decisionRevision: previous ? previous.decisionRevision + 1 : 1,
        ...reviewFingerprint(review), sourceObservedAt: new Date(),
        createdAt: previous?.createdAt ?? now, updatedAt: now,
        lastMutation: { requestId: c.requestId, ...commandHash.value },
      };
      // From this point there is no async work before the single write. No financial source writes.
      const options = { maxTimeMS: 3000, writeConcern: { w: 'majority' as const, wtimeoutMS: 3000 } };
      if (!previous) {
        // prepare generated ObjectId and checked all fields before driver serialization.
        const prepared = prepareClassificationDocument(candidate);
        if (!prepared.ok) return failure('blocked_decision');
        writeAttempted = true;
        try {
          const result = await collection.insertOne(prepared.value, options);
          if (!result.acknowledged) return failure('persistence_failure', 'unknown');
        }
        catch (error) {
          if (error instanceof mongo.MongoServerError && error.code === 11000
            && isDeepStrictEqual(error.keyPattern, manifest.index.key)) return await reconcile();
          return failure('persistence_failure', 'unknown');
        }
        const persisted = classificationFromBson(prepared.value);
        return persisted.ok ? finish('created', persisted.value) : failure('persistence_failure', 'unknown');
      }
      const checked = validateClassificationRecord({ ...candidate, _id: previous._id });
      if (!checked.ok) return failure('blocked_decision');
      const set = { state: candidate.state, taxonomyVersion: candidate.taxonomyVersion,
        decisionOrigin: candidate.decisionOrigin, decisionRevision: candidate.decisionRevision,
        ...reviewFingerprint(review), sourceObservedAt: candidate.sourceObservedAt,
        updatedAt: candidate.updatedAt, lastMutation: candidate.lastMutation,
        ...(c.state === 'approved' ? { assignment: c.assignment } : {}),
      };
      writeAttempted = true;
      const result = await collection.updateOne({ ...scope, _id: new Types.ObjectId(previous._id), decisionRevision: c.expectedRevision },
        { $set: set, ...(c.state !== 'approved' ? { $unset: { assignment: '' } } : {}) }, { ...options, upsert: false });
      if (!result.acknowledged) return failure('persistence_failure', 'unknown');
      if (result.matchedCount === 0) return await reconcile();
      return finish('updated', checked.value);
    } catch { return failure('persistence_failure', writeAttempted ? 'unknown' : 'not_applied'); }
  };
  return Object.freeze({
    async execute(context: unknown, command: unknown, evidence: unknown): Promise<WriteResult> {
      try { return await execute(context, command, evidence); }
      catch { return failure('persistence_failure', 'unknown'); }
    },
  });
};
const reviewFingerprint = (r: VerifiedReview): SourceFingerprint =>
  ({ sourceFingerprint: r.sourceFingerprint, sourceFingerprintVersion: r.sourceFingerprintVersion });
