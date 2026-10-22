// Synthetic IPC issuer used only to prove process restart against a parent-owned
// shared test authority. No key bytes, MongoDB, HTTP endpoints or production IO.
const { validateRuntimeConfiguration } = require('../../dist/domain/classification/runtimeConfiguration');
const { createOperationalPorts } = require('../../dist/services/classificationRuntime/ports');
let sequence = 0, ports;
const pending = new Map();
const remote = (service, method, request) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); process.send({ type: 'call', id, service, method, request });
});
process.on('message', async message => {
  if (message.type === 'provider-reply') {
    const p = pending.get(message.id); pending.delete(message.id);
    if (message.ok) p?.resolve(message.value); else p?.reject(Error('Synthetic provider unavailable'));
  } else if (message.type === 'start') {
    const c = validateRuntimeConfiguration(message.config);
    if (!c.ok) { process.exitCode = 1; process.disconnect(); return; }
    ports = createOperationalPorts(c.value, { version: 'classification-providers-v1', assurance: 'synthetic',
      authority: Object.fromEntries(['attest', 'begin', 'end', 'reserve'].map(m => [m, q => remote('authority', m, q)])),
      secrets: Object.fromEntries(['load', 'check'].map(m => [m, q => remote('secrets', m, q)])),
      clock: { sample: q => remote('clock', 'sample', q) }, telemetry: { emit() {} } }, async () => true);
    process.send({ type: 'ready' });
  } else if (message.type === 'reserve') process.send({ type: 'result', allowed: await ports.operations.reserveIssuance() });
  else if (message.type === 'close') { ports.close(); process.disconnect(); }
});
