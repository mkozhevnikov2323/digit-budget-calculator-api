// SYNTHETIC ONLY. Maps model shared atomic/durable behavior inside a controlled
// test process; they are NOT a durable store, secret manager or production clock.
const { createHash, randomBytes } = require('node:crypto');
const { runtimePolicyDigest, validateRuntimeConfiguration, validateRuntimeTransition, ISSUANCE_LIMIT } = require('../../dist/domain/classification/runtimeConfiguration');
const { OPERATIONAL_EVENTS } = require('../../dist/services/classificationRuntime/contracts');
const failure = () => Error('Synthetic operational provider unavailable; details suppressed');
function fixtureConfiguration(databaseName = 'synthetic_only', now = Math.floor(Date.now() / 1000)) {
  const material = randomBytes(32);
  return { config: { version: 'classification-runtime-v1', deploymentId: 'isolated-operational-era', revision: 1,
    databaseName, issuingKid: 'synthetic', keys: [{ kid: 'synthetic', state: 'active',
      materialId: createHash('sha256').update(material).digest('hex'), issueFrom: now - 60,
      issueUntil: now + 2591940, verifyUntil: now + 2678340 }] }, materials: new Map([['synthetic', material]]) };
}
function createSyntheticAuthority(configuration, materials) {
  const checked = validateRuntimeConfiguration(configuration); if (!checked.ok) throw failure();
  const state = { config: checked.value, materials, available: true, secretsAvailable: true, clockAvailable: true,
    remoteOffset: 0, localOffset: 0, monotonicOffset: 0, clockHighWater: 0,
    gates: { prepare: true, apply: true, reconcile: true }, maintenance: false, reviewed: true,
    quota: new Map(), reservations: new Map(), leases: new Map(), closedLeases: new Set(), events: [], testBudget: ISSUANCE_LIMIT };
  const current = q => q?.binding?.policyDigest === runtimePolicyDigest(state.config)
    && q.binding.revision === state.config.revision && q.binding.deploymentId === state.config.deploymentId
    && q.binding.databaseName === state.config.databaseName;
  const receipt = (q, version, extra) => ({ version, requestId: q.requestId, policyDigest: q.binding.policyDigest, ...extra });
  const authority = {
    async attest(q) {
      if (!state.available) throw failure(); if (!current(q)) return undefined;
      return receipt(q, 'classification-authority-evidence-v1', { ...state.gates, deployment: {
        mongoMajor: 7, fcvMajor: 7, privilegesReviewed: state.reviewed, ownerLifecycleReviewed: state.reviewed,
        backupsRestoreReviewed: state.reviewed, privateTelemetryReviewed: state.reviewed, unshardedReviewed: state.reviewed,
        ddlExcluded: !state.maintenance, restoreExcluded: !state.maintenance, fleetPolicyCurrent: true } });
    },
    async begin(q) {
      if (!state.available) throw failure();
      const allowed = current(q) && state.gates[q.mode] && !state.maintenance && !state.closedLeases.has(q.requestId);
      const entry = state.leases.get(q.requestId);
      const status = !allowed ? 'denied' : entry ? 'duplicate' : 'admitted';
      if (status === 'admitted') state.leases.set(q.requestId, q);
      return receipt(q, 'classification-lease-v1', { state: status });
    },
    async end(q) {
      if (!state.available) throw failure();
      const entry = state.leases.get(q.requestId);
      if (entry && entry.binding.policyDigest !== q.binding.policyDigest) throw failure();
      state.leases.delete(q.requestId); state.closedLeases.add(q.requestId);
      return receipt(q, 'classification-lease-v1', { state: 'closed' });
    },
    async reserve(q) {
      if (!state.available) throw failure();
      const k = state.config.keys.find(k => k.kid === state.config.issuingKid);
      let ordinal = state.quota.get(q.materialId) ?? 0, status = 'denied';
      const now = Math.floor((Date.now() + state.remoteOffset) / 1000);
      if (state.reservations.has(q.requestId)) status = 'duplicate';
      else if (current(q) && !state.maintenance && state.gates.prepare && k?.state === 'active'
        && k.materialId === q.materialId && q.maximum === ISSUANCE_LIMIT && q.issueUntil === k.issueUntil
        && now >= k.issueFrom && now < k.issueUntil) {
        if (ordinal >= Math.min(ISSUANCE_LIMIT, state.testBudget)) status = 'exhausted';
        else { status = 'reserved'; ordinal++; state.quota.set(q.materialId, ordinal); state.reservations.set(q.requestId, ordinal); }
      }
      return receipt(q, 'classification-reservation-v1', { materialId: q.materialId, ordinal, state: status });
    },
  };
  const providers = () => ({ version: 'classification-providers-v1', assurance: 'synthetic', authority: { ...authority },
    secrets: {
      async load(q) {
        if (!state.secretsAvailable || !current(q)) throw failure();
        return { version: 'classification-secrets-v1', purpose: 'classification-review-aead-v1',
          keys: state.config.keys.filter(k => k.state !== 'revoked').map(k => ({ kid: k.kid, key: state.materials.get(k.kid) })) };
      },
      async check(q) {
        if (!state.secretsAvailable || !current(q)) throw failure();
        return receipt(q, 'classification-key-health-v1', { available: state.config.keys
          .filter(k => k.state !== 'revoked').every(k => state.materials.has(k.kid)) });
      },
    },
    clock: { async sample(q) {
      if (!state.clockAvailable || !current(q)) throw failure();
      const utc = Date.now() + state.remoteOffset;
      if (utc < state.clockHighWater) throw failure(); state.clockHighWater = utc;
      return receipt(q, 'classification-clock-evidence-v1', { utcMilliseconds: utc, uncertaintyMilliseconds: 10 });
    } },
    telemetry: { emit(event) {
      if (Object.keys(event).sort().join(',') !== 'type,version' || event.version !== 'classification-operations-event-v1'
        || !OPERATIONAL_EVENTS.includes(event.type)) throw failure();
      state.events.push({ ...event });
    } },
    localClock: () => ({ wallMilliseconds: Date.now() + state.localOffset, monotonicMilliseconds: performance.now() + state.monotonicOffset }),
  });
  return { state, providers,
    publish(next, incompatibleRestore = false) {
      if (!validateRuntimeTransition(state.config, next, incompatibleRestore, Math.floor((Date.now() + state.remoteOffset) / 1000))) return false;
      state.config = validateRuntimeConfiguration(next).value; return true;
    },
    enterMaintenance() {
      if (Object.values(state.gates).some(Boolean) || state.leases.size) return false;
      state.maintenance = true; return true;
    },
    advance(seconds) { state.remoteOffset += seconds * 1000; state.localOffset += seconds * 1000; state.monotonicOffset += seconds * 1000; },
  };
}
module.exports = { fixtureConfiguration, createSyntheticAuthority };
