/** Proposed disconnected bounded read request. Shape is NOT authorization.
 * No handler/service/connection/gate is registered or implemented here. */
import { types } from 'node:util';
import { validateOperationIdentity, type Dataset } from '../classification';
import { readWriteFields } from './writeCommand';

export const HISTORY_READ_REQUEST_VERSION = 'classification-history-read-request-v1' as const;
export const HISTORY_READ_MAX_OPERATIONS = 100;
type Operation = Readonly<{ dataset: Dataset; operationId: string }>;
export type HistoryReadRequest = Readonly<{ version: typeof HISTORY_READ_REQUEST_VERSION;
  startInclusive: number; endExclusive: number; operations: readonly Operation[] }>;
type Result = Readonly<{ ok: true; value: HistoryReadRequest }>
  | Readonly<{ ok: false; error: Readonly<{ code: 'invalid_history_read_request' }> }>;
const failure = (): Result => ({ ok: false, error: { code: 'invalid_history_read_request' } });
const fields = (x: unknown, allowed: readonly string[]) => types.isProxy(x) ? undefined : readWriteFields(x, allowed);
const midnight = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x)
  && x >= -62135596800000 && x <= 253402300800000 && x % 86400000 === 0;

/** Only the future trusted HTTP boundary may authenticate/derive owner. A valid
 * result proves a bounded requested identity set, never ownership/completeness. */
export const validateHistoryReadRequest = (input: unknown): Result => {
  try {
    const r = fields(input, ['version', 'startInclusive', 'endExclusive', 'operations']);
    if (!r || r.version !== HISTORY_READ_REQUEST_VERSION || !midnight(r.startInclusive) || !midnight(r.endExclusive)
      || r.startInclusive >= r.endExclusive || types.isProxy(r.operations) || !Array.isArray(r.operations)
      || Object.getPrototypeOf(r.operations) !== Array.prototype || r.operations.length < 1
      || r.operations.length > HISTORY_READ_MAX_OPERATIONS || Reflect.ownKeys(r.operations).length !== r.operations.length + 1) return failure();
    const operations: Operation[] = [], seen = new Set<string>();
    for (let i = 0; i < r.operations.length; i++) {
      const d = Object.getOwnPropertyDescriptor(r.operations, String(i));
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return failure();
      const op = fields(d.value, ['dataset', 'operationId']);
      if (!op) return failure();
      // Dummy owner validates identity syntax only; it supplies no authority.
      const checked = validateOperationIdentity({ owner: '000000000000000000000000', dataset: op.dataset, operationId: op.operationId });
      if (!checked.ok) return failure();
      const operationId = checked.value.operationId.toLowerCase(), dataset = checked.value.dataset, key = `${dataset}/${operationId}`;
      if (seen.has(key)) return failure(); seen.add(key);
      operations.push(Object.freeze({ dataset, operationId }));
    }
    return { ok: true, value: Object.freeze({ version: HISTORY_READ_REQUEST_VERSION, startInclusive: r.startInclusive,
      endExclusive: r.endExclusive, operations: Object.freeze(operations) }) };
  } catch { return failure(); }
};
