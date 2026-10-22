/** Bounded per-instance abuse protection. NOT fleet nonce accounting or governance. */
const windows = new Map<string, { until: number; used: number; active: number }>();
let activeTotal = 0;
export const admitClassificationRead = (owner: string, now = Date.now()): (() => void) | null => {
  for (const [key, value] of windows) if (value.until <= now && value.active === 0) windows.delete(key);
  let entry = windows.get(owner);
  if (!entry) {
    if (windows.size >= 4096) return null;
    entry = { until: now + 60000, used: 0, active: 0 }; windows.set(owner, entry);
  }
  if (entry.until <= now) { entry.until = now + 60000; entry.used = 0; }
  if (entry.used >= 600 || entry.active >= 4 || activeTotal >= 16) return null;
  entry.used++; entry.active++; activeTotal++;
  let released = false;
  return () => { if (!released) { released = true; entry.active--; activeTotal--; } };
};
