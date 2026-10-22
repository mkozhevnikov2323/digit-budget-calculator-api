const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { fixture, evidence } = require('./helpers/ubuntu-ledger.cjs');
const { initializeLocalLedger } = require('../dist/services/classificationRuntime/ubuntu/ledger');
const signal = () => new AbortController().signal;
const setup = async fn => { const f = await fixture(); try { assert.equal(await f.initialize(), true); const h = await f.open(); assert.equal(!!h, true);
  assert.equal(await h.claimWriter(), true); assert.equal(await h.setGates({ prepare: true, apply: true, reconcile: true }), true); await fn(f, h); } finally { f.cleanup(); } };
async function child(f, action, request, crash = false) {
  return new Promise((resolve, reject) => {
    const c = fork(path.join(__dirname, 'helpers/ubuntu-ledger-child.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result, done = false; const timer = setTimeout(() => { c.kill('SIGKILL'); reject(Error('Child deadline')); }, 10000);
    c.on('error', reject);
    c.on('message', async m => {
      if (m.type === 'done') { result = m.result; done = true; return; }
      if (m.type === 'anchor') { try { const value = await f.anchor[m.method](m.q); c.send({ type: 'reply', id: m.id, ok: true, value }); }
        catch { c.send({ type: 'reply', id: m.id, ok: false }); } }
    });
    c.on('exit', (code, sig) => { clearTimeout(timer); if (!done || (crash ? sig !== 'SIGKILL' : code !== 0)) reject(Error('Child failed')); else resolve(result); });
    const { anchor, evidence: e, utc, ...options } = f.options;
    c.send({ type: 'start', options, evidence, action, request, crash });
  });
}
describe('P11.1 real SQLite authority; synthetic external anchor, no host activation', { concurrency: false }, () => {
  it('requires explicit approved genesis, starts closed, refuses implicit recreation', async () => {
    const f = await fixture(); try {
      assert.equal(await f.open(), undefined);
      assert.equal(await initializeLocalLedger(f.options, f.config, randomUUID()), false);
      assert.equal(fs.existsSync(path.join(f.directory, 'authority.sqlite')), true);
      assert.equal(await f.initialize(), false);
    } finally { f.cleanup(); }
  });
  it('initializes once with FULL-or-stronger durability and exact owned permissions', async () => {
    const f = await fixture(); try {
      assert.equal(await f.initialize(), true); assert.equal(await f.initialize(), false);
      const h = await f.open(); assert.deepEqual(await h.status(), { active: 0, writerClaimed: false, maintenance: true });
      assert.equal(fs.statSync(path.join(f.directory, 'authority.sqlite')).mode & 0o777, 0o600);
      const db = new DatabaseSync(path.join(f.directory, 'authority.sqlite'));
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND name='active_admissions'").get().n, 1); db.close();
    } finally { f.cleanup(); }
  });
  it('retains quota, duplicate request IDs and failed encryption reservations after restart', async () => setup(async (f, h) => {
    const q = f.reservation(); assert.equal((await h.authority.reserve(q, signal())).ordinal, 1);
    // Reservation is consumed without invoking encryption; there is no refund API.
    f.close(h); h = await f.open();
    assert.equal((await h.authority.reserve(q, signal())).state, 'duplicate');
    assert.equal((await h.authority.reserve(f.reservation(), signal())).ordinal, 2);
  }));
  it('enforces 2^20 via SQL constraint and independently sealed usage checkpoint', async () => setup(async (f, h) => {
    const db = new DatabaseSync(path.join(f.directory, 'authority.sqlite'));
    assert.throws(() => db.prepare('UPDATE materials SET used=?').run(2 ** 20 + 1), { code: 'ERR_SQLITE_ERROR' });
    db.prepare('UPDATE materials SET used=?').run(2 ** 20); db.close();
    // Counter edits without an approved independent checkpoint must be rejected.
    await assert.rejects(h.authority.reserve(f.reservation(), signal()), { message: 'Local authority unavailable' });
    f.close(h); assert.equal(await f.open(), undefined);
  }));
  it('consumes the last allowed ordinal then denies exhaustion without a large loop', async () => setup(async (f, h) => {
    await f.seedUsage(2 ** 20 - 1);
    assert.equal((await h.authority.reserve(f.reservation(), signal())).ordinal, 2 ** 20);
    assert.equal((await h.authority.reserve(f.reservation(), signal())).state, 'exhausted');
    f.close(h); const restarted = await f.open();
    assert.equal((await restarted.authority.reserve(f.reservation(), signal())).state, 'exhausted');
  }));
  it('uses separate processes/connections for competing reservations with no duplicated ordinal', async () => setup(async (f, h) => {
    f.close(h);
    const results = await Promise.all(Array.from({ length: 5 }, () => child(f, 'reserve', f.reservation())));
    const ordinals = results.filter(r => r.state === 'reserved').map(r => r.ordinal);
    assert.equal(ordinals.length > 0, true); assert.equal(new Set(ordinals).size, ordinals.length);
    const current = await f.open(); const r = await current.authority.reserve(f.reservation(), signal());
    assert.equal(r.ordinal, ordinals.length + 1);
  }));
  it('does not refund a committed reservation after actual SIGKILL', async () => setup(async (f, h) => {
    f.close(h); const q = f.reservation(), r = await child(f, 'reserve', q, true); assert.equal(r.state, 'reserved');
    const restarted = await f.open(); assert.equal((await restarted.authority.reserve(q, signal())).state, 'duplicate');
    assert.equal((await restarted.authority.reserve(f.reservation(), signal())).ordinal, 2);
  }));
  it('permits one writer identity, rejects independent writers including another process', async () => setup(async (f, h) => {
    const other = await f.open({ writerId: randomUUID() }); assert.equal(await other.claimWriter(), false);
    const prior = f.options.writerId; f.options.writerId = randomUUID();
    assert.equal(await child(f, 'claim'), false); f.options.writerId = prior;
    assert.equal(await h.releaseWriter(), false);
  }));
  it('retains an orphan writer after its actual process is killed and refuses takeover', async () => {
    const f = await fixture(); try {
      assert.equal(await f.initialize(), true); assert.equal(await child(f, 'claim', undefined, true), true);
      const reopened = await f.open(); assert.equal(await reopened.claimWriter(), false);
      assert.equal(await reopened.setGates({ prepare: true, apply: true, reconcile: true }), false);
      assert.equal((await reopened.status()).writerClaimed, true);
    } finally { f.cleanup(); }
  });
  it('persists request-lifetime leases and blocks maintenance after crash/reopen', async () => setup(async (f, h) => {
    const q = f.request({ mode: 'apply' }); assert.equal((await h.authority.begin(q, signal())).state, 'admitted');
    assert.equal((await h.authority.begin(q, signal())).state, 'duplicate'); f.close(h); h = await f.open();
    assert.equal((await h.status()).active, 1);
    assert.equal(await h.setGates({ prepare: false, apply: false, reconcile: false }), true);
    assert.equal(await h.enterMaintenance(), false); assert.equal(await h.releaseWriter(), false);
    assert.equal((await h.authority.end(q, signal())).state, 'closed'); assert.equal(await h.enterMaintenance(), true);
    assert.equal(await h.releaseWriter(), true);
  }));
  it('denies unknown release rather than inventing successful global drain', async () => setup(async (f, h) => {
    await assert.rejects(h.authority.end(f.request({ mode: 'apply' }), signal()), { message: 'Local authority unavailable' });
    assert.equal(await h.status(), undefined);
  }));
  it('denies stale policy, revokes materials durably and refuses reactivation', async () => setup(async (f, h) => {
    await h.setGates({ prepare: false, apply: false, reconcile: false }); assert.equal(await h.enterMaintenance(), true);
    const next = { ...f.config, revision: 2, issuingKid: null, keys: f.config.keys.map(k => ({ ...k, state: 'revoked' })) };
    assert.equal(await h.publish(next), true); assert.equal(await h.authority.attest(f.request(), signal()), undefined);
    assert.equal((await h.authority.reserve(f.reservation(), signal())).state, 'denied');
    assert.equal(await h.publish({ ...f.config, revision: 3 }), false);
  }));
  it('rejects an old valid SQLite snapshot against the independently retained checkpoint', async () => setup(async (f, h) => {
    const file = path.join(f.directory, 'authority.sqlite'), old = fs.readFileSync(file);
    assert.equal((await h.authority.reserve(f.reservation(), signal())).state, 'reserved'); f.close(h);
    fs.writeFileSync(file, old); assert.equal(await f.open(), undefined);
  }));
  for (const failure of ['missing-anchor', 'anchor-unavailable', 'lost-anchor-ack', 'advance-failure'])
    it('fails closed without resetting on ' + failure, async () => setup(async (f, h) => {
      if (failure === 'missing-anchor') f.state.checkpoint = null;
      if (failure === 'anchor-unavailable') f.state.available = false;
      if (failure === 'lost-anchor-ack') f.state.lostAck = true;
      if (failure === 'advance-failure') f.state.failAdvance = true;
      await assert.rejects(h.authority.reserve(f.reservation(), signal()), { message: 'Local authority unavailable' });
      f.close(h); const reopened = await f.open();
      assert.equal(!!reopened, failure === 'advance-failure');
      if (reopened) await assert.rejects(reopened.authority.reserve(f.reservation(), signal()), { message: 'Local authority unavailable' });
      // A cleanly rejected CAS leaves the old DB usable only after dependency recovery;
      // lost acknowledgment advances the external anchor and therefore blocks it.
    }));
  it('handles locked SQLite and interrupted transaction without silent recovery/reset', async () => setup(async (f, h) => {
    const db = new DatabaseSync(path.join(f.directory, 'authority.sqlite')); db.exec('BEGIN IMMEDIATE');
    await assert.rejects(h.authority.reserve(f.reservation(), signal()), { message: 'Local authority unavailable' });
    db.exec('ROLLBACK'); db.close(); f.close(h); const resumed = await f.open();
    assert.equal((await resumed.authority.reserve(f.reservation(), signal())).ordinal, 1);
  }));
  it('simulates disk-full/write rejection inside a real SQLite transaction', async () => setup(async (f, h) => {
    const db = new DatabaseSync(path.join(f.directory, 'authority.sqlite'));
    db.exec("CREATE TRIGGER deny_reservation BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT,'bounded fixture IO failure'); END;"); db.close();
    await assert.rejects(h.authority.reserve(f.reservation(), signal()), { message: 'Local authority unavailable' });
    f.close(h); const fresh = await f.open(); assert.equal(!!fresh, true);
  }));
  for (const failure of ['corrupt', 'permissions', 'directory', 'replacement', 'symlink'])
    it('rejects unsafe storage: ' + failure, async () => setup(async (f, h) => {
      f.close(h); const file = path.join(f.directory, 'authority.sqlite');
      if (failure === 'corrupt') fs.writeFileSync(file, Buffer.alloc(128));
      if (failure === 'permissions') fs.chmodSync(file, 0o400);
      if (failure === 'directory') fs.chmodSync(f.directory, 0o750);
      if (failure === 'replacement') { const current = await f.open(); fs.renameSync(file, file + '.old'); fs.copyFileSync(file + '.old', file);
        assert.equal(await current.status(), undefined); }
      if (failure === 'symlink') { fs.renameSync(file, file + '.old'); fs.symlinkSync(file + '.old', file); }
      if (failure !== 'replacement') assert.equal(await f.open(), undefined);
    }));
  it('rejects invalid option objects without executing getters or initializing a file', async () => {
    const f = await fixture(); try { let accessed = false;
      const input = Object.defineProperty({ ...f.options }, 'directory', { get() { accessed = true; return f.directory; } });
      assert.equal(await initializeLocalLedger(input, f.config, f.approvalId), false); assert.equal(accessed, false);
      assert.equal(await initializeLocalLedger({ ...f.options, extra: true }, f.config, f.approvalId), false);
    } finally { f.cleanup(); }
  });
});
