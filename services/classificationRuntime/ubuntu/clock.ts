/** chrony health is necessary, not proof of trustworthy source configuration.
 * Requires a separately protected time-policy/high-water authority on every sample. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { plain, uint, runtimePolicyDigest, validateRuntimeConfiguration } from '../../../domain/classification/runtimeConfiguration';
import type { EvidenceRequest, ClockProvider } from '../contracts';
import { providerCall } from '../ports';
const uuid = (x: unknown): x is string => typeof x === 'string' && x.length === 36
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const exec = promisify(execFile);
const unavailable = () => Error('Ubuntu clock unavailable');
export type HostMeasurement = Readonly<{ bootId: string; wallMilliseconds: number; monotonicMilliseconds: number; bootMilliseconds: number }>;
export interface TimeCheckpoint {
  /** Must independently verify approved source/trust/policy/boot and monotonic UTC
   * high-water across process/host restart and snapshot restore; atomically accept
   * before acknowledging. No same-disk fake counter or flag fallback. */
  accept(request: EvidenceRequest & HostMeasurement & Readonly<{ uncertaintyMilliseconds: number }>, signal: AbortSignal): Promise<unknown>;
}
const measurement = (x: unknown): HostMeasurement | undefined => {
  const r = plain(x, ['bootId', 'wallMilliseconds', 'monotonicMilliseconds', 'bootMilliseconds']);
  return r && Object.keys(r).length === 4 && uuid(r.bootId) && uint(r.wallMilliseconds)
    && typeof r.monotonicMilliseconds === 'number' && Number.isFinite(r.monotonicMilliseconds) && r.monotonicMilliseconds >= 0
    && typeof r.bootMilliseconds === 'number' && Number.isFinite(r.bootMilliseconds) && r.bootMilliseconds >= 0 ? r as HostMeasurement : undefined;
};
const decimal = (s: string): number | undefined => {
  if (!s.length || s.length > 32 || !/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(s) || /[\r\n]/.test(s)) return;
  const n = Number(s); return Number.isFinite(n) && Math.abs(n) <= 1e12 ? n : undefined;
};
/** chronyc -n -c tracking: 14 fields, no quoting/names/locale interpretation.
 * Returns conservative error bound around the measured host wall time; it does
 * not pretend Date.now itself is independent UTC. Unknown formats fail closed. */
export const parseChronyTracking = (input: unknown, wallMilliseconds: number, elapsedMilliseconds: number): number | undefined => {
  if (typeof input !== 'string' || input.length > 4096 || !uint(wallMilliseconds) || !Number.isFinite(elapsedMilliseconds)
    || elapsedMilliseconds < 0 || elapsedMilliseconds > 800) return;
  const line = input.endsWith('\n') ? input.slice(0, -1) : input;
  if (/[\r\n]/.test(line)) return;
  const f = line.split(',');
  if (f.length !== 14 || f[0].length !== 8 || /[^A-F0-9]/.test(f[0]) || f[0] === '00000000' || f[0].startsWith('7F7F')
    || f[1].length > 255 || /[^A-Za-z0-9.:_-]/.test(f[1]) || f[13] !== 'Normal') return;
  const n = f.slice(2, 13).map(decimal);
  if (n.some(v => v === undefined)) return;
  const [stratum, ref, correction, last, rms, frequency, residual, skew, delay, dispersion, interval] = n as number[];
  const age = wallMilliseconds / 1000 - ref;
  if (!Number.isInteger(stratum) || stratum < 1 || stratum > 15 || age < -1 || age > 120 || rms < 0 || skew < 0
    || delay < 0 || dispersion < 0 || interval <= 0 || interval > 120 || Math.abs(correction) > 2
    || Math.abs(last) > 2 || Math.abs(frequency) > 100000 || Math.abs(residual) > 100000) return;
  const uncertainty = Math.ceil((Math.abs(correction) + Math.abs(last) + rms + delay / 2 + dispersion
    + Math.max(0, age) * skew / 1e6) * 1000 + elapsedMilliseconds + 10);
  return uncertainty <= 1000 ? uncertainty : undefined;
};
export const createClockHealthAdapter = (input: unknown, dependencies: unknown): ClockProvider | undefined => {
  const c = validateRuntimeConfiguration(input), d = plain(dependencies, ['checkpoint', 'readTracking', 'measure']);
  const a = d && plain(d.checkpoint, ['accept']);
  if (!c.ok || !d || Object.keys(d).length !== 3 || typeof d.readTracking !== 'function' || typeof d.measure !== 'function'
    || !a || Object.keys(a).length !== 1 || typeof a.accept !== 'function') return;
  const measure = d.measure as () => unknown, readTracking = d.readTracking as (signal: AbortSignal) => Promise<unknown>;
  const accept = a.accept as TimeCheckpoint['accept'], config = c.value, policyDigest = runtimePolicyDigest(config);
  let previous: HostMeasurement | undefined, poisoned = false, busy = false;
  const progress = (x: HostMeasurement, y: HostMeasurement) => x.bootId === y.bootId
    && y.wallMilliseconds >= x.wallMilliseconds && y.monotonicMilliseconds >= x.monotonicMilliseconds && y.bootMilliseconds >= x.bootMilliseconds
    && Math.abs(y.wallMilliseconds - x.wallMilliseconds - (y.monotonicMilliseconds - x.monotonicMilliseconds)) <= 2000
    && Math.abs(y.bootMilliseconds - x.bootMilliseconds - (y.monotonicMilliseconds - x.monotonicMilliseconds)) <= 2000;
  return Object.freeze({ async sample(q: EvidenceRequest, signal: AbortSignal) {
    if (poisoned || busy || signal.aborted) throw unavailable(); busy = true;
    try {
      const r = plain(q, ['binding', 'requestId']), b = r && plain(r.binding, ['version', 'deploymentId', 'revision', 'databaseName', 'policyDigest']);
      if (!r || Object.keys(r).length !== 2 || !uuid(r.requestId) || !b || Object.keys(b).length !== 5
        || b.version !== 'classification-operational-binding-v1' || b.policyDigest !== policyDigest || b.revision !== config.revision
        || b.databaseName !== config.databaseName || b.deploymentId !== config.deploymentId) throw unavailable();
      const before = measurement(measure()); if (!before) throw unavailable();
      const raw = await providerCall(abort => readTracking(abort));
      const after = measurement(measure()); if (!after) throw unavailable();
      if (!progress(before, after) || previous && !progress(previous, after)) { poisoned = true; throw unavailable(); }
      const uncertaintyMilliseconds = parseChronyTracking(raw, after.wallMilliseconds, after.monotonicMilliseconds - before.monotonicMilliseconds);
      if (uncertaintyMilliseconds === undefined) throw unavailable();
      const reply = await providerCall(abort => accept({ ...q, ...after, uncertaintyMilliseconds }, abort));
      const accepted = plain(reply, ['version', 'requestId', 'policyDigest', 'accepted']);
      const final = measurement(measure());
      if (!final || !progress(after, final)) { poisoned = true; throw unavailable(); }
      if (!accepted || Object.keys(accepted).length !== 4 || accepted.version !== 'classification-time-checkpoint-v1'
        || accepted.requestId !== q.requestId || accepted.policyDigest !== policyDigest || accepted.accepted !== true
        || final.monotonicMilliseconds - before.monotonicMilliseconds > 800 || signal.aborted) throw unavailable();
      const totalUncertainty = uncertaintyMilliseconds + Math.ceil(final.monotonicMilliseconds - after.monotonicMilliseconds);
      if (totalUncertainty > 1000) throw unavailable();
      previous = final;
      return { version: 'classification-clock-evidence-v1', requestId: q.requestId, policyDigest,
        utcMilliseconds: final.wallMilliseconds, uncertaintyMilliseconds: totalUncertainty };
    } catch { throw unavailable(); }
    finally { busy = false; }
  } });
};
/** Actual Ubuntu boundary; no shell, remote host, inherited secrets or health
 * inference from timedatectl. chronyc existence/config/source trust is preflight. */
export const createUbuntuChronyClock = (input: unknown, chronycPath: unknown, checkpoint: unknown): ClockProvider | undefined => {
  if (process.platform !== 'linux' || typeof chronycPath !== 'string' || !isAbsolute(chronycPath)) return;
  try {
    const s = lstatSync(chronycPath);
    if (realpathSync(chronycPath) !== chronycPath || !s.isFile() || s.uid !== 0 || s.mode & 0o022 || !(s.mode & 0o111)) return;
  } catch { return; }
  return createClockHealthAdapter(input, { checkpoint,
    async readTracking(signal: AbortSignal) {
      const result = await exec(chronycPath, ['-n', '-c', '-h', '127.0.0.1', '-p', '323', '-t', '1', 'tracking'],
        { timeout: 800, maxBuffer: 4096, killSignal: 'SIGKILL', encoding: 'utf8', env: { LC_ALL: 'C' }, signal });
      if (result.stderr.length) throw unavailable(); return result.stdout;
    },
    measure() {
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const uptime = readFileSync('/proc/uptime', 'utf8');
      if (uptime.length > 128 || !/^[0-9]+\.[0-9]+ [0-9]+\.[0-9]+\n$/.test(uptime)) throw unavailable();
      return { bootId, wallMilliseconds: Date.now(), monotonicMilliseconds: Number(process.hrtime.bigint()) / 1e6,
        bootMilliseconds: Number(uptime.split(' ')[0]) * 1000 };
    },
  });
};
