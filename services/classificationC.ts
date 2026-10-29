/** Architecture C: process-local manual review boundary, independent of P11 proofs. */
import { performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import mongoose, { type Connection } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import {
  readWriteFields,
  validateManualCommand,
  fingerprintClassificationCommand,
  type ManualCommand,
  type VerifiedReview,
} from '../domain/classification/writeCommand';
import { classificationReadiness } from '../persistence/classificationReadiness';
import { classificationFromBson } from '../persistence/classification';
import { authenticatedClassificationOwner } from './classificationPrincipal';
import {
  readSourceObservation,
  readStoredDecision,
  effectiveClassification,
} from './classificationObservation';
import {
  createClassificationWriteService,
  type WriteResult,
} from './classificationWrite';

type Context = {
  owner: string;
  session: string;
  command: ManualCommand;
  review: VerifiedReview;
  deadline: number;
  retainUntil: number;
  attempted: boolean;
  result?: WriteResult;
};
const VERSION = 'classification-c-v1';
const TTL = 300000,
  RETENTION = 86400000,
  CAPACITY = 256;

/** New process/instance means a new empty context store. No timers, DDL or keys. */
export const createClassificationC = (
  connection: Connection,
): RequestHandler => {
  const contexts = new Map<string, Context>();
  const writer = createClassificationWriteService(connection, {
    resolveAuthenticatedOwner: (context) => ({
      owner: (context as Context).owner,
    }),
    resolveVerifiedReview: (context, evidence, command) => {
      const c = context as Context;
      // Only this handler can supply a context identity from its private map.
      if (
        evidence !== c ||
        !c.attempted ||
        !isDeepStrictEqual(command, c.command)
      )
        throw new Error('Invalid review');
      return c.review;
    },
  });
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Authorization');
    const fail = (
      status: number,
      code: string,
      persistence = 'not_applied',
    ) => {
      res
        .status(status)
        .json({ version: VERSION, error: { code }, persistence });
    };
    let attempting = false;
    try {
      if (process.env.CLASSIFICATION_C_WRITE_ENABLED !== '1') {
        fail(503, 'unavailable');
        return;
      }
      const db = connection.readyState === 1 ? connection.db : undefined;
      if (!db) {
        fail(503, 'unavailable');
        return;
      }
      const owner = await authenticatedClassificationOwner(req, db);
      if (!owner) {
        fail(401, 'reauth_required');
        return;
      }
      if (!(await classificationReadiness(db))) {
        fail(503, 'unavailable');
        return;
      }
      const session = createHash('sha256')
        .update(req.headers.authorization ?? '')
        .digest('hex');
      const now = performance.now();
      for (const [id, c] of contexts)
        if (now >= (c.attempted ? c.retainUntil : c.deadline))
          contexts.delete(id);
      const action = req.path.split('/').filter(Boolean).at(-1);
      if (action === 'prepare') {
        const r = readWriteFields(req.body, ['version', 'command']);
        const parsed = validateManualCommand(r?.command);
        if (
          !r ||
          r.version !== VERSION ||
          !parsed.ok ||
          parsed.value.dataset !== req.params.dataset ||
          parsed.value.operationId !== req.params.operationId
        ) {
          fail(400, 'invalid_request');
          return;
        }
        if (contexts.size >= CAPACITY) {
          fail(503, 'capacity_exceeded');
          return;
        }
        const command = parsed.value;
        const source = await readSourceObservation(
          db,
          owner,
          command.dataset,
          command.operationId,
        );
        if (source.status !== 'ok') {
          fail(
            source.status === 'missing' ? 404 : 503,
            source.status === 'missing'
              ? 'operation_not_found'
              : 'invalid_source',
          );
          return;
        }
        const raw = await readStoredDecision(
          db,
          owner,
          command.dataset,
          command.operationId,
        );
        const decision = effectiveClassification(
          raw,
          owner,
          command.dataset,
          command.operationId,
          source.value.fingerprint,
        );
        if (decision.status === 'blocked') {
          fail(409, 'blocked_decision');
          return;
        }
        if (decision.decisionRevision !== command.expectedRevision) {
          fail(409, 'revision_conflict');
          return;
        }
        // Recheck after asynchronous observations to keep admission bounded.
        if (contexts.size >= CAPACITY) {
          fail(503, 'capacity_exceeded');
          return;
        }
        const preparationId = randomBytes(32).toString('base64url');
        const expiresAt = Date.now() + TTL,
          deadline = performance.now() + TTL;
        contexts.set(preparationId, {
          owner,
          session,
          command,
          review: {
            kind: 'verified_manual_review',
            owner,
            dataset: command.dataset,
            operationId: command.operationId,
            ...source.value.fingerprint,
          },
          deadline,
          retainUntil: deadline + RETENTION,
          attempted: false,
        });
        res
          .status(200)
          .json({
            version: VERSION,
            preparationId,
            expiresAt,
            command,
            facts: source.value.facts,
            currentDecision: decision,
            consistency: 'observed_only_non_atomic',
          });
        return;
      }
      const r = readWriteFields(req.body, [
        'version',
        'preparationId',
        ...(action === 'apply' ? ['confirmation'] : []),
      ]);
      if (
        !r ||
        r.version !== VERSION ||
        typeof r.preparationId !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(r.preparationId) ||
        !['apply', 'reconcile'].includes(action ?? '')
      ) {
        fail(400, 'invalid_request');
        return;
      }
      const c = contexts.get(r.preparationId);
      if (!c) {
        fail(410, 'preparation_unavailable', 'unknown');
        return;
      }
      if (
        c.owner !== owner ||
        c.session !== session ||
        c.command.dataset !== req.params.dataset ||
        c.command.operationId !== req.params.operationId
      ) {
        fail(403, 'review_mismatch');
        return;
      }
      if (action === 'reconcile') {
        if (!c.attempted) {
          fail(409, 'not_attempted');
          return;
        }
        const raw = await readStoredDecision(
          db,
          owner,
          c.command.dataset,
          c.command.operationId,
        );
        const stored = classificationFromBson(raw),
          hash = fingerprintClassificationCommand(
            owner,
            c.command,
            c.review,
            1,
          );
        const matched =
          stored.ok &&
          hash.ok &&
          stored.value.lastMutation.requestId === c.command.requestId &&
          stored.value.lastMutation.commandFingerprint ===
            hash.value.commandFingerprint &&
          stored.value.decisionRevision ===
            (c.command.expectedRevision ?? 0) + 1 &&
          stored.value.state === c.command.state &&
          isDeepStrictEqual(stored.value.assignment, c.command.assignment) &&
          stored.value.sourceFingerprint === c.review.sourceFingerprint;
        res.json({
          version: VERSION,
          outcome: matched ? 'latest_applied' : 'indeterminate',
          consistency: 'observed_only_non_atomic',
        });
        return;
      }
      if (r.confirmation !== 'confirm_prepared_intent') {
        fail(400, 'confirmation_required');
        return;
      }
      if (performance.now() >= c.deadline) {
        fail(
          410,
          'preparation_expired',
          c.attempted ? 'unknown' : 'not_applied',
        );
        return;
      }
      if (c.attempted) {
        if (c.result) {
          res
            .status(
              c.result.ok
                ? 200
                : c.result.persistence === 'unknown'
                  ? 503
                  : 409,
            )
            .json({ version: VERSION, result: c.result });
          return;
        }
        fail(409, 'write_pending', 'unknown');
        return;
      }
      // Synchronous single admission: retries only return a receipt or reconcile.
      c.attempted = true;
      attempting = true;
      c.result = await writer.execute(c, c.command, c);
      res
        .status(
          c.result.ok
            ? c.result.value.outcome === 'created'
              ? 201
              : 200
            : c.result.persistence === 'unknown'
              ? 503
              : 409,
        )
        .json({ version: VERSION, result: c.result });
    } catch {
      fail(503, 'unavailable', attempting ? 'unknown' : 'not_applied');
    }
  };
};
let handler: RequestHandler | undefined;
/** Lazy default connection binding, no connection/bootstrap side effects. */
export const classificationC: RequestHandler = (req, res, next) => {
  handler ??= createClassificationC(mongoose.connection);
  return handler(req, res, next);
};
