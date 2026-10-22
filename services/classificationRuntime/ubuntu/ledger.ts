/** Local durable authority. No bootstrap, env, key creation or MongoDB access.
 * The independently protected anchor is MANDATORY, including on every read.
 * SQLite alone cannot distinguish a valid old snapshot from current state. */
import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { plain, uint, digest, ISSUANCE_LIMIT, runtimePolicyDigest, validateRuntimeConfiguration,
  validateRuntimeTransition, type RuntimeConfiguration } from '../../../domain/classification/runtimeConfiguration';
import { deploymentEvidence, type SharedAuthority, type EvidenceRequest, type Binding } from '../contracts';
import { providerCall } from '../ports';

export type Checkpoint = Readonly<{ version: 'classification-local-checkpoint-v1'; ledgerId: string; sequence: number; commitment: string }>;
/** TRUSTED external boundary. Must serialize CAS durably outside this ledger's
 * disk/restore domain; forbid re-genesis/material reuse, retain tombstones and
 * check approved policy. A file on the same host is NOT an independent anchor.
 * Successful CAS is consumed even when the following SQLite commit fails. */
export interface IndependentAnchor {
  read(request: Readonly<{ ledgerId: string; requestId: string }>, signal: AbortSignal): Promise<unknown>;
  advance(request: Readonly<{ ledgerId: string; requestId: string; expected: Checkpoint | null; next: Checkpoint;
    policy: RuntimeConfiguration; approvalId: string | null }>, signal: AbortSignal): Promise<unknown>;
}
type Gates = { prepare: boolean; apply: boolean; reconcile: boolean };
type State = { config: RuntimeConfiguration; sequence: number; commitment: string; approvalId: string;
  nonce: string; gates: Gates; maintenance: boolean; writer: string | null; timeHighWater: number };
export type LocalLedgerOptions = Readonly<{ directory: string; ledgerId: string; writerId: string;
  anchor: IndependentAnchor; evidence(request: EvidenceRequest, signal: AbortSignal): Promise<unknown>;
  /** Must obtain fresh, rollback-checked UTC, never Date.now alone. */
  utc(signal: AbortSignal): Promise<number> }>;
const unavailable = () => Error('Local authority unavailable');
export const uuid = (x: unknown): x is string => typeof x === 'string' && x.length === 36
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const exact = (x: unknown, fields: string[]) => { const r = plain(x, fields); return r && Object.keys(r).length === fields.length ? r : undefined; };
const checkpoint = (x: unknown): Checkpoint | undefined => {
  const r = exact(x, ['version', 'ledgerId', 'sequence', 'commitment']);
  return r?.version === 'classification-local-checkpoint-v1' && uuid(r.ledgerId) && uint(r.sequence) && r.sequence > 0 && digest(r.commitment)
    ? r as Checkpoint : undefined;
};
const same = (a: Checkpoint | null, b: Checkpoint | null) => a === null ? b === null : !!b
  && a.ledgerId === b.ledgerId && a.sequence === b.sequence && a.commitment === b.commitment;
export const privateDirectory = (path: unknown): path is string => {
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || realpathSync(path) !== path) return false;
    const s = lstatSync(path);
    return s.isDirectory() && !s.isSymbolicLink() && s.uid === process.geteuid?.() && (s.mode & 0o777) === 0o700;
  } catch { return false; }
};
const ownedFile = (path: string) => {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.geteuid?.() || (s.mode & 0o777) !== 0o600) throw unavailable();
  return s;
};
const bindingFor = (c: RuntimeConfiguration): Binding => ({ version: 'classification-operational-binding-v1', deploymentId: c.deploymentId,
  revision: c.revision, databaseName: c.databaseName, policyDigest: runtimePolicyDigest(c) });
const schema = `
CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL) STRICT;
CREATE TABLE materials (identity TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK(used>=0 AND used<=1048576)) STRICT;
CREATE TABLE requests (id TEXT PRIMARY KEY, material TEXT NOT NULL REFERENCES materials(identity), ordinal INTEGER NOT NULL CHECK(ordinal>0 AND ordinal<=1048576)) STRICT;
CREATE TABLE admissions (id TEXT PRIMARY KEY, writer TEXT NOT NULL, digest TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('prepare','apply','reconcile')), closed INTEGER NOT NULL CHECK(closed IN (0,1))) STRICT;
PRAGMA user_version=1;`;

/** Explicit genesis only. Approval is metadata for the anchor to verify, not a
 * boolean claim that an existing active material has never been used. Failure
 * leaves the file for operator investigation; never delete/retry automatically. */
export const initializeLocalLedger = async (options: LocalLedgerOptions, input: unknown, approvalId: unknown): Promise<boolean> => {
  let db: DatabaseSync | undefined;
  try {
    if (!validOptions(options) || !uuid(approvalId)) return false;
    const c = validateRuntimeConfiguration(input); if (!c.ok) return false;
    const path = join(options.directory, 'authority.sqlite');
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const directoryFd = openSync(options.directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    db = new DatabaseSync(path); configure(db); db.exec('BEGIN IMMEDIATE'); db.exec(schema);
    const state: State = { config: c.value, sequence: 1, commitment: createHash('sha256').update(JSON.stringify([
      'classification-local-genesis-v1', options.ledgerId, approvalId, runtimePolicyDigest(c.value), randomUUID()])).digest('hex'),
      approvalId, nonce: randomUUID(), gates: { prepare: false, apply: false, reconcile: false }, maintenance: true, writer: null, timeHighWater: 0 };
    db.prepare('INSERT INTO metadata VALUES(1,?)').run(JSON.stringify(state));
    for (const key of c.value.keys) db.prepare('INSERT INTO materials VALUES(?,0)').run(key.materialId);
    state.commitment = seal(db, options, state);
    db.prepare('UPDATE metadata SET state=? WHERE id=1').run(JSON.stringify(state));
    const next = cp(options, state);
    const result = await providerCall(signal => options.anchor.advance({ ledgerId: options.ledgerId, requestId: randomUUID(),
      expected: null, next, policy: state.config, approvalId }, signal));
    if (!same(checkpoint(result) ?? null, next)) throw unavailable();
    db.exec('COMMIT'); return true;
  } catch { try { db?.exec('ROLLBACK'); } catch { /* Code-only failure. */ } return false; }
  finally { try { db?.close(); } catch { /* Safe failure only. */ } }
};
const seal = (db: DatabaseSync, o: LocalLedgerOptions, s: State): string => createHash('sha256').update(JSON.stringify([
  'classification-local-state-v1', o.ledgerId, { ...s, commitment: null },
  db.prepare('SELECT identity,used FROM materials ORDER BY identity').all(),
  db.prepare('SELECT id,writer,digest,mode FROM admissions WHERE closed=0 ORDER BY id').all(),
])).digest('hex');
const cp = (o: LocalLedgerOptions, s: State): Checkpoint => ({ version: 'classification-local-checkpoint-v1', ledgerId: o.ledgerId, sequence: s.sequence, commitment: s.commitment });
const validOptions = (o: LocalLedgerOptions) => {
  const r = exact(o, ['directory', 'ledgerId', 'writerId', 'anchor', 'evidence', 'utc']);
  const a = r && exact(r.anchor, ['read', 'advance']);
  return process.platform === 'linux' && !!r && privateDirectory(r.directory) && uuid(r.ledgerId) && uuid(r.writerId)
    && typeof r.evidence === 'function' && typeof r.utc === 'function' && !!a && typeof a.read === 'function' && typeof a.advance === 'function';
};
const configure = (db: DatabaseSync) => {
  db.exec('PRAGMA busy_timeout=50; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
  if (db.prepare('PRAGMA synchronous').get()?.synchronous !== 3 || db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete'
    || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw unavailable();
};
export type LocalLedger = Readonly<{ authority: SharedAuthority; claimWriter(): Promise<boolean>; releaseWriter(): Promise<boolean>;
  setGates(input: unknown): Promise<boolean>; enterMaintenance(): Promise<boolean>;
  publish(input: unknown, incompatibleRestore?: boolean): Promise<boolean>;
  status(): Promise<Readonly<{ active: number; writerClaimed: boolean; maintenance: boolean }> | undefined>;
  close(): void }>;

export const openLocalLedger = async (options: LocalLedgerOptions): Promise<LocalLedger | undefined> => {
  let db: DatabaseSync | undefined;
  try {
    if (!validOptions(options)) return;
    const path = join(options.directory, 'authority.sqlite'), inode = ownedFile(path);
    db = new DatabaseSync(path, { allowExtension: false }); configure(db);
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1 || db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') throw unavailable();
    const sql = db; let closed = false, poisoned = false, busy = false, waiting = 0;
    let queue: Promise<unknown> = Promise.resolve();
    const read = (): State => {
      const raw = sql.prepare('SELECT state FROM metadata WHERE id=1').get()?.state;
      if (typeof raw !== 'string' || raw.length > 32768) throw unavailable();
      const r = exact(JSON.parse(raw), ['config', 'sequence', 'commitment', 'approvalId', 'gates', 'maintenance', 'writer', 'timeHighWater', 'nonce']);
      const c = validateRuntimeConfiguration(r?.config), g = r && exact(r.gates, ['prepare', 'apply', 'reconcile']);
      if (!r || !c.ok || !uint(r.sequence) || r.sequence < 1 || !digest(r.commitment) || !uuid(r.approvalId) || !g
        || Object.values(g).some(v => typeof v !== 'boolean') || typeof r.maintenance !== 'boolean'
        || !uuid(r.nonce) || !(r.writer === null || uuid(r.writer)) || !uint(r.timeHighWater)) throw unavailable();
      return { ...r, config: c.value, gates: g } as State;
    };
    const verify = async (s: State) => {
      const st = ownedFile(path);
      if (!privateDirectory(options.directory) || st.dev !== inode.dev || st.ino !== inode.ino) throw unavailable();
      if (seal(sql, options, s) !== s.commitment) throw unavailable();
      const remote = await providerCall(signal => options.anchor.read({ ledgerId: options.ledgerId, requestId: randomUUID() }, signal));
      if (!same(cp(options, s), checkpoint(remote) ?? null)) throw unavailable();
    };
    /** Hold the SQLite write lock across independent CAS. No JS mutex is used
     * for cross-process exclusion. Anchor-ahead/SQLite-behind permanently blocks
     * reopening until a separately approved fenced recovery; no auto repair. */
    const execute = async <T>(work: (s: State) => Promise<T>, mutate: boolean): Promise<T> => {
      if (closed || poisoned || busy) throw unavailable(); busy = true;
      try {
        sql.exec('BEGIN IMMEDIATE'); const s = read(); await verify(s); const expected = cp(options, s);
        const result = await work(s);
        if (mutate) {
          if (s.sequence >= Number.MAX_SAFE_INTEGER) throw unavailable();
          s.sequence++; s.nonce = randomUUID(); s.commitment = seal(sql, options, s);
          sql.prepare('UPDATE metadata SET state=? WHERE id=1').run(JSON.stringify(s));
          const next = cp(options, s), advanced = await providerCall(signal => options.anchor.advance({ ledgerId: options.ledgerId,
            requestId: randomUUID(), expected, next, policy: s.config, approvalId: null }, signal));
          if (!same(next, checkpoint(advanced) ?? null)) throw unavailable();
        }
        sql.exec('COMMIT'); return result;
      } catch { try { sql.exec('ROLLBACK'); } catch { /* Never pretend rollback of anchor. */ } poisoned = true; throw unavailable(); }
      finally { busy = false; }
    };
    const transaction = <T>(work: (s: State) => Promise<T>, mutate: boolean): Promise<T> => {
      if (closed || poisoned || waiting >= 32) return Promise.reject(unavailable());
      waiting++;
      const result = queue.then(() => execute(work, mutate));
      queue = result.then(() => {}, () => {});
      return result.finally(() => { waiting--; });
    };
    await transaction(async () => true, false);
    const current = (s: State, q: EvidenceRequest) => {
      const r = plain(q, ['binding', 'requestId', 'mode', 'materialId', 'maximum', 'issueUntil']);
      const b = r && exact(r.binding, ['version', 'deploymentId', 'revision', 'policyDigest', 'databaseName']);
      return !!r && uuid(r.requestId) && !!b && Object.entries(bindingFor(s.config)).every(([key, value]) => b[key] === value);
    };
    const receipt = (q: EvidenceRequest, version: string, extra: object) => ({ version, requestId: q.requestId, policyDigest: q.binding.policyDigest, ...extra });
    const count = () => Number(sql.prepare('SELECT count(*) AS n FROM admissions WHERE closed=0').get()!.n);
    const owned = (s: State) => s.writer === options.writerId;
    const now = async (s: State, signal: AbortSignal) => {
      const t = await providerCall(abort => options.utc(abort));
      if (!uint(t) || t < s.timeHighWater) throw unavailable(); s.timeHighWater = t; return Math.floor(t / 1000);
    };
    const authority: SharedAuthority = {
      async attest(q, signal) {
        if (signal.aborted || !exact(q, ['binding', 'requestId'])) throw unavailable();
        return transaction(async s => {
          if (!current(s, q) || !owned(s)) return undefined;
          const d = deploymentEvidence(await providerCall(abort => options.evidence(q, abort)));
          if (!d) throw unavailable();
          return receipt(q, 'classification-authority-evidence-v1', { deployment: d,
            ...Object.fromEntries(Object.entries(s.gates).map(([k, v]) => [k, v && !s.maintenance])) });
        }, false);
      },
      async begin(q, signal) {
        if (signal.aborted || !exact(q, ['binding', 'requestId', 'mode']) || !uuid(q.requestId) || !exact(q.binding, ['version', 'deploymentId', 'revision', 'policyDigest', 'databaseName'])) throw unavailable();
        return transaction(async s => {
          const exists = sql.prepare('SELECT id FROM admissions WHERE id=?').get(q.requestId);
          const allowed = current(s, q) && owned(s) && ['prepare', 'apply', 'reconcile'].includes(q.mode) && s.gates[q.mode] && !s.maintenance && count() < 32;
          const state = !allowed ? 'denied' : exists ? 'duplicate' : 'admitted';
          if (state === 'admitted') sql.prepare('INSERT INTO admissions VALUES(?,?,?,?,0)').run(q.requestId, options.writerId, q.binding.policyDigest, q.mode);
          return receipt(q, 'classification-lease-v1', { state });
        }, true);
      },
      async end(q, signal) {
        if (signal.aborted || !exact(q, ['binding', 'requestId', 'mode']) || !uuid(q.requestId) || !exact(q.binding, ['version', 'deploymentId', 'revision', 'policyDigest', 'databaseName'])) throw unavailable();
        return transaction(async () => {
          const row = sql.prepare('SELECT * FROM admissions WHERE id=?').get(q.requestId);
          if (!row || row.writer !== options.writerId || row.digest !== q.binding.policyDigest || row.mode !== q.mode) throw unavailable();
          sql.prepare('UPDATE admissions SET closed=1 WHERE id=?').run(q.requestId);
          return receipt(q, 'classification-lease-v1', { state: 'closed' });
        }, true);
      },
      async reserve(q, signal) {
        if (signal.aborted || !exact(q, ['binding', 'requestId', 'materialId', 'maximum', 'issueUntil']) || !uuid(q.requestId) || !digest(q.materialId) || !exact(q.binding, ['version', 'deploymentId', 'revision', 'policyDigest', 'databaseName'])) throw unavailable();
        return transaction(async s => {
          const key = s.config.keys.find(k => k.kid === s.config.issuingKid);
          let ordinal = Number(sql.prepare('SELECT used FROM materials WHERE identity=?').get(q.materialId)?.used ?? 0), state = 'denied';
          if (sql.prepare('SELECT id FROM requests WHERE id=?').get(q.requestId)) state = 'duplicate';
          else if (current(s, q) && owned(s) && !s.maintenance && s.gates.prepare && s.gates.apply && s.gates.reconcile && key?.state === 'active'
            && key.materialId === q.materialId && q.maximum === ISSUANCE_LIMIT && q.issueUntil === key.issueUntil) {
            const utc = await now(s, signal);
            if (utc >= key.issueFrom && utc < key.issueUntil) {
              if (ordinal >= ISSUANCE_LIMIT) state = 'exhausted';
              else { ordinal++; state = 'reserved';
                sql.prepare('UPDATE materials SET used=? WHERE identity=?').run(ordinal, q.materialId);
                sql.prepare('INSERT INTO requests VALUES(?,?,?)').run(q.requestId, q.materialId, ordinal);
              }
            }
          }
          return receipt(q, 'classification-reservation-v1', { materialId: q.materialId, ordinal, state });
        }, true);
      },
    };
    const safe = async (work: (s: State) => Promise<boolean>) => { try { return await transaction(work, true); } catch { return false; } };
    return Object.freeze({ authority,
      claimWriter: () => safe(async s => { if (s.writer !== null && !owned(s)) return false; s.writer = options.writerId; return true; }),
      releaseWriter: () => safe(async s => { if (!owned(s) || count() || Object.values(s.gates).some(Boolean)) return false; s.writer = null; return true; }),
      setGates: input => safe(async s => {
        const g = exact(input, ['prepare', 'apply', 'reconcile']);
        if (!owned(s) || !g || Object.values(g).some(v => typeof v !== 'boolean')) return false;
        s.gates = g as Gates; if (Object.values(s.gates).some(Boolean)) s.maintenance = false; return true;
      }),
      enterMaintenance: () => safe(async s => { if (!owned(s) || Object.values(s.gates).some(Boolean) || count()) return false; s.maintenance = true; return true; }),
      publish: (input, incompatibleRestore = false) => safe(async s => {
        const t = await now(s, new AbortController().signal);
        if (!owned(s) || !s.maintenance || count() || !validateRuntimeTransition(s.config, input, incompatibleRestore, t)) return false;
        const c = validateRuntimeConfiguration(input); if (!c.ok) return false;
        for (const k of c.value.keys) sql.prepare('INSERT OR IGNORE INTO materials VALUES(?,0)').run(k.materialId);
        s.config = c.value; return true;
      }),
      async status() { try { return await transaction(async s => ({ active: count(), writerClaimed: s.writer !== null, maintenance: s.maintenance }), false); } catch { return undefined; } },
      close() { if (busy || waiting) throw unavailable(); closed = true; sql.close(); },
    });
  } catch { try { db?.close(); } catch { /* Stable failure only. */ } return undefined; }
};
