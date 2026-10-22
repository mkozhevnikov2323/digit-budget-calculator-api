import type { Application } from 'express';
import type { Connection } from 'mongoose';
import { validateRuntimeConfiguration } from '../../domain/classification/runtimeConfiguration';
import { loadRuntimeKeyring } from '../../domain/classification/runtimeKeyPolicy';
import { installClassificationProtocol } from '../classificationProtocol';
import { createOperationalPorts, providerCall, validateProviders } from './ports';
import { classificationOperationalPreflight } from './preflight';
import { randomUUID } from 'node:crypto';

const runtimes = new WeakSet<Application>();
export type RuntimeControl = Readonly<{
  disableIssuance(): void; disableApply(): void; disableReconciliation(): void;
  drain(timeoutMilliseconds?: number): Promise<boolean>;
  shutdown(timeoutMilliseconds?: number): Promise<boolean>;
  localState(): Readonly<{ active: number; pending: number; unavailable: boolean }>;
}>;
export type InstallationResult = Readonly<{ ok: true; value: RuntimeControl }>
  | Readonly<{ ok: false; code: 'configuration_unavailable' | 'dependencies_unavailable' | 'runtime_unavailable' }>;

/** Explicit trusted composition root ONLY; app.ts/server.ts never call this.
 * Caller must provide all approved providers. No environment/URI/secret fallback,
 * startup DDL or automatic production key. Synthetic providers cannot be installed
 * as operational assurance. A provider contract alone is NOT real verification. */
export const installSecureClassificationRuntime = async (app: Application, connection: Connection,
  configuration: unknown, dependencies: unknown, scope: 'isolated-test' | 'operational'): Promise<InstallationResult> => {
  const checked = validateRuntimeConfiguration(configuration);
  if (!checked.ok) return { ok: false, code: 'configuration_unavailable' };
  const providers = validateProviders(dependencies, scope);
  if (!providers) return { ok: false, code: 'dependencies_unavailable' };
  if (runtimes.has(app)) return { ok: false, code: 'runtime_unavailable' };
  runtimes.add(app); // Reserve before async startup; two installers must not replace a live runtime.
  let installed = false;
  let ports: ReturnType<typeof createOperationalPorts> | undefined;
  try {
    const config = checked.value;
    ports = createOperationalPorts(config, providers, async evidence => (await classificationOperationalPreflight(connection, config, evidence)).ok);
    const raw = await providerCall(signal => providers.secrets.load({ binding: ports!.binding, requestId: randomUUID() }, signal));
    const keyring = loadRuntimeKeyring(config, raw);
    if (!keyring || !await ports.operations.ready('reconcile') || ports.localState().unavailable) return { ok: false, code: 'runtime_unavailable' };
    const operations = Object.freeze({ ...ports.operations,
      // Existing READ gate is an additional operator control, never health evidence.
      ready: (mode: 'prepare' | 'apply' | 'reconcile') => process.env.CLASSIFICATION_READ_ENABLED === '1' && ports!.operations.ready(mode),
    });
    const uninstall = installClassificationProtocol(app, connection, { keyring, deploymentId: config.deploymentId, operations });
    installed = true; const runtime = ports;
    const shutdown = async (timeoutMilliseconds?: number): Promise<boolean> => {
      // Recovery may remain available during a write-only drain. Full shutdown
      // first closes new recovery admissions as well, then waits for all leases.
      runtime.disableReconciliation();
      if (!await runtime.drain(timeoutMilliseconds)) return false;
      runtime.close(); uninstall(); runtimes.delete(app); return true;
    };
    return { ok: true, value: Object.freeze({ disableIssuance: runtime.disableIssuance, disableApply: runtime.disableApply,
      disableReconciliation: runtime.disableReconciliation, drain: runtime.drain, shutdown, localState: runtime.localState }) };
  } catch { return { ok: false, code: 'runtime_unavailable' }; }
  finally { if (!installed) { ports?.close(); runtimes.delete(app); } }
};
