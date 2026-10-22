import { randomUUID } from 'node:crypto';
import { createRuntimeClock } from '../../domain/classification/runtimeClock';
import { ISSUANCE_LIMIT, plain, runtimePolicyDigest, uint, type RuntimeConfiguration, type RuntimeMode } from '../../domain/classification/runtimeConfiguration';
import { runtimeKeyAllowed } from '../../domain/classification/runtimeKeyPolicy';
import type { ProtocolOperations } from '../classificationProtocol';
import { deploymentEvidence, OPERATIONAL_EVENTS } from './contracts';
import type { AdmissionRequest, Binding, DeploymentEvidence, EvidenceRequest, OperationalEventType, RuntimeProviders } from './contracts';

export const PROVIDER_TIMEOUT_MS = 1000;
const functions = (x: unknown, names: readonly string[]) => {
  const r = plain(x, names); return r && Object.keys(r).length === names.length && names.every(n => typeof r[n] === 'function') ? r : undefined;
};
export const validateProviders = (input: unknown, scope: unknown): RuntimeProviders | undefined => {
  const p = plain(input, ['version', 'assurance', 'authority', 'secrets', 'clock', 'telemetry', 'localClock']);
  if (!p || p.version !== 'classification-providers-v1' || (scope !== 'isolated-test' && scope !== 'operational')
    || (p.assurance !== 'synthetic' && p.assurance !== 'operator-verified') || (scope === 'operational' && p.assurance !== 'operator-verified')
    || !functions(p.authority, ['attest', 'begin', 'end', 'reserve']) || !functions(p.secrets, ['load', 'check'])
    || !functions(p.clock, ['sample']) || !functions(p.telemetry, ['emit'])
    || (Object.hasOwn(p, 'localClock') && typeof p.localClock !== 'function')) return;
  // Functions were inspected via own data descriptors. No getters/prototype methods.
  return { version: 'classification-providers-v1', assurance: p.assurance,
    authority: { ...p.authority as RuntimeProviders['authority'] }, secrets: { ...p.secrets as RuntimeProviders['secrets'] },
    clock: { ...p.clock as RuntimeProviders['clock'] }, telemetry: { ...p.telemetry as RuntimeProviders['telemetry'] },
    ...(p.localClock ? { localClock: p.localClock as NonNullable<RuntimeProviders['localClock']> } : {}) };
};
/** Reject slow/failed providers without printing their exception. Abort is NOT a
 * rollback of an external reservation/lease. Late successful calls remain spent. */
export const providerCall = async (call: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> => {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => call(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Error('Operational provider unavailable')); }, PROVIDER_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); controller.abort(); }
};
const sameReceipt = (input: unknown, version: string, request: EvidenceRequest, fields: string[]) => {
  const r = plain(input, ['version', 'requestId', 'policyDigest', ...fields]);
  return r && Object.keys(r).length === 3 + fields.length && r.version === version && r.requestId === request.requestId && r.policyDigest === request.binding.policyDigest ? r : undefined;
};
export const createOperationalPorts = (config: RuntimeConfiguration, providers: RuntimeProviders,
  inspectDatabase: (evidence: DeploymentEvidence) => Promise<boolean>) => {
  const policyDigest = runtimePolicyDigest(config);
  const binding: Binding = Object.freeze({ version: 'classification-operational-binding-v1', deploymentId: config.deploymentId,
    revision: config.revision, databaseName: config.databaseName, policyDigest });
  const clock = createRuntimeClock(providers.localClock);
  const enabled = { prepare: true, apply: true, reconcile: true };
  const active = new Set<AdmissionRequest>();
  const pending = new Set<object>(), drained = new Set<() => void>();
  const lastState = new Map<RuntimeMode, boolean>();
  let poisoned = false, closed = false, providerCalls = 0, checking = 0;
  let clockQueue = Promise.resolve();
  const emit = (type: OperationalEventType) => {
    if (!OPERATIONAL_EVENTS.includes(type)) { poisoned = true; return; }
    try { providers.telemetry.emit(Object.freeze({ version: 'classification-operations-event-v1', type })); }
    catch { poisoned = true; } // A broken trusted sink never leaks raw exceptions.
  };
  const call = async (fn: (signal: AbortSignal) => Promise<unknown>) => {
    if (providerCalls >= 32) throw Error('Operational provider unavailable');
    providerCalls++; try { return await providerCall(fn); } finally { providerCalls--; }
  };
  const request = (): EvidenceRequest => Object.freeze({ binding, requestId: randomUUID() });
  const signalDrain = () => { if (!active.size && !pending.size) drained.forEach(notify => notify()); };
  const ready = async (mode: RuntimeMode): Promise<boolean> => {
    if (checking >= 32) return false;
    checking++;
    let ok = false;
    try {
      if (closed || poisoned || !enabled[mode] || mode !== 'reconcile' && !enabled.reconcile
        || mode === 'prepare' && !enabled.apply) return false;
      const q = request();
      const raw = await call(signal => providers.authority.attest(q, signal));
      const r = sameReceipt(raw, 'classification-authority-evidence-v1', q,
        ['deployment', 'prepare', 'apply', 'reconcile']);
      const d = deploymentEvidence(r?.deployment);
      if (!r || !d || !['prepare', 'apply', 'reconcile'].every(k => typeof r[k] === 'boolean') || r[mode] !== true || mode !== 'reconcile' && r.reconcile !== true
        || mode === 'prepare' && r.apply !== true) return false;
      const secretHealth = sameReceipt(await call(signal => providers.secrets.check(q, signal)),
        'classification-key-health-v1', q, ['available']);
      if (!secretHealth || secretHealth.available !== true) { emit('keyring_unavailable'); return false; }
      const sample = clockQueue.then(async () => {
        const utc = await call(signal => providers.clock.sample(q, signal));
        return clock.accept(utc, q.requestId, policyDigest);
      });
      clockQueue = sample.then(() => {}, () => {});
      if (!await sample) { emit('clock_unhealthy'); return false; }
      if (!await inspectDatabase(d)) { emit('manifest_mismatch'); return false; }
      const now = clock.nowSeconds();
      ok = Number.isFinite(now) && !poisoned && !closed && enabled[mode]
        && (mode !== 'prepare' || !!config.issuingKid && runtimeKeyAllowed(config, config.issuingKid, mode, now, now));
      if (lastState.get(mode) !== ok) { lastState.set(mode, ok); emit(ok ? 'runtime_ready' : 'runtime_unavailable'); }
      return ok && !poisoned;
    } catch { clock.invalidate(); return false; }
    finally {
      checking--;
      if (!ok && lastState.get(mode) !== ok) { lastState.set(mode, ok); emit(ok ? 'runtime_ready' : 'runtime_unavailable'); }
    }
  };
  const release = async (q: AdmissionRequest) => {
    try {
      const r = sameReceipt(await call(signal => providers.authority.end(q, signal)), 'classification-lease-v1', q, ['state']);
      if (!r || r.state !== 'closed') throw Error('Operational lease release unavailable');
      active.delete(q);
    } catch { poisoned = true; emit('lease_release_unavailable'); } // Retain unresolved lease; drain must fail.
    finally { signalDrain(); }
  };
  const acquireAdmission = async (mode: RuntimeMode): Promise<(() => Promise<void>) | null> => {
    if (closed || poisoned || !enabled[mode] || pending.size >= 32) return null;
    const marker = {}; pending.add(marker);
    try {
      if (!await ready(mode) || closed || poisoned || !enabled[mode]) { emit('admission_denied'); return null; }
      const q = Object.freeze({ ...request(), mode });
      const r = sameReceipt(await call(signal => providers.authority.begin(q, signal)), 'classification-lease-v1', q, ['state']);
      if (!r || r.state !== 'admitted') { if (!r || r.state !== 'denied') poisoned = true; emit('admission_denied'); return null; }
      active.add(q);
      if (poisoned || closed || !enabled[mode] || !await ready(mode)) { await release(q); return null; }
      let released = false;
      return async () => { if (released) return; released = true; await release(q); };
    } catch {
      // begin may have durably succeeded after timeout. Do NOT claim fleet drain
      // or auto-expire the unknown admission; external fencing/reconciliation required.
      poisoned = true; emit('admission_denied'); return null;
    } finally { pending.delete(marker); signalDrain(); }
  };
  const reserveIssuance = async (): Promise<boolean> => {
    try {
      if (!await ready('prepare')) { emit('issuance_denied'); return false; }
      const k = config.keys.find(k => k.kid === config.issuingKid)!;
      const q = Object.freeze({ ...request(), materialId: k.materialId, maximum: ISSUANCE_LIMIT, issueUntil: k.issueUntil });
      const r = sameReceipt(await call(signal => providers.authority.reserve(q, signal)),
        'classification-reservation-v1', q, ['materialId', 'ordinal', 'state']);
      const ok = r?.state === 'reserved' && r.materialId === k.materialId && uint(r.ordinal) && r.ordinal >= 1 && r.ordinal <= ISSUANCE_LIMIT;
      emit(ok ? 'issuance_admitted' : r?.state === 'exhausted' ? 'quota_exhausted' : 'issuance_denied');
      return ok && !poisoned && !closed && enabled.prepare;
    } catch { emit('issuance_denied'); return false; }
  };
  const operations: ProtocolOperations = Object.freeze({ ready, reserveIssuance, nowSeconds: clock.nowSeconds, acquireAdmission,
    keyAllowed: (kid, mode, issuedAt, now) => !poisoned && !closed && Number.isFinite(clock.nowSeconds())
      && runtimeKeyAllowed(config, kid, mode, issuedAt, now),
    observe: emit,
  });
  const drain = async (timeoutMilliseconds = 5000): Promise<boolean> => {
    enabled.prepare = false; enabled.apply = false;
    if (!uint(timeoutMilliseconds) || timeoutMilliseconds > 30000) return false;
    if (active.size || pending.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const notified = new Promise<void>(resolve => {
        const notify = () => { clearTimeout(timer); drained.delete(notify); resolve(); };
        drained.add(notify); timer = setTimeout(notify, timeoutMilliseconds);
      });
      await notified;
    }
    const ok = !poisoned && !active.size && !pending.size;
    emit(ok ? 'drain_completed' : 'drain_incomplete'); return ok;
  };
  return Object.freeze({ binding, operations, emit,
    disableIssuance() { enabled.prepare = false; }, disableApply() { enabled.apply = false; },
    disableReconciliation() { enabled.reconcile = false; }, drain,
    close() { enabled.prepare = false; enabled.apply = false; enabled.reconcile = false; closed = true; clock.invalidate(); },
    /** Local counts only. Never a fleet-maintenance authorization. */
    localState: () => Object.freeze({ active: active.size, pending: pending.size, unavailable: poisoned || closed }),
  });
};
