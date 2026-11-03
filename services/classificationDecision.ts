/** Single explicit HTTP intent; no process-local preparation or receipt store. */
import type { RequestHandler } from 'express';
import mongoose, { type Connection } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import {
  readWriteFields,
  validateManualCommand,
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

import { resultStatus } from './classificationC';
const VERSION = 'classification-decision-v1';
type Intent = { owner: string; command: ManualCommand; review: VerifiedReview };
export const createClassificationDecision = (
  connection: Connection,
): RequestHandler => {
  const admitted = new WeakSet<Intent>();
  // Preserve lazy writer loading: importing the Express app must not initialize its write service.
  const { createClassificationWriteService } = require('./classificationWrite') as typeof import('./classificationWrite');
  const writer = createClassificationWriteService(connection, {
    resolveAuthenticatedOwner(context) {
      const c = context as Intent;
      if (!admitted.has(c)) throw new Error('Invalid context');
      return { owner: c.owner };
    },
    resolveVerifiedReview(context, evidence, command) {
      const c = context as Intent;
      if (
        !admitted.has(c) ||
        evidence !== c ||
        !isDeepStrictEqual(command, c.command)
      )
        throw new Error('Invalid intent');
      return c.review;
    },
  });
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Authorization');
    let attempted = false;
    const fail = (status: number, code: string, persistence = 'not_applied') =>
      res
        .status(status)
        .json({ version: VERSION, error: { code }, persistence });
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
      const r = readWriteFields(req.body, [
        'version',
        'requestId',
        'expectedRevision',
        'state',
        'assignment',
        'expectedFacts',
      ]);
      const facts = readWriteFields(r?.expectedFacts, [
        'amount',
        'date',
        'dateEpochMs',
        'comment',
        ...(req.params.dataset === 'expenses'
          ? ['category', 'title', 'recipient']
          : ['source']),
      ]);
      const parsed = validateManualCommand({
        kind: 'manual_classification',
        dataset: req.params.dataset,
        operationId: req.params.operationId,
        requestId: r?.requestId,
        expectedRevision: r?.expectedRevision,
        state: r?.state,
        ...(r && Object.hasOwn(r, 'assignment')
          ? { assignment: r.assignment }
          : {}),
      });
      if (
        !r ||
        r.version !== VERSION ||
        !facts ||
        !parsed.ok ||
        !['approved', 'explicit_unclassified'].includes(parsed.value.state) ||
        Object.keys(req.query).length
      ) {
        fail(400, 'invalid_request');
        return;
      }
      if (!(await classificationReadiness(db))) {
        fail(503, 'unavailable');
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
        fail(source.status === 'missing' ? 404 : 503, 'source_unavailable');
        return;
      }
      // Compare exact JSON facts, including binary64 roundtrip and missing/null comments.
      if (!isDeepStrictEqual(r.expectedFacts, source.value.facts)) {
        fail(409, 'source_changed');
        return;
      }
      const context: Intent = {
        owner,
        command,
        review: {
          kind: 'verified_manual_review',
          owner,
          dataset: command.dataset,
          operationId: command.operationId,
          ...source.value.fingerprint,
        },
      };
      admitted.add(context);
      attempted = true;
      const result = await writer.execute(context, command, context);
      admitted.delete(context);
      if (!result.ok) {
        res.status(resultStatus(result)).json({ version: VERSION, ...result });
        return;
      }
      // Read back on the server, never require a second client HTTP request.
      const current = await readSourceObservation(
        db,
        owner,
        command.dataset,
        command.operationId,
      );
      const raw = await readStoredDecision(
        db,
        owner,
        command.dataset,
        command.operationId,
      );
      const stored = classificationFromBson(raw);
      if (
        current.status !== 'ok' ||
        !stored.ok ||
        stored.value.lastMutation.requestId !== command.requestId ||
        stored.value.decisionRevision !== result.value.decisionRevision ||
        stored.value.state !== command.state ||
        !isDeepStrictEqual(stored.value.assignment, command.assignment) ||
        !(await classificationReadiness(db))
      ) {
        fail(503, 'outcome_indeterminate', 'unknown');
        return;
      }
      const decision = effectiveClassification(
        raw,
        owner,
        command.dataset,
        command.operationId,
        current.value.fingerprint,
      );
      if (decision.status === 'blocked') {
        fail(503, 'outcome_indeterminate', 'unknown');
        return;
      }
      res
        .status(resultStatus(result, true))
        .json({ version: VERSION, outcome: result.value.outcome, decision });
    } catch {
      fail(503, 'unavailable', attempted ? 'unknown' : 'not_applied');
    }
  };
};
let handler: RequestHandler | undefined;
export const classificationDecision: RequestHandler = (req, res, next) => {
  handler ??= createClassificationDecision(mongoose.connection);
  return handler(req, res, next);
};
