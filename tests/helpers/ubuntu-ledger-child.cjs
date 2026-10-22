// Disposable process boundary; only nonsecret operational fixture data via IPC.
const { openLocalLedger } = require('../../dist/services/classificationRuntime/ubuntu/ledger');
let sequence = 0; const pending = new Map();
const rpc = (method, q) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); process.send({ type: 'anchor', id, method, q });
});
process.on('message', async m => {
  if (m.type === 'reply') { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.value) : p.reject(Error('Unavailable')); return; }
  if (m.type !== 'start') return;
  let ledger;
  try {
    ledger = await openLocalLedger({ ...m.options, anchor: { read: q => rpc('read', q), advance: q => rpc('advance', q) },
      evidence: async () => m.evidence, utc: async () => Date.now() });
    if (!ledger) { process.send({ type: 'done', result: 'unavailable' }); return; }
    const result = m.action === 'claim' ? await ledger.claimWriter()
      : await ledger.authority.reserve(m.request, new AbortController().signal);
    process.send({ type: 'done', result });
    if (m.crash) process.kill(process.pid, 'SIGKILL');
  } catch { process.send({ type: 'done', result: 'unavailable' }); }
  finally { ledger?.close(); process.disconnect(); }
});
