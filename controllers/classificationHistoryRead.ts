import type { RequestHandler } from 'express';
import mongoose = require('mongoose');
import { validateHistoryReadRequest } from '../domain/classification/historyReadContract';
import { classificationReadiness } from '../persistence/classificationReadiness';
import { CLASSIFICATION_MANIFEST as manifest } from '../persistence/classificationManifest';
import { effectiveClassification, presentSource, sourceProjection } from '../services/classificationObservation';
import { authenticatedClassificationOwner } from '../services/classificationPrincipal';
import { admitClassificationRead } from '../services/classificationAdmission';

const historyRead: RequestHandler = async (req, res) => {
  let release: (() => void) | null = null;
  const unavailable = () => { res.status(503).json({ code: 'history_unavailable' }); };
  try {
    if (process.env.CLASSIFICATION_HISTORY_READ_ENABLED !== '1') { unavailable(); return; }
    const request = validateHistoryReadRequest(req.body);
    if (!request.ok || Object.keys(req.query).length) { res.status(400).json({ code: 'invalid_history_read_request' }); return; }
    const db = mongoose.connection.readyState === 1 ? mongoose.connection.db : undefined;
    if (!db) { unavailable(); return; }
    const owner = await authenticatedClassificationOwner(req, db);
    if (!owner) { res.status(401).json({ code: 'ineligible_account' }); return; }
    release = admitClassificationRead(owner);
    if (!release) { res.status(429).json({ code: 'read_rate_limited' }); return; }
    const r = request.value, ownerId = new mongoose.Types.ObjectId(owner);
    const sources = new Map<string, ReturnType<typeof presentSource>>();
    // Two bounded source queries, never an annual N+1. No hydrating/casting facts.
    for (const dataset of ['expenses', 'incomes'] as const) {
      const ids = r.operations.filter(op => op.dataset === dataset).map(op => new mongoose.Types.ObjectId(op.operationId));
      if (!ids.length) continue;
      const rows = await db.collection(dataset).find({ owner: ownerId, _id: { $in: ids } },
        { projection: sourceProjection(dataset), maxTimeMS: 3000, promoteLongs: false }).limit(ids.length + 1).toArray();
      for (const raw of rows) {
        const id: string = raw._id.toHexString();
        const identity = r.operations.find(op => op.dataset === dataset && op.operationId === id);
        const observation = identity ? presentSource(raw, { owner, dataset, operationId: id }) : null;
        if (!observation || sources.has(`${dataset}/${id}`)) { unavailable(); return; }
        if (observation.facts.dateEpochMs < r.startInclusive || observation.facts.dateEpochMs >= r.endExclusive) {
          res.status(409).json({ code: 'history_changed' }); return;
        }
        sources.set(`${dataset}/${id}`, observation);
      }
    }
    if (sources.size !== r.operations.length) { res.status(404).json({ code: 'source_not_found' }); return; }
    if (!await classificationReadiness(db)) { unavailable(); return; }
    const stored = await db.collection(manifest.collectionName).find({ owner: ownerId, $or: r.operations.map(op => ({
      dataset: op.dataset, operationId: new mongoose.Types.ObjectId(op.operationId),
    })) }, { maxTimeMS: 3000, promoteLongs: false }).limit(r.operations.length + 1).toArray();
    const decisions = new Map<string, unknown>();
    for (const raw of stored) {
      const key = `${raw.dataset}/${raw.operationId.toHexString()}`;
      if (decisions.has(key) || !sources.has(key)) { unavailable(); return; }
      decisions.set(key, raw);
    }
    if (!await classificationReadiness(db)) { unavailable(); return; }
    const operations = r.operations.map(op => {
      const key = `${op.dataset}/${op.operationId}`, observation = sources.get(key)!;
      return { ...op, facts: observation!.facts,
        classification: effectiveClassification(decisions.get(key) ?? null, owner, op.dataset, op.operationId, observation!.fingerprint) };
    });
    const response = { version: 'classification-history-read-v1', window: { startInclusive: r.startInclusive, endExclusive: r.endExclusive },
      coverage: 'requested_identities_only', consistency: 'observed_only_non_atomic', returnedCount: operations.length, operations };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 3500000) { unavailable(); return; }
    res.json(response);
  } catch { unavailable(); } finally { release?.(); }
};
export = historyRead;
