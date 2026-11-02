const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate emitted bootstrap in a sealed VM, NEVER import/execute the real
// server module. Only synthetic env and stub imports exist: no MongoDB or TCP.
const code = fs.readFileSync(path.join(__dirname, '../dist/server.js'), 'utf8');
function bootstrap(env) {
  const calls = { connect: 0, listen: [], imports: [], dotenv: false };
  const sandbox = {
    exports: {}, process: { env: { ...env } }, console: { log() {} },
    require(name) {
      calls.imports.push(name);
      if (name === 'dotenv') return { config() { calls.dotenv = true; } };
      assert.equal(calls.dotenv, true);
      if (name === 'mongoose') return { connect() { calls.connect++; } };
      if (name === './app') return { listen(...args) { calls.listen.push(args); } };
      throw new Error('Unexpected bootstrap dependency');
    },
  };
  let error;
  try { vm.runInNewContext(code, sandbox, { timeout: 1000 }); } catch (e) { error = e; }
  return { calls, error };
}
for (const port of ['1', '3000', '65535', '00080']) it('uses numeric TCP port ' + port, () => {
  const { calls, error } = bootstrap({ PORT: port });
  assert.equal(error, undefined);
  assert.equal(calls.connect, 1); // Stub only; no real mongoose module is loaded.
  assert.equal(calls.listen[0][0], Number(port));
  assert.equal(calls.listen[0].length, 2);
  assert.equal(typeof calls.listen[0][1], 'function');
});
it('keeps default 3000 and host-omitted deployment behavior', () => {
  const { calls, error } = bootstrap({});
  assert.equal(error, undefined);
  assert.equal(calls.listen[0][0], 3000);
  assert.equal(calls.listen[0].length, 2);
});
it('passes explicit loopback host and numeric port', () => {
  const { calls, error } = bootstrap({ PORT: '4100', BUDGET_HTTP_HOST: '127.0.0.1' });
  assert.equal(error, undefined);
  assert.equal(calls.listen[0][0], 4100);
  assert.equal(calls.listen[0][1], '127.0.0.1');
  assert.equal(calls.listen[0].length, 3);
  assert.equal(typeof calls.listen[0][2], 'function');
});
for (const port of ['', '0', '65536', '-1', '+80', '3.5', '1e3', '0x50', ' 80', '80 ', '80\n', '80\r', '80\u2028', '/tmp/backend.sock', 'NaN', 'Infinity'])
  it('rejects invalid port case ' + JSON.stringify(port), () => {
    const { calls, error } = bootstrap({ PORT: port });
    assert.equal(error?.message, 'PORT must be a decimal TCP port between 1 and 65535');
    assert.equal(calls.connect, 0);
    assert.equal(calls.listen.length, 0);
    assert.deepEqual(calls.imports, ['dotenv']);
  });
for (const host of ['', 'localhost', '0.0.0.0', '::1', '127.0.0.1 ', '192.0.2.1'])
  it('rejects unsupported host case ' + JSON.stringify(host), () => {
    const { calls, error } = bootstrap({ BUDGET_HTTP_HOST: host });
    assert.equal(error?.message, 'BUDGET_HTTP_HOST must be absent or 127.0.0.1');
    assert.equal(calls.connect, 0);
    assert.equal(calls.listen.length, 0);
    assert.deepEqual(calls.imports, ['dotenv']);
  });
