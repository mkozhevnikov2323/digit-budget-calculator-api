import { plain, uint } from './runtimeConfiguration';
export type LocalClock = () => Readonly<{ wallMilliseconds: number; monotonicMilliseconds: number }>;
export const CLOCK_EVIDENCE_TTL_MS = 5000;
const MAX_SKEW_MS = 2000, MAX_UNCERTAINTY_MS = 1000;
/** External sample freshness does not come from an environment flag. Defaults
 * measure only LOCAL time; caller still must obtain fresh trusted UTC evidence. */
export const createRuntimeClock = (local: LocalClock = () => ({ wallMilliseconds: Date.now(), monotonicMilliseconds: performance.now() })) => {
  let sample: { utc: number; wall: number; mono: number } | undefined, poisoned = false, fresh = false;
  const read = () => {
    try {
      const x = local();
      return uint(x.wallMilliseconds) && typeof x.monotonicMilliseconds === 'number'
        && Number.isFinite(x.monotonicMilliseconds) && x.monotonicMilliseconds >= 0 ? x : undefined;
    } catch { return undefined; }
  };
  const health = () => {
    const x = read();
    if (!x || !sample || poisoned || !fresh) return undefined;
    const elapsed = x.monotonicMilliseconds - sample.mono, wallDelta = x.wallMilliseconds - sample.wall;
    if (elapsed < 0 || wallDelta < 0 || Math.abs(wallDelta - elapsed) > MAX_SKEW_MS) { poisoned = true; return undefined; }
    return elapsed <= CLOCK_EVIDENCE_TTL_MS ? { x, elapsed } : undefined;
  };
  return Object.freeze({
    invalidate() { fresh = false; },
    accept(input: unknown, requestId: string, policyDigest: string): boolean {
      const r = plain(input, ['version', 'requestId', 'policyDigest', 'utcMilliseconds', 'uncertaintyMilliseconds']);
      const x = read();
      if (!x || poisoned || !r || Object.keys(r).length !== 5 || r.version !== 'classification-clock-evidence-v1'
        || r.requestId !== requestId || r.policyDigest !== policyDigest || !uint(r.utcMilliseconds)
        || !uint(r.uncertaintyMilliseconds) || r.uncertaintyMilliseconds > MAX_UNCERTAINTY_MS
        || Math.abs(x.wallMilliseconds - r.utcMilliseconds) > MAX_SKEW_MS) { fresh = false; return false; }
      if (sample) {
        const elapsed = x.monotonicMilliseconds - sample.mono;
        if (elapsed < 0 || x.wallMilliseconds < sample.wall || Math.abs(x.wallMilliseconds - sample.wall - elapsed) > MAX_SKEW_MS
          || r.utcMilliseconds < sample.utc || Math.abs(r.utcMilliseconds - sample.utc - elapsed) > MAX_SKEW_MS) {
          poisoned = true; fresh = false; return false;
        }
      }
      sample = { utc: r.utcMilliseconds, wall: x.wallMilliseconds, mono: x.monotonicMilliseconds }; fresh = true; return true;
    },
    nowSeconds(): number {
      const h = health(); return h && sample ? Math.floor((sample.utc + h.elapsed) / 1000) : NaN;
    },
  });
};
