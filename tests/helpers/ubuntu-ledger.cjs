// Synthetic INDEPENDENT anchor fixture only. This in-memory CAS is not durable
// external infrastructure; never imported by production or called operationally.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fixtureConfiguration } = require('./operational-runtime.cjs');
const { runtimePolicyDigest } = require('../../dist/domain/classification/runtimeConfiguration');
const { initializeLocalLedger, openLocalLedger } = require('../../dist/services/classificationRuntime/ubuntu/ledger');
const evidence = { mongoMajor: 7, fcvMajor: 7, privilegesReviewed: true, ownerLifecycleReviewed: true,
  backupsRestoreReviewed: true, privateTelemetryReviewed: true, unshardedReviewed: true,
  ddlExcluded: true, restoreExcluded: true, fleetPolicyCurrent: true };
function syntheticAnchor() {
  const state = { checkpoint: null, available: true, failAdvance: false, lostAck: false, approvals: new Set(), materials: new Set() };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const anchor = {
    async read() { if (!state.available) throw Error('Synthetic unavailable'); return state.checkpoint; },
    async advance(q) {
      if (!state.available || state.failAdvance || !same(state.checkpoint, q.expected)) throw Error('Synthetic denied');
      if (q.expected === null) {
        if (!state.approvals.has(q.approvalId) || q.policy.keys.some(k => state.materials.has(k.materialId))) throw Error('Synthetic genesis denied');
        state.approvals.delete(q.approvalId);
      }
      for (const k of q.policy.keys) state.materials.add(k.materialId);
      state.checkpoint = structuredClone(q.next);
      if (state.lostAck) throw Error('Synthetic lost acknowledgment');
      return state.checkpoint;
    },
  };
  return { state, anchor };
}
async function fixture(databaseName) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ubuntu-'));
  fs.chmodSync(directory, 0o700);
  const f = fixtureConfiguration(databaseName), a = syntheticAnchor(), approvalId = randomUUID(); a.state.approvals.add(approvalId);
  const options = { directory, ledgerId: randomUUID(), writerId: randomUUID(), anchor: a.anchor,
    evidence: async () => ({ ...evidence }), utc: async () => Date.now() };
  const binding = { version: 'classification-operational-binding-v1', deploymentId: f.config.deploymentId,
    revision: f.config.revision, databaseName: f.config.databaseName, policyDigest: runtimePolicyDigest(f.config) };
  const request = (extra = {}) => ({ binding: { ...binding }, requestId: randomUUID(), ...extra });
  const reservation = () => request({ materialId: f.config.keys[0].materialId, maximum: 2 ** 20, issueUntil: f.config.keys[0].issueUntil });
  const handles = [];
  const open = async (override = {}) => { const h = await openLocalLedger({ ...options, ...override }); if (h) handles.push(h); return h; };
  const close = h => { h.close(); handles.splice(handles.indexOf(h), 1); };
  return { ...f, ...a, options, approvalId, directory, request, reservation, open, close,
    initialize: () => initializeLocalLedger(options, f.config, approvalId),
    async seedUsage(used) {
      // Test-only independently approved near-exhaustion fixture, never a runtime reset.
      const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(directory, 'authority.sqlite'));
      const s = JSON.parse(db.prepare('SELECT state FROM metadata WHERE id=1').get().state);
      const expected = structuredClone(a.state.checkpoint); s.sequence++; s.nonce = randomUUID();
      db.prepare('UPDATE materials SET used=?').run(used);
      s.commitment = createHash('sha256').update(JSON.stringify(['classification-local-state-v1', options.ledgerId,
        { ...s, commitment: null }, db.prepare('SELECT identity,used FROM materials ORDER BY identity').all(),
        db.prepare('SELECT id,writer,digest,mode FROM admissions WHERE closed=0 ORDER BY id').all()])).digest('hex');
      db.prepare('UPDATE metadata SET state=? WHERE id=1').run(JSON.stringify(s)); db.close();
      await a.anchor.advance({ expected, next: { version: 'classification-local-checkpoint-v1', ledgerId: options.ledgerId,
        sequence: s.sequence, commitment: s.commitment }, policy: s.config, approvalId: null });
    },
    cleanup() { for (const h of handles) { try { h.close(); } catch (error) { if (error.code !== "ERR_INVALID_STATE") throw error; } } fs.rmSync(directory, { recursive: true, force: true }); } };
}
module.exports = { fixture, syntheticAnchor, evidence };
