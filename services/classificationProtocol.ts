/** Approved HTTP protocol; operational/key ports are mandatory server wiring.
 * No ambient key/env/JWT secret resolver and no default production installation. */
import type { Application, RequestHandler, Request } from 'express';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Connection } from 'mongoose';
import { createReviewProofFoundation, type TrustedProofContext, type TrustedIssuance } from '../domain/classification/reviewProof';
import { readWriteFields, validateManualCommand, fingerprintClassificationCommand, type ManualCommand,
  type VerifiedReview } from '../domain/classification/writeCommand';
import { validateOperationIdentity, STABLE_TAXONOMY_VERSION } from '../domain/classification';
import { classificationFromBson } from '../persistence/classification';
import { classificationReadiness } from '../persistence/classificationReadiness';
import { authenticatedClassificationOwner } from './classificationPrincipal';
import { readSourceObservation, readStoredDecision } from './classificationObservation';
import { admitClassificationRead } from './classificationAdmission';
import { sendClassificationHttpError, type ClassificationHttpErrorCode } from './classificationHttpError';
import type { OperationalEventType } from './classificationRuntime/contracts';

type Mode = 'prepare' | 'apply' | 'reconcile';
export type ProtocolOperations = Readonly<{
  /** Must attest key/era/revocation, healthy clock, DDL exclusion, fleet safeguards
   * and rollout state. Missing/unavailable MUST fail closed. Not request data. */
  ready(mode: Mode): boolean | Promise<boolean>;
  /** Atomic fleet reservation BEFORE encryption, including all issuers/restarts.
   * A consumed reservation is never refunded on issuance failure. */
  reserveIssuance(): boolean | Promise<boolean>;
  nowSeconds(): number;
  /** P11 optional request-lifetime fleet admission; never expires/cancels a commit. */
  acquireAdmission?(mode: Mode): Promise<(() => Promise<void>) | null>;
  keyAllowed?(kid: string, mode: Mode, issuedAt: number, now: number): boolean;
  observe?(event: OperationalEventType): void;
}>;
export type ProtocolConfiguration = Readonly<{ keyring: unknown; deploymentId: string; operations: ProtocolOperations }>;
const installed = new WeakMap<Application, RequestHandler>();
const uuid = (x: unknown): x is string => typeof x === 'string' && x.length === 36
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const modes = { reviews: 'prepare', commands: 'apply', reconcile: 'reconcile' } as const;
const versions = { prepare: 'classification-review-request-v1', apply: 'classification-command-v1', reconcile: 'classification-reconcile-request-v1' } as const;

/** Server-owned installation, deliberately not invoked by app/server bootstrap.
 * Test configuration uses disposable keys and shared synthetic quota ports.
 * A reviewed production adapter must supply actual fleet governance first. */
export const installClassificationProtocol = (app: Application, connection: Connection, config: ProtocolConfiguration): (() => void) => {
  if (!config || !config.operations || ['ready', 'reserveIssuance', 'nowSeconds'].some(k => typeof config.operations[k as keyof ProtocolOperations] !== 'function'))
    throw new Error('Classification operational safeguards required');
  if (['acquireAdmission', 'keyAllowed', 'observe'].some(k => config.operations[k as keyof ProtocolOperations] !== undefined
    && typeof config.operations[k as keyof ProtocolOperations] !== 'function')) throw new Error('Classification operational safeguards required');
  const checkReady = config.operations.ready.bind(config.operations), reserveSlot = config.operations.reserveIssuance.bind(config.operations),
    now = config.operations.nowSeconds.bind(config.operations);
  const ready = async (mode: Mode): Promise<boolean> => (await checkReady(mode)) === true;
  const reserve = async (): Promise<boolean> => (await reserveSlot()) === true;
  const notify = (event: OperationalEventType) => { try { config.operations.observe?.(event); } catch { /* No external exception data. */ } };
  const contexts = new WeakMap<object, TrustedProofContext>(), issuance = new WeakMap<object, TrustedIssuance>();
  const context = (handle: unknown) => handle && typeof handle === 'object' ? contexts.get(handle) : undefined;
  const proof = createReviewProofFoundation(config.keyring, config.deploymentId, {
    resolveIssuance: handle => handle && typeof handle === 'object' ? issuance.get(handle) : undefined,
    resolveVerification: context, nowSeconds: now,
    ...(config.operations.keyAllowed ? { keyAllowed: config.operations.keyAllowed.bind(config.operations) } : {}),
  });
  if (!proof.ok) throw new Error('Classification proof configuration unavailable');
  const crypto = proof.value;
  // Default application import must retain the original disconnected-service
  // invariant. Load the writer only after explicit trusted runtime installation.
  const writer: typeof import('./classificationWrite') = require('./classificationWrite');
  const service = writer.createClassificationWriteService(connection, {
    resolveAuthenticatedOwner: async handle => {
      if (!await ready('apply')) return undefined;
      const c = context(handle); return c ? { owner: c.actor } : undefined;
    },
    resolveVerifiedReview: async (handle, evidence, command) => {
      if (!await ready('apply')) return undefined;
      const checked = crypto.verify(evidence, handle, command);
      return checked.ok ? checked.value : undefined; // Never recovery verification here.
    },
  });
  const handler: RequestHandler = async (req, res) => {
    let release: (() => void) | null = null;
    let releaseOperational: (() => Promise<void>) | null = null;
    let writeMayHaveStarted = false;
    const send = (status: number, code: ClassificationHttpErrorCode, persistence: 'not_applied' | 'unknown' = 'not_applied') =>
      sendClassificationHttpError(res, status, code, persistence);
    try {
      const mode = modes[req.params.action as keyof typeof modes];
      if (!mode || !await ready(mode)) { send(503, 'unavailable'); return; }
      if (config.operations.acquireAdmission) {
        releaseOperational = await config.operations.acquireAdmission(mode);
        if (!releaseOperational || !await ready(mode)) { send(503, 'unavailable'); return; }
      }
      const db = connection.readyState === 1 ? connection.db : undefined;
      if (!db) { send(503, 'unavailable'); return; }
      const owner = await authenticatedClassificationOwner(req, db);
      if (!owner) { send(401, 'reauth_required'); return; }
      const identity = validateOperationIdentity({ owner, dataset: req.params.dataset, operationId: req.params.operationId });
      const body = readWriteFields(req.body, ['version', 'browserReviewContext', 'requestId', 'expectedRevision', 'state', 'assignment',
        ...(mode === 'prepare' ? [] : ['reviewProof'])]);
      if (!identity.ok || !body || body.version !== versions[mode] || Object.keys(req.query).length || !uuid(body.browserReviewContext)
        || (mode !== 'prepare' && (typeof body.reviewProof !== 'string' || body.reviewProof.length > 4096))) {
        send(400, 'invalid_request'); return;
      }
      const c = validateManualCommand({ kind: 'manual_classification', dataset: identity.value.dataset, operationId: identity.value.operationId,
        state: body.state, requestId: body.requestId, expectedRevision: body.expectedRevision,
        ...(Object.hasOwn(body, 'assignment') ? { assignment: body.assignment } : {}) });
      if (!c.ok) { send(400, 'invalid_request'); return; }
      const command = c.value, browserReviewContext = body.browserReviewContext;
      release = admitClassificationRead(owner);
      if (!release) { send(503, 'unavailable'); return; }
      const bearer = exactBearer(req);
      if (!bearer) { send(401, 'reauth_required'); return; }
      const handle = Object.freeze({});
      const principal = req.user as { exp: number };
      contexts.set(handle, Object.freeze({ actor: owner, browserReviewContext, credentialExpiresAt: principal.exp,
        credentialBinding: createHash('sha256').update(JSON.stringify(['classification-review-credential', 1, bearer]), 'utf8').digest('hex') }));
      if (mode === 'apply') {
        // Authenticate proof before entering the write service for useful safe expiry
        // errors. Service resolver re-verifies at admission, never mints evidence.
        const checked = crypto.verify(body.reviewProof, handle, command);
        if (!checked.ok) {
          send(checked.error.code === 'proof_expired' ? 410 : checked.error.code === 'invalid_time' ? 503 : 403,
            checked.error.code === 'proof_expired' ? 'review_expired' : checked.error.code === 'invalid_time' ? 'unavailable' : 'invalid_review'); return;
        }
        writeMayHaveStarted = true;
        const result = await service.execute(handle, command, body.reviewProof);
        if (!result.ok) {
          const code = result.error.code;
          if (result.persistence === 'unknown') { notify('write_unknown'); send(503, 'persistence_unknown', 'unknown'); }
          else if (code === 'source_not_found') send(404, 'operation_not_found');
          else if (code === 'revision_conflict' || code === 'request_id_conflict' || code === 'stale_review' || code === 'revision_overflow') { notify('write_conflict'); send(409, code); }
          else if (code === 'blocked_decision' || code === 'unsupported_taxonomy' || code === 'unsupported_fingerprint_version') send(409, 'blocked_decision');
          else if (code === 'invalid_review' || code === 'review_mismatch') send(403, 'invalid_review');
          else if (code === 'invalid_command') send(400, 'invalid_request');
          else send(503, 'unavailable');
          return;
        }
        const r = result.value;
        notify('write_applied');
        res.status(r.outcome === 'created' ? 201 : 200).json({ ...r, version: 'classification-write-ack-v1',
          dataset: command.dataset, operationId: command.operationId, requestId: command.requestId }); return;
      }
      // Reconciliation authenticates all bindings first, allowing proof expiry only
      // within 24h. It never calls service.execute or any mutation method.
      const recovered = mode === 'reconcile' ? crypto.verifyRecovery(body.reviewProof, handle, command) : undefined;
      if (recovered && !recovered.ok) {
        send(recovered.error.code === 'proof_expired' ? 410 : recovered.error.code === 'invalid_time' ? 503 : 403,
          recovered.error.code === 'proof_expired' ? 'reconciliation_window_expired' : recovered.error.code === 'invalid_time' ? 'unavailable' : 'invalid_review'); return;
      }
      const observation = await readSourceObservation(db, owner, command.dataset, command.operationId);
      if (observation.status !== 'ok') { send(observation.status === 'missing' ? 404 : observation.status === 'too_large' ? 413 : 503,
        observation.status === 'missing' ? 'operation_not_found' : observation.status === 'too_large' ? 'review_too_large' : 'unavailable'); return; }
      if (!await classificationReadiness(db)) { send(503, 'unavailable'); return; }
      const raw: unknown = await readStoredDecision(db, owner, command.dataset, command.operationId);
      const parsed = raw === null ? null : classificationFromBson(raw);
      if (parsed && (!parsed.ok || parsed.value.owner !== owner || parsed.value.dataset !== command.dataset || parsed.value.operationId !== command.operationId)) {
        send(409, 'blocked_decision'); return;
      }
      const stored = parsed?.ok ? parsed.value : null;
      if (!await classificationReadiness(db) || !await ready(mode)) { send(503, 'unavailable'); return; }
      if (mode === 'reconcile' && recovered?.ok) {
        const review = recovered.value.review, hash = fingerprintClassificationCommand(owner, command, review, 1);
        if (!hash.ok) { send(400, 'invalid_request'); return; }
        let receipt = null;
        if (stored?.lastMutation.requestId === command.requestId) {
          if (stored.lastMutation.commandFingerprint !== hash.value.commandFingerprint) { send(409, 'request_id_conflict'); return; }
          if (stored.state !== command.state || !isDeepStrictEqual(stored.assignment, command.assignment)
            || stored.decisionRevision !== (command.expectedRevision === null ? 1 : command.expectedRevision + 1)
            || stored.sourceFingerprint !== review.sourceFingerprint) { send(409, 'blocked_decision'); return; }
          receipt = { storedState: stored.state, decisionRevision: stored.decisionRevision,
            sourceStatus: stored.sourceFingerprint === observation.value.fingerprint.sourceFingerprint ? 'matching_observed' : 'stale' };
        }
        notify(receipt ? 'reconcile_completed' : 'reconcile_indeterminate');
        res.json({ version: 'classification-reconcile-v1', dataset: command.dataset, operationId: command.operationId, requestId: command.requestId,
          result: receipt ? 'latest_applied' : 'indeterminate', receipt, confirmed: null, consistency: 'observed_only_non_atomic' }); return;
      }
      if (command.expectedRevision !== (stored?.decisionRevision ?? null)) { send(409, 'revision_conflict'); return; }
      // Only this preparation path can authorize issuance from an owned snapshot.
      const review: VerifiedReview = { kind: 'verified_manual_review', owner, dataset: command.dataset, operationId: command.operationId,
        ...observation.value.fingerprint };
      issuance.set(handle, Object.freeze({ ...contexts.get(handle)!, review }));
      if (!await reserve() || !await ready('prepare')) { send(503, 'unavailable'); return; }
      const issued = crypto.issue(handle, command);
      if (!issued.ok) { send(503, 'unavailable'); return; }
      const { date: _date, ...facts } = observation.value.facts;
      const intent = publicIntent(command);
      const response = { version: 'classification-review-v1', dataset: command.dataset, operationId: command.operationId,
        taxonomyVersion: STABLE_TAXONOMY_VERSION, browserReviewContext, currentDecision: { storedState: stored?.state ?? null,
          decisionRevision: stored?.decisionRevision ?? null }, intent, facts, ...issued.value, consistency: 'observed_only_non_atomic' };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 65536) { send(413, 'review_too_large'); return; }
      res.json(response);
    } catch { if (writeMayHaveStarted) notify('write_unknown'); send(503, 'internal_failure', writeMayHaveStarted ? 'unknown' : 'not_applied'); }
    finally {
      release?.();
      // Managed releases latch health/drain failure internally. Never transform
      // an already applied acknowledgement into a fictitious rollback.
      if (releaseOperational) try { await releaseOperational(); } catch { /* Trusted provider owns unresolved admission. */ }
    }
  };
  installed.set(app, handler);
  return () => { if (installed.get(app) === handler) installed.delete(app); };
};
const exactBearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') && header.length > 7 ? header.slice(7) : null;
};
const publicIntent = (c: ManualCommand) => ({ requestId: c.requestId, expectedRevision: c.expectedRevision,
  state: c.state, ...(c.assignment ? { assignment: c.assignment } : {}) });

export const classificationProtocol: RequestHandler = (req, res, next) => {
  const action = req.path.endsWith('/commands/reconcile') ? 'reconcile' : req.path.endsWith('/reviews') ? 'reviews' : 'commands';
  const gate = action === 'reviews' ? 'CLASSIFICATION_REVIEW_ENABLED' : action === 'reconcile' ? 'CLASSIFICATION_RECONCILE_ENABLED' : 'CLASSIFICATION_WRITE_ENABLED';
  const handler = installed.get(req.app);
  if (process.env[gate] !== '1' || !handler) { sendClassificationHttpError(res, 503, 'unavailable'); return; }
  req.params.action = action;
  return handler(req, res, next);
};
