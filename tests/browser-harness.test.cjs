const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const { once } = require('node:events');
const filename = path.join(__dirname, 'browser/server.cjs');
describe('Disposable browser bootstrap refuses unsafe startup before MongoDB', () => {
  for (const [name, extra] of [
    ['missing explicit browser opt-in', { BUDGET_BROWSER_TEST: undefined }],
    ['missing integration opt-in', { BUDGET_BROWSER_TEST: '1', MONGODB_INTEGRATION_TEST: undefined }],
    ['remote or application URI', { BUDGET_BROWSER_TEST: '1', MONGODB_INTEGRATION_TEST: '1', MONGODB_TEST_BASE_URI: 'mongodb://remote.invalid' }],
  ]) it(name, { timeout: 10000 }, async () => {
    const env = { ...process.env, MONGODB_TEST_BASE_URI: 'mongodb://127.0.0.1:27017', ...extra };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const child = fork(filename, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = false, failure;
    child.stdout.on('data', () => { output = true; }); child.stderr.on('data', () => { output = true; });
    child.on('message', message => { failure = message; });
    try {
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 1); assert.equal(signal, null); assert.equal(output, false);
      assert.equal(failure.type, 'failure'); assert.equal(failure.stage, 'guard');
    } finally { if (child.connected) child.kill('SIGTERM'); }
  });
});
