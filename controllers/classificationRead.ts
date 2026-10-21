import type { RequestHandler } from 'express';
import mongoose = require('mongoose');
import { validateOperationIdentity } from '../domain/classification';
import { compareSourceFingerprints } from '../domain/classification/sourceFingerprint';
import { classificationFromBson } from '../persistence/classification';
import { CLASSIFICATION_MANIFEST } from '../persistence/classificationManifest';
import { classificationReadiness } from '../persistence/classificationReadiness';
import { sourceFingerprintFromBson } from '../persistence/classificationSource';

const getClassification: RequestHandler = async (req, res) => {
  // Even authenticated GETs must never be retained by shared or browser caches.
  res.set('Cache-Control', 'no-store');
  const unavailable = () => res.status(503).json({ message: 'Classification reads unavailable' });
  try {
    const principal = req.user;
    const d = principal && typeof principal === 'object' && !Array.isArray(principal)
      ? Object.getOwnPropertyDescriptor(principal, '_id') : undefined;
    const owner: unknown = d && Object.hasOwn(d, 'value') ? d.value : undefined;
    const identity = validateOperationIdentity({ owner, dataset: req.params.dataset, operationId: req.params.operationId });
    // Separate principal errors from client parameter errors without accepting fallbacks.
    if (!validateOperationIdentity({ owner, dataset: 'expenses', operationId: '000000000000000000000000' }).ok) {
      res.status(401).json({ message: 'Необходима авторизация.' }); return;
    }
    if (!identity.ok || Object.keys(req.params).some(key => !['dataset', 'operationId'].includes(key))
      || Object.keys(req.query).length || (req.body !== undefined
        && (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) {
      res.status(400).json({ message: 'Invalid classification request' }); return;
    }
    if (process.env.CLASSIFICATION_READ_ENABLED !== '1') { unavailable(); return; }
    const db = mongoose.connection.readyState === 1 ? mongoose.connection.db : undefined;
    if (!db) { unavailable(); return; }
    const dataset = identity.value.dataset;
    const operationId = identity.value.operationId.toLowerCase();
    const ownerId = identity.value.owner.toLowerCase();
    const filter = { _id: new mongoose.Types.ObjectId(operationId), owner: new mongoose.Types.ObjectId(ownerId) };
    try {
      const projection = dataset === 'expenses'
        ? { _id: 1, owner: 1, amount: 1, date: 1, category: 1, title: 1, recipient: 1, comment: 1 }
        : { _id: 1, owner: 1, amount: 1, date: 1, source: 1, comment: 1 };
      const source: unknown = await db.collection(dataset).findOne(filter,
        { projection, maxTimeMS: 3000, promoteLongs: false });
      if (source === null) { res.status(404).json({ message: 'Operation not found' }); return; }
      const current = sourceFingerprintFromBson(source, { owner: ownerId, dataset, operationId });
      if (!current.ok) { unavailable(); return; }
      if (!await classificationReadiness(db)) { unavailable(); return; }
      const stored: unknown = await db.collection(CLASSIFICATION_MANIFEST.collectionName).findOne({
        owner: filter.owner, dataset, operationId: filter._id,
      }, { maxTimeMS: 3000, promoteLongs: false });
      // Also catch infrastructure removed/altered during the lookup. Still not atomic.
      if (!await classificationReadiness(db)) { unavailable(); return; }
      const base = { version: 'classification-read-v1', dataset, operationId,
        consistency: 'observed_only_non_atomic' };
      if (stored === null) {
        res.json({ ...base, status: 'unreviewed', storedState: null, decisionRevision: null, confirmed: null }); return;
      }
      const checked = classificationFromBson(stored);
      if (!checked.ok || checked.value.owner !== ownerId || checked.value.dataset !== dataset
        || checked.value.operationId !== operationId) {
        // Conservative v1: no partial metadata from a blocked record.
        res.json({ ...base, status: 'blocked', storedState: null, decisionRevision: null, confirmed: null }); return;
      }
      const record = checked.value;
      const compared = compareSourceFingerprints(current.value, {
        sourceFingerprint: record.sourceFingerprint, sourceFingerprintVersion: record.sourceFingerprintVersion,
      });
      const status = !compared.ok ? 'blocked' : !compared.value.matches ? 'stale' : record.state;
      res.json({ ...base, status, storedState: record.state, decisionRevision: record.decisionRevision,
        confirmed: status === 'approved' ? record.assignment : null });
    } catch { unavailable(); } // Never forward private driver messages/metadata to legacy handlers.
  } catch { res.status(500).json({ message: 'Classification read failed' }); }
};

export = getClassification;
