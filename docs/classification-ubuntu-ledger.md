# P11.1 local authority: design and activation boundary

## Baseline and reuse

P11 PR31 verified head `61f5f55e2f1cf6cff3a5db87d2d7c03bc463d172`
is the dependent base (P11 PR30/31 remain open). The existing strict configuration,
material identity, lifecycle transitions, bounded clock, operational port receipts,
secure installer, request-lifetime protocol hooks, exact MongoDB manifest/preflight
and privacy enum are reused. Neither app.ts nor server.ts is changed or wired.
Missing pieces were durable local reservations/admissions, credential custody,
actual time-health evidence and Ubuntu operator procedures. Host facts remain unknown.

## SQLite choice

Use built-in `node:sqlite` on **Node 22.16+**, tested with 22.23.3 (SQLite 3.51.3).
The API remains experimental in Node22; review the exact release on deployment.
No dependency, lockfile or native addon change. `better-sqlite3` is maintained but
adds ABI/prebuild/compiler/install-script risks; sqlite3 adds similar native build
requirements and callback complexity. A sqlite CLI subprocess adds another binary
and protocol boundary. Built-in DatabaseSync keeps SQL parameterized and bounded;
a 50ms busy timeout limits event-loop blocking. Independent CAS has the existing
1000ms provider timeout; lock contention fails closed rather than retrying secretly.
For high concurrency move this implementation behind a dedicated local service/
worker with a reviewed IPC boundary; do not replace cross-process locks with a JS mutex.

`journal_mode=DELETE`, `synchronous=EXTRA` (3, FULL plus directory synchronization
on rollback-journal unlink), foreign_keys=ON, trusted_schema=OFF, extensions disabled.
Settings are verified on every connection. WAL is deliberately not used: this
small single-writer ledger benefits from simpler recovery and no live WAL/checkpoint
copy hazards. SQLite guarantees depend on reliable fsync, filesystem locks and
storage honoring flushes; cloud temporary-directory tests cannot prove power-loss
behavior on the owner's disk. Reject network filesystems/unreviewed mounts.

Explicit private existing directory (0700, effective service UID, canonical absolute
path); regular owned 0600 single-link SQLite file, no symlink. Initial file and
parent directory are fsynced. Revalidate permissions and inode every operation.
Protect parent directories/ACLs/mount namespace out of band: these checks do not
fence root or a hostile process running as the same UID. No automatic chmod,
directory creation, corruption deletion, empty-ledger fallback or repair.

Schema v1: metadata current closed policy/revision/era/gates/writer/time high-water/
checkpoint; materials lifetime counts <=1048576; requests durable unique reservation
IDs/material/ordinal; admissions unique IDs/writer/digest/mode/closed tombstones.
A partial index on active admissions bounds drain/readiness scans despite retained
closed tombstones; it is created only at explicit genesis, never repaired on open.
SQL CHECK/UNIQUE constraints complement the approved runtime validation. No MongoDB
operational collection is used. SQLite quick_check rejects observed corruption;
this is not an exhaustive media-health or malicious-root integrity proof.

## Independent anti-rollback boundary: REQUIRED, not implemented infrastructure

`IndependentAnchor.read/advance` must be a trusted authenticated, durably serialized
CAS service/checkpoint mechanism OUTSIDE the ledger/whole-host restore domain.
Read returns the exact current version/ledgerId/sequence/commitment; advance accepts
expected -> next and returns only the durable accepted checkpoint. Calls have fresh
request IDs. The adapter is trusted to authenticate transport, reject replay, retain
its own history and enforce approved policy, material uniqueness and genesis approval.
It must never grant a previously used material a new ledger/genesis identity.
A same-disk file, SQLite high-water row, local backup or operator boolean is insufficient.
No such external service/hardware exists or is claimed to exist on the home host.
The in-memory/IPC anchor exists ONLY in disposable tests and cannot be selected by
production bootstrap. Missing/inconsistent anchor makes opening/readiness fail closed.

Each operation obtains BEGIN IMMEDIATE, validates the independent checkpoint and
sealed policy/material counts/active leases, mutates SQL, advances the independent
checkpoint BEFORE SQLite COMMIT, then acknowledges. A reservation is not permission
to encrypt until both succeed. Anchor-ahead/SQL-behind (crash, power loss, failed
commit or lost acknowledgment) BLOCKS future use. No automatic resynchronization:
this intentionally trades availability for nonce safety. A valid old disk snapshot
has an old sequence/commitment and is rejected. Checkpointing only periodically
would resurrect budget between checkpoints; this implementation does not do that.

Explicit initializeLocalLedger requires an operator approval UUID. The anchor must
verify that approval and genuinely fresh/never-used materials out of band. An active
key in a config is never evidence of freshness. Failed genesis leaves the file for
investigation; ordinary open never creates a replacement. Approval metadata contains
no keys. Tests use random disposable keys and synthetic approvals only.

## Admission, restart and maintenance

One durable approved writer identity bound to kernel boot ID, PID and process start
ticks; even a copied configuration ID cannot claim another process's admissions/controls.
A duplicate claim is rejected. Independent claim cannot replace it. Systemd
must supply fresh identity per actual writer incarnation through reviewed composition.
It is an internal capability selector, NOT full OS fencing or authentication;
hostile same-UID code/root or copied credentials are outside its protection. Tests may share an approved
identity across trusted quota-only workers to exercise independent SQLite connections;
such workers cannot attest/admit HTTP work, close another process's lease or administer
gates. Their shared quota never grants financial write admission. A killed writer
incarnation remains blocked for the next process, even if its PID is later reused.

Request leases survive restart and have NO TTL. Closed IDs remain tombstones.
Unknown release fails; SIGKILL does not free a lease or writer. Clean shutdown:
close gates, runtime shutdown/drain, verify no active leases, enter maintenance,
release writer, close connection. A new process cannot steal an orphan writer.
Operator must independently fence all old processes/DB sessions and privileged
actors before separately approved reconciliation of orphan state. No force-release
or recovery-deletion tool is provided. Restart=on-failure therefore cannot silently
reactivate the secure runtime after an uncertain crash; legacy routes stay separate.

Policy publish requires maintenance, zero leases and monotonic P11 transition checks;
material counts/history are retained across rotation/era changes. Revoked keys cannot
reactivate. Reservations use exactly the approved active material and issue window,
consume before encryption, never refund, deny duplicate IDs and cap at 2^20.
Clock high-water persists locally AND is sealed by the independent checkpoint.
It does not replace credible fresh UTC evidence.

No compaction/pruning is implemented. Up to 32 retained materials, potentially 32M
reservation rows: measure disk capacity and latency before approval; do not delete
history to recover space. Storage failure blocks availability. Archive/checkpoint
policy and orphan resolution require separate review.

## Verification limits

Disposable real SQLite, independent connections/processes, real SIGKILL, restarted
reservation deduplication, admissions/drain, snapshot replacement, missing anchor,
lost acknowledgment, corruption, permission rejection, busy transaction, and bounded
SQL write-error injection. Write-error injection is not a physical disk-full/power-cut
qualification. Owner filesystem, ACLs, backup domain, service UID, fsync device and
external anchor remain UNVERIFIED. All operational activation remains default-off.
