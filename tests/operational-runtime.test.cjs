const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateRuntimeConfiguration, runtimePolicyDigest, ISSUANCE_LIMIT } = require('../dist/domain/classification/runtimeConfiguration');
const { createOperationalPorts, validateProviders } = require('../dist/services/classificationRuntime/ports');
const { fixtureConfiguration, createSyntheticAuthority } = require('./helpers/operational-runtime.cjs');
const harness = () => {
  const f = fixtureConfiguration(), shared = createSyntheticAuthority(f.config, f.materials), config = validateRuntimeConfiguration(f.config).value;
  const create = (providers = shared.providers(), inspect = async () => true) => createOperationalPorts(config, providers, inspect);
  return { f, shared, config, create };
};
const sum = shared => [...shared.state.quota.values()].reduce((a, b) => a + b, 0);
describe('P11 shared operational contracts — synthetic authority, NOT production durability', { concurrency: false }, () => {
  it('rejects missing providers, unsupported assurance and accessors without installation', () => {
    const h = harness(); assert.equal(!!validateProviders(h.shared.providers(), 'isolated-test'), true);
    assert.equal(validateProviders(h.shared.providers(), 'operational') === undefined, true);
    for (const deps of [undefined, {}, { ...h.shared.providers(), version: 'v2' },
      { ...h.shared.providers(), authority: { attest: async () => true } },
      Object.defineProperty(h.shared.providers(), 'secrets', { get() { throw Error('Must not execute'); } })])
      assert.equal(validateProviders(deps, 'isolated-test') === undefined, true);
  });
  it('shares one atomic budget across two independent runtime objects and simulated restart', async () => {
    const h = harness(); h.shared.state.testBudget = 7;
    const a = h.create(), b = h.create();
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).operations.reserveIssuance()));
    assert.equal(attempts.filter(Boolean).length, 7); assert.equal(sum(h.shared), 7);
    a.close(); b.close(); const restarted = h.create();
    assert.equal(await restarted.operations.reserveIssuance(), false); assert.equal(sum(h.shared), 7);
  });
  it('enforces the fixed 2^20 boundary without executing an expensive exhaustion loop', async () => {
    const h = harness(), p = h.create(); h.shared.state.quota.set(h.config.keys[0].materialId, ISSUANCE_LIMIT - 1);
    assert.equal(await p.operations.reserveIssuance(), true); assert.equal(await p.operations.reserveIssuance(), false);
    assert.equal(sum(h.shared), ISSUANCE_LIMIT);
  });
  it('rejects duplicate reservation attempts instead of granting another encryption', async () => {
    const h = harness(), providers = h.shared.providers(); let prior;
    const reserve = providers.authority.reserve;
    providers.authority.reserve = q => {
      prior ??= q;
      // Simulate a provider mistakenly returning the old request's consumed receipt.
      return reserve(prior).then(r => ({ ...r, requestId: q.requestId }));
    };
    const p = h.create(providers); assert.equal(await p.operations.reserveIssuance(), true);
    assert.equal(await p.operations.reserveIssuance(), false); assert.equal(sum(h.shared), 1);
  });
  it('consumes abandoned reservations and never refunds local close/restart', async () => {
    const h = harness(); h.shared.state.testBudget = 1; const p = h.create();
    assert.equal(await p.operations.reserveIssuance(), true); p.close();
    assert.equal(await h.create().operations.reserveIssuance(), false); assert.equal(sum(h.shared), 1);
  });
  for (const dependency of ['available', 'secretsAvailable', 'clockAvailable', 'reviewed'])
    it('fails closed when dependency is unavailable: ' + dependency, async () => {
      const h = harness(), p = h.create(); assert.equal(await p.operations.ready('prepare'), true);
      h.shared.state[dependency] = false;
      for (const mode of ['prepare', 'apply', 'reconcile']) assert.equal(await p.operations.ready(mode), false);
      assert.equal(await p.operations.reserveIssuance(), false); assert.equal(sum(h.shared), 0);
    });
  it('fails closed for partial rollout / old policy after restart without resetting budget', async () => {
    const h = harness(), old = h.create(); await old.operations.reserveIssuance();
    const next = { ...h.f.config, revision: 2 };
    assert.equal(h.shared.publish(next), true);
    assert.equal(await old.operations.ready('prepare'), false);
    assert.equal(await h.create().operations.reserveIssuance(), false);
    const current = createOperationalPorts(validateRuntimeConfiguration(next).value, h.shared.providers(), async () => true);
    assert.equal(await current.operations.reserveIssuance(), true); assert.equal(sum(h.shared), 2);
    assert.equal(h.shared.publish(h.f.config), false);
  });
  it('revokes all old instances and refuses restored key activation', async () => {
    const h = harness(), p = h.create(); const revoked = { ...h.f.config, revision: 2, issuingKid: null,
      keys: h.f.config.keys.map(k => ({ ...k, state: 'revoked' })) };
    assert.equal(h.shared.publish(revoked), true);
    assert.equal(await p.operations.ready('prepare'), false); assert.equal(await p.operations.ready('apply'), false);
    assert.equal(h.shared.publish({ ...h.f.config, revision: 3 }), false);
  });
  it('rejects clock rollback and excessive forward/skew jumps while retaining shared high water', async () => {
    for (const offset of [-5000, 5000]) {
      const h = harness(), p = h.create(); await p.operations.ready('prepare');
      h.shared.state.remoteOffset += offset; h.shared.state.localOffset += offset;
      assert.equal(await p.operations.ready('prepare'), false);
      assert.equal(await p.operations.reserveIssuance(), false);
    }
  });
  it('bounds provider timeout and consumes a late successful reservation without issuing', async () => {
    const h = harness(), providers = h.shared.providers(), original = providers.authority.reserve;
    let finish;
    providers.authority.reserve = q => new Promise(resolve => { finish = async () => resolve(await original(q)); });
    const p = h.create(providers), result = p.operations.reserveIssuance();
    assert.equal(await result, false); await finish();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(sum(h.shared), 1);
  });
  it('retains an unknown timed-out admission so local drain cannot claim success', async () => {
    const h = harness(), providers = h.shared.providers(), original = providers.authority.begin; let finish;
    providers.authority.begin = q => new Promise(resolve => { finish = async () => resolve(await original(q)); });
    const p = h.create(providers); assert.equal(await p.operations.acquireAdmission('apply'), null);
    await finish(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.shared.state.leases.size, 1); assert.equal(await p.drain(0), false);
    h.shared.state.gates = { prepare: false, apply: false, reconcile: false };
    assert.equal(h.shared.enterMaintenance(), false);
  });
  it('drains active requests, blocks new admissions, and preserves read-only recovery', async () => {
    const h = harness(), p = h.create(), release = await p.operations.acquireAdmission('apply');
    assert.equal(typeof release, 'function'); const result = p.drain(1000);
    assert.equal(await p.operations.acquireAdmission('prepare'), null);
    assert.equal(await p.operations.acquireAdmission('apply'), null);
    assert.equal(await p.operations.ready('reconcile'), true);
    await release(); assert.equal(await result, true); assert.equal(h.shared.state.leases.size, 0);
  });
  it('two instances must BOTH drain before synthetic DDL/restore exclusion can change', async () => {
    const h = harness(), a = h.create(), b = h.create();
    const ra = await a.operations.acquireAdmission('apply'), rb = await b.operations.acquireAdmission('apply');
    h.shared.state.gates = { prepare: false, apply: false, reconcile: false };
    assert.equal(h.shared.enterMaintenance(), false); await ra(); assert.equal(await a.drain(0), true);
    assert.equal(h.shared.enterMaintenance(), false); await rb(); assert.equal(await b.drain(0), true);
    assert.equal(h.shared.enterMaintenance(), true); assert.equal(await a.operations.ready('apply'), false);
  });
  it('release failure preserves unresolved lease and denies drain/new issuance', async () => {
    const h = harness(), p = h.create(), release = await p.operations.acquireAdmission('apply');
    h.shared.state.available = false; await release();
    assert.equal(await p.drain(0), false); assert.equal(p.localState().active, 1);
    assert.equal(await p.operations.reserveIssuance(), false);
  });
  it('requires complete current evidence, healthy exact preflight and safe bounded telemetry', async () => {
    const h = harness(), p = h.create(h.shared.providers(), async () => false);
    assert.equal(await p.operations.ready('apply'), false);
    for (const event of h.shared.state.events) {
      assert.equal(Object.keys(event).sort().join(','), 'type,version');
      assert.equal(event.version, 'classification-operations-event-v1');
    }
    assert.equal(JSON.stringify(h.shared.state.events).includes(h.config.databaseName), false);
    assert.equal(JSON.stringify(h.shared.state.events).includes(h.config.keys[0].materialId), false);
    const providers = h.shared.providers(); providers.telemetry.emit = () => { throw Error('Fictional private exception'); };
    assert.equal(await h.create(providers).operations.ready('prepare'), false);
  });
});

describe('P11 physical process restart with SYNTHETIC parent-held shared authority', () => {
  it('preserves consumed budget after the issuing child process exits and restarts', { timeout: 15000 }, async () => {
    const { fork } = require('node:child_process'), { once } = require('node:events');
    const path = require('node:path'), h = harness(); h.shared.state.testBudget = 2;
    const runChild = async () => {
      const provider = h.shared.providers();
      const child = fork(path.join(__dirname, 'helpers/runtime-issuer-child.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const exit = once(child, 'exit');
      child.on('message', async m => {
        if (m.type !== 'call') return;
        try { const value = await provider[m.service][m.method](m.request);
          if (child.connected) child.send({ type: 'provider-reply', id: m.id, ok: true, value });
        } catch { if (child.connected) child.send({ type: 'provider-reply', id: m.id, ok: false }); }
      });
      const message = type => new Promise(resolve => {
        const listener = m => { if (m.type === type) { child.off('message', listener); resolve(m); } };
        child.on('message', listener);
      });
      try {
        const ready = message('ready'); child.send({ type: 'start', config: h.f.config }); await ready;
        const result = message('result'); child.send({ type: 'reserve' }); return (await result).allowed;
      } finally {
        if (child.connected) child.send({ type: 'close' });
        const [code, signal] = await exit; assert.equal(code, 0); assert.equal(signal, null);
      }
    };
    assert.equal(await runChild(), true); assert.equal(await runChild(), true); assert.equal(await runChild(), false);
    assert.equal(sum(h.shared), 2); // Parent memory is still NOT real durable infrastructure.
  });
});

describe('P11 retirement cutoff and admission/drain race guards', () => {
  it('requires trusted retirement time and closes an old issuer window at rotation', () => {
    const h = harness(), { validateRuntimeTransition } = require('../dist/domain/classification/runtimeConfiguration');
    const now = Math.floor(Date.now() / 1000), next = { ...h.f.config, revision: 2, issuingKid: null,
      keys: h.f.config.keys.map(k => ({ ...k, state: 'verify_only' })) };
    assert.equal(validateRuntimeTransition(h.f.config, next, false, now), false);
    next.keys[0].issueUntil = now + 1; next.keys[0].verifyUntil = now + 86401;
    assert.equal(validateRuntimeTransition(h.f.config, next), false);
    assert.equal(validateRuntimeTransition(h.f.config, next, false, now), true);
  });
  it('tracks pending readiness before admission so shutdown cannot miss an awaited request', async () => {
    const h = harness(), providers = h.shared.providers(), original = providers.authority.attest;
    let release; providers.authority.attest = q => new Promise(resolve => { release = async () => resolve(await original(q)); });
    const p = h.create(providers), pending = p.operations.acquireAdmission('apply');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.localState().pending, 1); assert.equal(await p.drain(0), false);
    await release(); assert.equal(await pending, null); assert.equal(await p.drain(0), true);
    assert.equal(h.shared.state.leases.size, 0);
  });
});

describe('P11 telemetry serialization boundary', () => {
  it('drops arbitrary event values without coercion, secrets or unbounded labels', () => {
    const h = harness(), p = h.create();
    for (const event of ['fictional-private-marker', { toString() { throw Error('Must not coerce'); } }, null]) p.emit(event);
    assert.equal(h.shared.state.events.length, 0); assert.equal(p.localState().unavailable, true);
  });
});

describe('P11 partial readiness never authorizes new issuance', () => {
  it('requires apply and recovery readiness for prepare, while recovery can remain independent', async () => {
    for (const gate of ['apply', 'reconcile']) {
      const h = harness(), p = h.create(); h.shared.state.gates[gate] = false;
      assert.equal(await p.operations.ready('prepare'), false); assert.equal(await p.operations.reserveIssuance(), false);
    }
    const h = harness(), p = h.create(); p.disableApply();
    assert.equal(await p.operations.reserveIssuance(), false); assert.equal(await p.operations.ready('reconcile'), true);
  });
});
