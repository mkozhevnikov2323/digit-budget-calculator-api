const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.join(__dirname, 'run-integration-tests.cjs');
const execute = args => {
  const env = { ...process.env };
  // A fresh standalone runner must not inherit Node's recursive-test marker.
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined, 'Runner child must finish within its bound');
  assert.equal(child.signal, null);
  return child;
};
const withFixture = (source, check) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-runner-regression-'));
  const filename = path.join(directory, 'isolated.test.cjs');
  try {
    fs.writeFileSync(filename, source);
    check(filename);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(fs.existsSync(directory), false);
  }
};

it('rejects a deliberately failing suite after-hook even when every child passes', () => {
  withFixture(`
    const { describe, it, after } = require('node:test');
    describe('isolated suite', () => {
      after(() => { throw new Error('Synthetic after-hook rejection'); });
      it('passing child', () => {});
    });
  `, filename => {
    const raw = execute(['--test', '--test-reporter=tap', filename]);
    const guarded = execute([runner, filename]);
    assert.match(raw.stdout, /^not ok \d+ - isolated suite$/m);
    assert.match(raw.stdout, /failureType: 'hookFailed'/);
    assert.equal(guarded.status, 1);
    assert.match(guarded.stdout, /^not ok \d+ - isolated suite$/m);
    assert.match(guarded.stdout, /failureType: 'hookFailed'/);
    assert.match(guarded.stdout, /Synthetic after-hook rejection/);
    assert.match(guarded.stdout, /ok \d+ - passing child/);
    console.info(`Deliberate after-hook rejection: raw exit=${raw.status}, guarded exit=${guarded.status}.`);
  });
});

it('rejects a failing suite before-hook', () => {
  withFixture(`
    const { describe, it, before } = require('node:test');
    describe('isolated suite', () => {
      before(() => { throw new Error('Synthetic before-hook rejection'); });
      it('unreachable child', () => {});
    });
  `, filename => {
    const child = execute([runner, filename]);
    assert.equal(child.status, 1);
    assert.match(child.stdout, /failureType: 'hookFailed'/);
    assert.match(child.stdout, /Synthetic before-hook rejection/);
  });
});

it('rejects an ordinary failing test and retains its failure output', () => {
  withFixture(`
    const { it } = require('node:test');
    it('isolated rejection', () => { throw new Error('Synthetic test rejection'); });
  `, filename => {
    const child = execute([runner, filename]);
    assert.equal(child.status, 1);
    assert.match(child.stdout, /^not ok \d+ - isolated rejection$/m);
    assert.match(child.stdout, /Synthetic test rejection/);
  });
});

it('accepts passing tests whose diagnostics contain failure-looking text', () => {
  withFixture(`
    const { it } = require('node:test');
    it('passing diagnostic', () => {
      console.info('not ok 99 - ordinary diagnostic text');
      console.info("failureType: 'hookFailed'");
    });
  `, filename => {
    const child = execute([runner, filename]);
    assert.equal(child.status, 0);
    assert.match(child.stdout, /^# not ok 99 - ordinary diagnostic text$/m);
    assert.match(child.stdout, /^# failureType: 'hookFailed'$/m);
    assert.match(child.stdout, /^ok \d+ - passing diagnostic$/m);
    assert.doesNotMatch(child.stdout, /^\s*not ok(?:\s|$)/m);
  });
});

it('rejects a test-file process failure before any tests are registered', () => {
  withFixture(`throw new Error('Synthetic file failure');`, filename => {
    const child = execute([runner, filename]);
    assert.equal(child.status, 1);
    assert.match(child.stdout, /Synthetic file failure/);
    assert.match(child.stdout, /not ok/);
  });
});
