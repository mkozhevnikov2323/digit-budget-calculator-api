/** Optional trusted composition, never imported by app/server. Opens existing
 * approved state only. Does NOT initialize ledger, claim writer, enable gates,
 * install HTTP protocol, create keys or connect to MongoDB. */
import { randomUUID } from 'node:crypto';
import { plain, runtimePolicyDigest, validateRuntimeConfiguration } from '../../../domain/classification/runtimeConfiguration';
import type { Binding, EvidenceRequest, RuntimeProviders } from '../contracts';
import type { RuntimeControl } from '../install';
import { openLocalLedger, type IndependentAnchor, type LocalLedger } from './ledger';
import { createSystemdCredentialProvider } from './credentials';
import { createUbuntuChronyClock } from './clock';
const methods = (input: unknown, names: string[]) => { const r = plain(input, names);
  return !!r && Object.keys(r).length === names.length && names.every(k => typeof r[k] === 'function'); };
export const openUbuntuProviders = async (configuration: unknown, options: unknown): Promise<Readonly<{ providers: RuntimeProviders; ledger: LocalLedger }> | undefined> => {
  const c = validateRuntimeConfiguration(configuration);
  const o = plain(options, ['directory', 'ledgerId', 'writerId', 'anchor', 'timeCheckpoint', 'chronycPath', 'credentialDirectory', 'evidence', 'telemetry']);
  if (!c.ok || !o || Object.keys(o).length !== 9 || typeof o.directory !== 'string' || typeof o.ledgerId !== 'string' || typeof o.writerId !== 'string'
    || !methods(o.anchor, ['read', 'advance']) || !methods(o.timeCheckpoint, ['accept']) || !methods(o.telemetry, ['emit']) || typeof o.evidence !== 'function') return;
  const config = c.value;
  const clock = createUbuntuChronyClock(config, o.chronycPath, o.timeCheckpoint);
  const secrets = createSystemdCredentialProvider(config, o.credentialDirectory);
  if (!clock || !secrets) return;
  const binding: Binding = { version: 'classification-operational-binding-v1', deploymentId: config.deploymentId,
    revision: config.revision, databaseName: config.databaseName, policyDigest: runtimePolicyDigest(config) };
  const ledger = await openLocalLedger({ directory: o.directory, ledgerId: o.ledgerId, writerId: o.writerId,
    anchor: o.anchor as IndependentAnchor, evidence: o.evidence as (q: EvidenceRequest, signal: AbortSignal) => Promise<unknown>,
    utc: async signal => {
      const r = plain(await clock.sample({ binding, requestId: randomUUID() }, signal),
        ['version', 'requestId', 'policyDigest', 'utcMilliseconds', 'uncertaintyMilliseconds']);
      if (!r || typeof r.utcMilliseconds !== 'number') throw Error('Ubuntu clock unavailable'); return r.utcMilliseconds;
    },
  });
  if (!ledger) return;
  return Object.freeze({ ledger, providers: Object.freeze({ version: 'classification-providers-v1', assurance: 'operator-verified',
    authority: ledger.authority, secrets, clock, telemetry: o.telemetry as RuntimeProviders['telemetry'] }) });
};
/** Caller installs SIGTERM handler in separately reviewed bootstrap. This function
 * never force-releases an admission, signals a PID or claims global DDL exclusion.
 * Failure means STOP; process/systemd fencing and uncertain writes need review. */
export const shutdownUbuntuRuntime = async (runtime: RuntimeControl, ledger: LocalLedger, timeoutMilliseconds = 5000): Promise<boolean> => {
  try {
    runtime.disableIssuance(); runtime.disableApply(); runtime.disableReconciliation();
    const gatesClosed = await ledger.setGates({ prepare: false, apply: false, reconcile: false });
    const drained = await runtime.shutdown(timeoutMilliseconds);
    if (!gatesClosed || !drained || !await ledger.enterMaintenance() || !await ledger.releaseWriter()) return false;
    ledger.close(); return true;
  } catch { return false; }
};
