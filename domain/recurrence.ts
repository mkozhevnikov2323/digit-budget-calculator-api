/** Pure recurrence observations. No IO, authorization, assignments or database access. */
export type Identity = Readonly<{ provenance: 'verified_id' | 'label_only'; value: string }>;
type Base = Readonly<{ id: string; ownerId: string; occurredAt: string }>;
export type Operation =
  | (Base & Readonly<{ dataset: 'expenses'; category: Identity | null; title: string; recipient: string }>)
  | (Base & Readonly<{ dataset: 'incomes'; source: string }>);
export type Input = Readonly<{
  ownerId: string; startMonth: string; endMonthExclusive: string;
  /** Proof of complete history from a trusted caller, NOT merely a fetched page. */
  completeMonths: readonly string[];
  operations: readonly Operation[];
}>;
export type Group = Readonly<{
  dataset: 'expenses' | 'incomes';
  level: 'category_or_source' | 'similar_expense';
  identity: Identity; title?: string; recipient?: string;
}>;
export type Evidence = Readonly<{
  group: Group; operationCount: number; activeMonthCount: number;
  activeMonths: readonly string[]; intervalsInMonths: readonly number[];
  longestConsecutiveMonths: number;
}>;
export type Result = Readonly<{
  version: 'observations-v0'; startMonth: string; endMonthExclusive: string;
  state: 'complete' | 'insufficient_coverage';
  missingMonths: readonly string[]; observations: readonly Evidence[];
}>;
const present = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const monthIndex = (x: string): number => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(x) || x.slice(0, 4) === '0000') throw new TypeError('Invalid UTC month');
  return Number(x.slice(0, 4)) * 12 + Number(x.slice(5)) - 1;
};
const monthText = (x: number): string =>
  String(Math.floor(x / 12)).padStart(4, '0') + '-' + String(x % 12 + 1).padStart(2, '0');
const utcMonth = (x: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)) throw new TypeError('Invalid UTC timestamp');
  const d = new Date(x);
  if (!Number.isFinite(d.getTime()) || d.toISOString() !== x || !d.getUTCFullYear())
    throw new TypeError('Invalid UTC timestamp');
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};
const validateIdentity = (x: Identity): void => {
  if (!x || (x.provenance !== 'verified_id' && x.provenance !== 'label_only') || !present(x.value))
    throw new TypeError('Invalid category identity');
};

/** Never infers "regular", roles, layers, yearly recurrence or confidence. */
export const analyzeRecurrence = (input: Input): Result => {
  if (!present(input.ownerId) || !Array.isArray(input.completeMonths) || !Array.isArray(input.operations))
    throw new TypeError('Invalid recurrence input');
  const start = monthIndex(input.startMonth), end = monthIndex(input.endMonthExclusive);
  // Defensive pure-engine bound, not an approved API lookback policy.
  if (end <= start || end - start > 120) throw new RangeError('Invalid recurrence window');
  const covered = new Set<number>();
  for (const value of input.completeMonths) {
    const index = monthIndex(value);
    if (index < start || index >= end || covered.has(index)) throw new TypeError('Invalid coverage months');
    covered.add(index);
  }
  const missingMonths: string[] = [];
  for (let i = start; i < end; i++) if (!covered.has(i)) missingMonths.push(monthText(i));
  const seen = new Set<string>();
  const groups = new Map<string, { group: Group; count: number; months: Set<number> }>();
  const add = (group: Group, month: number): void => {
    const key = JSON.stringify([group.dataset, group.level, group.identity.provenance,
      group.identity.value, group.title ?? null, group.recipient ?? null]);
    const entry = groups.get(key) ?? { group, count: 0, months: new Set<number>() };
    entry.count++;
    entry.months.add(month);
    groups.set(key, entry);
  };
  for (const op of input.operations) {
    if (!op || !present(op.id) || op.ownerId !== input.ownerId ||
      (op.dataset !== 'incomes' && op.dataset !== 'expenses'))
      throw new TypeError('Invalid owner or operation');
    const idKey = JSON.stringify([op.dataset, op.id]);
    if (seen.has(idKey)) throw new TypeError('Duplicate dataset operation ID');
    seen.add(idKey);
    const month = utcMonth(op.occurredAt);
    if (month < start || month >= end) throw new RangeError('Operation outside verified UTC window');
    if (op.dataset === 'expenses') {
      if (op.category !== null) {
        validateIdentity(op.category);
        add({ dataset: 'expenses', level: 'category_or_source', identity: op.category }, month);
        if (present(op.title) && present(op.recipient)) add({
          dataset: 'expenses', level: 'similar_expense', identity: op.category,
          title: op.title, recipient: op.recipient,
        }, month);
      }
    } else if (present(op.source)) {
      add({ dataset: 'incomes', level: 'category_or_source',
        identity: { provenance: 'label_only', value: op.source } }, month);
    }
  }
  if (missingMonths.length) return { version: 'observations-v0', startMonth: input.startMonth,
    endMonthExclusive: input.endMonthExclusive, state: 'insufficient_coverage',
    missingMonths, observations: [] };

  const observations: Evidence[] = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, entry]) => {
      const months = [...entry.months].sort((a, b) => a - b);
      let streak = months.length ? 1 : 0, longest = streak;
      const intervals: number[] = [];
      for (let i = 1; i < months.length; i++) {
        const gap = months[i] - months[i - 1];
        intervals.push(gap);
        streak = gap === 1 ? streak + 1 : 1;
        longest = Math.max(longest, streak);
      }
      return { group: entry.group, operationCount: entry.count,
        activeMonthCount: months.length, activeMonths: months.map(monthText),
        intervalsInMonths: intervals, longestConsecutiveMonths: longest };
    });
  return { version: 'observations-v0', startMonth: input.startMonth,
    endMonthExclusive: input.endMonthExclusive, state: 'complete', missingMonths: [], observations };
};
