// TEST ONLY: real SQLite + protected generated credential files + controlled
// chrony evidence. Independent anchors are in-memory fixtures, not production.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { fixture, evidence } = require('./ubuntu-ledger.cjs');
const { createSystemdCredentialProvider } = require('../../dist/services/classificationRuntime/ubuntu/credentials');
const { createClockHealthAdapter } = require('../../dist/services/classificationRuntime/ubuntu/clock');
const { runtimePolicyDigest } = require('../../dist/domain/classification/runtimeConfiguration');
async function createLocalRuntimeFixture(databaseName) {
  const f = await fixture(databaseName), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-runtime-credentials-'));
  const state = { available: true, secretsAvailable: true, clockAvailable: true, reviewed: true,
    offset: 0, highWater: 0, events: [], bootId: randomUUID() };
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, 'classification-aead.json'), JSON.stringify({ version: 'classification-credential-manifest-v1',
    purpose: 'classification-review-aead-v1', kids: ['synthetic'] }), { mode: 0o400 });
  fs.writeFileSync(path.join(directory, 'classification-key-synthetic'), f.materials.get('synthetic'), { mode: 0o400 });
  const measure = () => ({ bootId: state.bootId, wallMilliseconds: Date.now() + state.offset,
    monotonicMilliseconds: performance.now() + state.offset, bootMilliseconds: performance.now() + 100000 + state.offset });
  const clock = createClockHealthAdapter(f.config, {
    measure,
    async readTracking() {
      if (!state.clockAvailable) throw Error('Synthetic clock unavailable');
      return ['CB007101', '203.0.113.1', '2', String((Date.now() + state.offset) / 1000 - 1), '0.001', '0.001', '0.001', '1', '0', '1', '0.01', '0.01', '16', 'Normal'].join(',') + '\n';
    },
    checkpoint: { async accept(q) {
      if (!state.clockAvailable || q.wallMilliseconds < state.highWater) throw Error('Synthetic checkpoint unavailable');
      state.highWater = q.wallMilliseconds;
      return { version: 'classification-time-checkpoint-v1', requestId: q.requestId, policyDigest: q.binding.policyDigest, accepted: true };
    } },
  });
  const request = () => ({ binding: { version: 'classification-operational-binding-v1', deploymentId: f.config.deploymentId,
    revision: f.config.revision, policyDigest: runtimePolicyDigest(f.config), databaseName }, requestId: randomUUID() });
  f.options.utc = async signal => (await clock.sample(request(), signal)).utcMilliseconds;
  f.options.evidence = async () => { if (!state.reviewed) throw Error('Synthetic evidence unavailable'); return { ...evidence }; };
  const read = f.anchor.read, advance = f.anchor.advance;
  f.anchor.read = q => { if (!state.available) throw Error('Synthetic anchor unavailable'); return read(q); };
  f.anchor.advance = q => { if (!state.available) throw Error('Synthetic anchor unavailable'); return advance(q); };
  let ledger;
  try {
    if (!await f.initialize()) throw Error('Synthetic genesis failed');
    ledger = await f.open();
    if (!ledger || !await ledger.claimWriter() || !await ledger.setGates({ prepare: true, apply: true, reconcile: true })) throw Error('Synthetic claim failed');
    const credentials = createSystemdCredentialProvider(f.config, directory);
    return { f, state, ledger, config: f.config, credentialDirectory: directory,
      providers: () => ({ version: 'classification-providers-v1', assurance: 'synthetic', authority: ledger.authority,
        secrets: {
          async load(q, signal) { if (!state.secretsAvailable) throw Error('Synthetic custody unavailable'); return credentials.load(q, signal); },
          async check(q, signal) { if (!state.secretsAvailable) throw Error('Synthetic custody unavailable'); return credentials.check(q, signal); },
        }, clock, telemetry: { emit(event) { state.events.push({ ...event }); } },
        localClock: () => ({ wallMilliseconds: Date.now() + state.offset, monotonicMilliseconds: performance.now() + state.offset }) }),
      advance(seconds) { state.offset += seconds * 1000; },
      cleanup() {
        // Test-owned state only. Unknown/orphan leases are never released by this
        // cleanup; deleting the disposable fixture is not maintenance authorization.
        f.cleanup(); fs.rmSync(directory, { recursive: true, force: true });
        for (const key of f.materials.values()) key.fill(0);
      },
    };
  } catch { f.cleanup(); fs.rmSync(directory, { recursive: true, force: true }); throw Error('Local test fixture unavailable'); }
}
module.exports = { createLocalRuntimeFixture };
