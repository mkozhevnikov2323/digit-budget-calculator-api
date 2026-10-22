const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { fixtureConfiguration } = require('./helpers/operational-runtime.cjs');
const { runtimePolicyDigest } = require('../dist/domain/classification/runtimeConfiguration');
const { createSystemdCredentialProvider } = require('../dist/services/classificationRuntime/ubuntu/credentials');
const { parseChronyTracking, createClockHealthAdapter, createUbuntuChronyClock } = require('../dist/services/classificationRuntime/ubuntu/clock');
const signal = () => new AbortController().signal;
const request = config => ({ requestId: randomUUID(), binding: { version: 'classification-operational-binding-v1',
  deploymentId: config.deploymentId, revision: config.revision, databaseName: config.databaseName, policyDigest: runtimePolicyDigest(config) } });
function credentials() {
  const f = fixtureConfiguration(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-credentials-'));
  fs.chmodSync(directory, 0o700);
  const manifest = { version: 'classification-credential-manifest-v1', purpose: 'classification-review-aead-v1', kids: ['synthetic'] };
  const writeManifest = () => { const file = path.join(directory, 'classification-aead.json');
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify(manifest), { mode: 0o400 }); fs.chmodSync(file, 0o400); };
  writeManifest(); fs.writeFileSync(path.join(directory, 'classification-key-synthetic'), f.materials.get('synthetic'), { mode: 0o400 });
  return { ...f, directory, manifest, writeManifest, request: () => request(f.config), provider: () => createSystemdCredentialProvider(f.config, directory),
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); } };
}
const tracking = (now, changes = {}) => {
  const f = ['CB007101', '203.0.113.1', '2', String(now / 1000 - 1), '0.001', '-0.001', '0.001', '1', '0', '1', '0.01', '0.01', '16', 'Normal'];
  for (const [key, value] of Object.entries(changes)) f[Number(key)] = value;
  return f.join(',') + '\n';
};
function controlledClock() {
  const f = fixtureConfiguration(); const state = { wallMilliseconds: Date.now(), monotonicMilliseconds: 10000, bootMilliseconds: 100000,
    bootId: randomUUID(), changes: {}, available: true, approved: true, highWater: 0, checkpointCalls: 0 };
  const dependencies = { measure: () => ({ wallMilliseconds: state.wallMilliseconds, monotonicMilliseconds: state.monotonicMilliseconds,
    bootMilliseconds: state.bootMilliseconds, bootId: state.bootId }),
    readTracking: async () => { if (!state.available) throw Error('Fixture unavailable'); return tracking(state.wallMilliseconds, state.changes); },
    checkpoint: { async accept(q) {
      state.checkpointCalls++;
      if (!state.approved || q.wallMilliseconds < state.highWater) throw Error('Fixture policy denied');
      state.highWater = q.wallMilliseconds;
      return { version: 'classification-time-checkpoint-v1', requestId: q.requestId, policyDigest: q.binding.policyDigest, accepted: true };
    } } };
  return { ...f, state, dependencies, provider: () => createClockHealthAdapter(f.config, dependencies), request: () => request(f.config),
    advance(ms) { state.wallMilliseconds += ms; state.monotonicMilliseconds += ms; state.bootMilliseconds += ms; } };
}
describe('P11.1 protected systemd credential directory, disposable generated keys only', { concurrency: false }, () => {
  it('loads exact generated material, verifies identity, checks fresh files and supports restart', async () => {
    const f = credentials(); try {
      for (let i = 0; i < 2; i++) {
        const p = f.provider(), r = await p.load(f.request(), signal());
        assert.equal(r.keys.length, 1); assert.equal(r.keys[0].key.length, 32);
        assert.equal(createHash('sha256').update(r.keys[0].key).digest('hex') === f.config.keys[0].materialId, true);
        r.keys[0].key.fill(0); assert.equal((await p.check(f.request(), signal())).available, true);
      }
    } finally { f.cleanup(); }
  });
  for (const kind of ['purpose', 'version', 'missing-key', 'short-key', 'long-key', 'wrong-material', 'duplicate-kid', 'extra-field', 'manifest-path', 'missing-directory', 'directory-mode', 'key-mode', 'symlink', 'hardlink', 'stale-policy'])
    it('fails closed without sensitive diagnostic data: ' + kind, async () => {
      const f = credentials(); try {
        const file = path.join(f.directory, 'classification-key-synthetic'); fs.chmodSync(file, 0o600);
        if (kind === 'purpose') f.manifest.purpose = 'jwt';
        if (kind === 'version') f.manifest.version = 'v2';
        if (kind === 'missing-key') fs.unlinkSync(file);
        if (kind === 'short-key') fs.writeFileSync(file, randomBytes(31));
        if (kind === 'long-key') fs.writeFileSync(file, randomBytes(33));
        if (kind === 'wrong-material') fs.writeFileSync(file, randomBytes(32));
        if (kind === 'duplicate-kid') f.manifest.kids.push('synthetic');
        if (kind === 'extra-field') f.manifest.extra = true;
        if (kind === 'manifest-path') f.manifest.kids = ['../synthetic'];
        f.writeManifest();
        if (kind === 'directory-mode') fs.chmodSync(f.directory, 0o750);
        if (kind === 'key-mode') fs.chmodSync(file, 0o644);
        if (kind === 'symlink') { fs.renameSync(file, file + '.old'); fs.symlinkSync(file + '.old', file); }
        if (kind === 'hardlink') fs.linkSync(file, file + '.alias');
        const p = kind === 'missing-directory' ? createSystemdCredentialProvider(f.config, path.join(f.directory, 'absent')) : f.provider();
        const q = f.request(); if (kind === 'stale-policy') q.binding.revision++;
        await assert.rejects(p.load(q, signal()), { message: 'Ubuntu credentials unavailable' });
        await assert.rejects(p.check(q, signal()), { message: 'Ubuntu credentials unavailable' });
      } finally { f.cleanup(); }
    });
  it('rotation retains verification-only material and excludes explicitly revoked credentials', async () => {
    const f = credentials(); try {
      const old = f.config.keys[0], next = randomBytes(32);
      f.config.revision++; f.config.issuingKid = 'next';
      f.config.keys = [{ ...old, state: 'verify_only', issueUntil: Math.floor(Date.now() / 1000) },
        { ...old, kid: 'next', materialId: createHash('sha256').update(next).digest('hex') }];
      // Keep old recovery deadline within the existing approved 24h bound.
      f.config.keys[0].verifyUntil = f.config.keys[0].issueUntil + 86400;
      f.manifest.kids.push('next'); f.writeManifest();
      fs.writeFileSync(path.join(f.directory, 'classification-key-next'), next, { mode: 0o400 }); next.fill(0);
      let p = f.provider(); assert.equal((await p.load(f.request(), signal())).keys.length, 2);
      f.config.revision++; f.config.keys[0].state = 'revoked';
      // Stale credential manifest still listing revoked material must fail.
      p = f.provider(); await assert.rejects(p.check(f.request(), signal()), { message: 'Ubuntu credentials unavailable' });
      f.manifest.kids = ['next']; f.writeManifest(); fs.unlinkSync(path.join(f.directory, 'classification-key-synthetic'));
      assert.equal((await p.load(f.request(), signal())).keys.length, 1);
    } finally { f.cleanup(); }
  });
  it('rejects malformed configuration and requires explicit absolute directory', () => {
    assert.equal(createSystemdCredentialProvider({}, '/tmp'), undefined);
    assert.equal(createSystemdCredentialProvider(fixtureConfiguration().config, './credentials'), undefined);
  });
});
describe('P11.1 chrony health and independent checkpoint; controlled clock fixtures', { concurrency: false }, () => {
  it('accepts fresh synchronized bounded evidence with exact binding and fresh request', async () => {
    const f = controlledClock(), p = f.provider(), q = f.request(), r = await p.sample(q, signal());
    assert.equal(r.utcMilliseconds, f.state.wallMilliseconds); assert.equal(r.requestId === q.requestId, true);
    assert.equal(r.uncertaintyMilliseconds <= 1000, true); assert.equal(f.state.checkpointCalls, 1);
    f.advance(100); assert.equal((await p.sample(f.request(), signal())).utcMilliseconds, f.state.wallMilliseconds);
  });
  for (const [name, change] of [ ['unsynchronized', { 13: 'Not synchronised' }], ['leap', { 13: 'Insert second' }],
    ['stratum', { 2: '16' }], ['local-reference', { 0: '7F7F0101' }], ['missing-reference', { 0: '00000000' }],
    ['uncertainty', { 11: '2' }], ['offset', { 4: '3' }], ['infinite', { 4: 'Infinity' }], ['exponent', { 11: '1e-3' }],
    ['negative-delay', { 10: '-1' }], ['stale-interval', { 12: '1024' }] ])
    it('rejects chrony report: ' + name, async () => {
      const f = controlledClock(); f.state.changes = change;
      await assert.rejects(f.provider().sample(f.request(), signal()), { message: 'Ubuntu clock unavailable' });
      assert.equal(f.state.checkpointCalls, 0);
    });
  it('rejects stale/future reference, extra CSV lines/fields and unbounded output', () => {
    const now = Date.now();
    for (const raw of [tracking(now, { 3: String(now / 1000 - 121) }), tracking(now, { 3: String(now / 1000 + 2) }),
      tracking(now) + tracking(now), tracking(now).trim() + ',extra', 'a'.repeat(4097), tracking(now).replace('\n', '\r\n')])
      assert.equal(parseChronyTracking(raw, now, 0), undefined);
  });
  for (const kind of ['rollback', 'forward', 'suspend', 'monotonic-back', 'boot-change'])
    it('poisons observable time discontinuity: ' + kind, async () => {
      const f = controlledClock(), p = f.provider(); await p.sample(f.request(), signal());
      if (kind === 'rollback') f.state.wallMilliseconds -= 5000;
      if (kind === 'forward') f.state.wallMilliseconds += 5000;
      if (kind === 'suspend') { f.state.wallMilliseconds += 5000; f.state.bootMilliseconds += 5000; }
      if (kind === 'monotonic-back') f.state.monotonicMilliseconds--;
      if (kind === 'boot-change') f.state.bootId = randomUUID();
      await assert.rejects(p.sample(f.request(), signal()), { message: 'Ubuntu clock unavailable' });
      await assert.rejects(p.sample(f.request(), signal()), { message: 'Ubuntu clock unavailable' });
    });
  it('requires independent reboot/restart approval and retains external UTC high-water', async () => {
    const f = controlledClock(); await f.provider().sample(f.request(), signal());
    f.state.wallMilliseconds -= 1000; f.state.bootId = randomUUID();
    await assert.rejects(f.provider().sample(f.request(), signal()), { message: 'Ubuntu clock unavailable' });
    f.state.wallMilliseconds += 2000; f.state.approved = false;
    await assert.rejects(f.provider().sample(f.request(), signal()), { message: 'Ubuntu clock unavailable' });
  });
  it('rejects absent checkpoint, failed provider, wrong binding and stale acknowledgments', async () => {
    const f = controlledClock();
    assert.equal(createClockHealthAdapter(f.config, { ...f.dependencies, checkpoint: {} }), undefined);
    f.state.available = false; await assert.rejects(f.provider().sample(f.request(), signal()), { message: 'Ubuntu clock unavailable' });
    f.state.available = true; const q = f.request(); q.binding.revision++;
    await assert.rejects(f.provider().sample(q, signal()), { message: 'Ubuntu clock unavailable' });
    f.dependencies.checkpoint.accept = async () => ({ version: 'classification-time-checkpoint-v1', requestId: randomUUID(), policyDigest: q.binding.policyDigest, accepted: true });
    await assert.rejects(f.provider().sample(f.request(), signal()), { message: 'Ubuntu clock unavailable' });
  });
  it('bounds slow external providers without exposing exception output', async () => {
    const f = controlledClock(); f.dependencies.readTracking = () => new Promise(() => {});
    await assert.rejects(f.provider().sample(f.request(), signal()), { message: 'Ubuntu clock unavailable' });
  });
  it('bounds full sampling latency and fails on mid-sample suspend', async () => {
    const f = controlledClock(); f.dependencies.readTracking = async () => { f.advance(801); return tracking(f.state.wallMilliseconds); };
    await assert.rejects(f.provider().sample(f.request(), signal()), { message: 'Ubuntu clock unavailable' });
    f.dependencies.readTracking = async () => { f.state.bootMilliseconds += 5000; return tracking(f.state.wallMilliseconds); };
    await assert.rejects(f.provider().sample(f.request(), signal()), { message: 'Ubuntu clock unavailable' });
  });
  it('does not assume chrony exists and rejects nonabsolute or missing executables', () => {
    const f = controlledClock(); assert.equal(createUbuntuChronyClock(f.config, 'chronyc', f.dependencies.checkpoint), undefined);
    assert.equal(createUbuntuChronyClock(f.config, '/nonexistent/chronyc', f.dependencies.checkpoint), undefined);
  });
});
