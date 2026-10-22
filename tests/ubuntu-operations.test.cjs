const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalRuntimeFixture } = require('./helpers/ubuntu-runtime.cjs');
const { createOperationalPorts } = require('../dist/services/classificationRuntime/ports');
const { validateRuntimeConfiguration } = require('../dist/domain/classification/runtimeConfiguration');
const { openUbuntuProviders, shutdownUbuntuRuntime } = require('../dist/services/classificationRuntime/ubuntu/providers');
const { initializeLocalLedger } = require('../dist/services/classificationRuntime/ubuntu/ledger');
const { fixture } = require('./helpers/ubuntu-ledger.cjs');
const { DatabaseSync } = require('node:sqlite');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const signal = () => new AbortController().signal;
const setup = async fn => { const local = await createLocalRuntimeFixture('synthetic_only');
  try { await fn(local); } finally { local.cleanup(); } };
describe('P11.1 concrete local provider shutdown and failure boundaries', { concurrency: false }, () => {
  it('requires explicit full composition and never creates missing state or enables flags', async () => {
    assert.equal(await openUbuntuProviders({}, {}), undefined);
    const f = await fixture(); try {
      assert.equal(await openUbuntuProviders(f.config, { directory: f.directory }), undefined);
      assert.equal(fs.existsSync(path.join(f.directory, 'authority.sqlite')), false);
    } finally { f.cleanup(); }
  });
  it('rejects malformed internal bindings without invoking accessors in denial receipts', async () => setup(async local => {
    let touched = false;
    for (const [method, q] of [['begin', local.f.request({ mode: 'apply' })], ['reserve', local.f.reservation()]]) {
      Object.defineProperty(q.binding, 'policyDigest', { enumerable: true, get() { touched = true; throw Error('Must not execute'); } });
      await assert.rejects(local.ledger.authority[method](q, signal()), { message: 'Local authority unavailable' });
    }
    assert.equal(touched, false); assert.equal((await local.ledger.status()).active, 0);
  }));
  it('clean shutdown closes durable gates, drains, enters maintenance and releases writer', async () => setup(async local => {
    const ports = createOperationalPorts(validateRuntimeConfiguration(local.config).value, local.providers(), async () => true);
    const release = await ports.operations.acquireAdmission('apply'); assert.equal(typeof release, 'function');
    const runtime = { ...ports, shutdown: async timeout => { ports.disableReconciliation(); return ports.drain(timeout); } };
    assert.equal(await shutdownUbuntuRuntime(runtime, local.ledger, 0), false);
    assert.equal((await local.ledger.status()).active, 1); await release();
    assert.equal(await shutdownUbuntuRuntime(runtime, local.ledger, 1000), true); ports.close();
    // Fixture also tracks the already closed handle; remove it before cleanup.
    const reopened = await local.f.open(); assert.equal((await reopened.status()).writerClaimed, false);
  }));
  it('preserves an unknown timed-out admission in real SQLite and cannot claim drain', async () => setup(async local => {
    const providers = local.providers(), begin = providers.authority.begin; let release;
    // Authority commits the admission, but its acknowledgment is lost until later.
    providers.authority = { ...providers.authority, async begin(q, abort) {
      const result = await begin(q, abort); return new Promise(resolve => { release = () => resolve(result); });
    } };
    const ports = createOperationalPorts(validateRuntimeConfiguration(local.config).value, providers, async () => true);
    assert.equal(await ports.operations.acquireAdmission('apply'), null); release();
    assert.equal((await local.ledger.status()).active, 1); assert.equal(await ports.drain(0), false);
    await local.ledger.setGates({ prepare: false, apply: false, reconcile: false });
    assert.equal(await local.ledger.enterMaintenance(), false); ports.close();
  }));
  it('keeps unreleased lease blocking shutdown when release storage fails', async () => setup(async local => {
    const ports = createOperationalPorts(validateRuntimeConfiguration(local.config).value, local.providers(), async () => true);
    const release = await ports.operations.acquireAdmission('reconcile'); assert.equal(typeof release, 'function');
    local.f.state.failAdvance = true; await release();
    assert.equal(await ports.drain(0), false); assert.equal(ports.localState().unavailable, true); ports.close();
  }));
  it('fails closed on bounded independent-anchor timeout without new issuance', async () => setup(async local => {
    local.f.anchor.read = () => new Promise(() => {});
    const providers = local.providers(), original = providers.authority.attest; let completed;
    providers.authority = { ...providers.authority, attest(q, signal) { completed = original(q, signal); return completed; } };
    const ports = createOperationalPorts(validateRuntimeConfiguration(local.config).value, providers, async () => true);
    assert.equal(await ports.operations.reserveIssuance(), false); await completed.catch(() => {}); ports.close();
  }));
  it('does not treat a clean local drain as global permission when authority is unavailable', async () => setup(async local => {
    const ports = createOperationalPorts(validateRuntimeConfiguration(local.config).value, local.providers(), async () => true);
    local.state.available = false;
    const runtime = { ...ports, shutdown: async timeout => ports.drain(timeout) };
    assert.equal(await shutdownUbuntuRuntime(runtime, local.ledger, 0), false); ports.close();
  }));
  it('detects bounded SQLITE_FULL-like write failure, rolls back usage and logs no raw error', async () => setup(async local => {
    const original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = Reflect.apply(original, this, [sql]);
      if (sql === 'INSERT INTO requests VALUES(?,?,?)') return { run() { const error = Error('Synthetic private IO metadata'); error.code = 'SQLITE_FULL'; throw error; } };
      return statement;
    };
    try { await assert.rejects(local.ledger.authority.reserve(local.f.reservation(), signal()), { message: 'Local authority unavailable' }); }
    finally { DatabaseSync.prototype.prepare = original; }
    const db = new DatabaseSync(path.join(local.f.directory, 'authority.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT used FROM materials').get().used, 0); db.close();
  }));
  it('does not let another process with copied writer identity claim or maintain the writer', async () => setup(async local => {
    const c = fork(path.join(__dirname, 'helpers/ubuntu-ledger-child.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const result = new Promise((resolve, reject) => {
      let claimed; const timer = setTimeout(() => { c.kill('SIGTERM'); reject(Error('Child deadline')); }, 5000);
      c.on('message', async m => {
        if (m.type === 'done') claimed = m.result;
        if (m.type === 'anchor') { try { c.send({ type: 'reply', id: m.id, ok: true, value: await local.f.anchor[m.method](m.q) }); }
          catch { c.send({ type: 'reply', id: m.id, ok: false }); } }
      });
      c.on('error', reject); c.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(claimed) : reject(Error('Child failed')); });
    });
    const { anchor, evidence, utc, ...options } = local.f.options;
    c.send({ type: 'start', options, evidence: require('./helpers/ubuntu-ledger.cjs').evidence, action: 'probe', request: local.f.request({ mode: 'apply' }) });
    assert.deepEqual(await result, { claim: false, admission: 'denied', gates: false }); assert.equal((await local.ledger.status()).writerClaimed, true);
  }));
  it('rolls back an actual interrupted SQLite transaction after SIGKILL', async () => {
    const f = await fixture(); try {
      assert.equal(await f.initialize(), true);
      const child = fork(path.join(__dirname, 'helpers/ubuntu-crash-child.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
      const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, sig) => { clearTimeout(timer); sig === 'SIGKILL' ? resolve() : reject(Error('Expected crash')); }); });
      child.send({ file: path.join(f.directory, 'authority.sqlite') }); await exited;
      const ledger = await f.open(); assert.equal(!!ledger, true);
      assert.equal(await ledger.claimWriter(), true); await ledger.setGates({ prepare: true, apply: true, reconcile: true });
      assert.equal((await ledger.authority.reserve(f.reservation(), signal())).ordinal, 1);
    } finally { f.cleanup(); }
  });
});
