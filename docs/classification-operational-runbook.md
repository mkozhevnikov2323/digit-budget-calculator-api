# P11 operational adapter, prerequisites and operator runbook

**CODE READY / TESTED IN ISOLATION do not mean OPERATIONALLY VERIFIED or
PRODUCTION ACTIVATION APPROVED.** There is no production provider implementation,
provisioning, migration, flag change or deployment in this PR. See the baseline
[matrix](classification-runtime-readiness.md) and approved H1–H10 RFC.

## Composition and invariants

`installSecureClassificationRuntime(app, connection, unknownConfig,
unknownProviders, scope)` is an explicit asynchronous trusted composition root.
Neither `app.ts` nor `server.ts` imports/calls it. No environment object, key,
URI, default clock-health flag or production key is inferred. Missing/invalid
config/providers/preflight gives a safe code and does not affect unrelated routes.
Flags alone remain insufficient. Managed routes additionally require the exact
existing READ gate; prepare also requires healthy apply/recovery controls, and
apply requires healthy recovery controls. Partial readiness cannot issue proofs. Scope is mandatory: `operational` rejects
providers labelled `synthetic`; external operator verification still cannot be
established just by writing a string in JavaScript.

The configuration digest binds namespace, era, revision, all material identities
and windows. A trusted authority must compare this against its independently
protected durable current policy, never echo a caller's requested digest. An old
binary/config/partially rolled fleet instance becomes unavailable. No automatic
rollback, key reactivation or counter reset. Node crypto copies key buffers;
shutdown disables capabilities but does not prove heap zeroization. Heap/core-dump
controls and retained process memory are part of the external custody review. Same material under a new kid is not
a new issuance budget. A new incompatible restore requires a different proof era.
Retirement closes the previous issuing window at trusted retirement time (one
second granularity); no future 30-day issuing window remains on a retired key.

The existing codec now accepts an optional trusted key-policy callback after
GCM authentication of timestamps; AES-256-GCM/nonce/tag/AAD/wire/DTO/TTL/skew remain
unchanged. Existing callers without this optional port keep their original tested
codec behavior. The protocol has optional request-lifetime admission and closed
outcome callbacks. The CAS writer, authentication, taxonomy and models are unchanged.

Every managed HTTP prepare/apply/reconcile obtains a shared admission before any
financial observation, rechecks readiness, and releases only after the request's
work finishes (including unknown outcome). Duplicate begin is not a fresh grant.
Reservation uses a separate CSPRNG request ID, the fixed 2^20/material limit and
approved issue deadline; only a new `reserved` receipt authorizes encryption.
Timeout/abandonment/crypto failure still spends the reservation. Provider abort is
not rollback of an external side effect. Unknown begin/release poisons local
readiness and prevents a successful drain; it must be externally resolved.

Provider calls have a 1000ms deadline and AbortSignal. At most 32 provider calls,
readiness checks and pending admissions run per instance; overload fails closed.
Clock sampling is serialized to prevent legitimate out-of-order responses from
looking like rollback. This is bounded local resource protection, not a fleet rate
limit. No readiness success substitutes for a namespace lock. UTC samples remain
challenge/binding-specific and bounded; local Date.now alone is never evidence.

Readiness is checked at admission and again during protocol resolution, not as
a transactional commit deadline. A write admitted before emergency disablement,
revocation, time-health loss or shutdown may still commit. Never call that a
rollback or automatically retry a new command. Existing PATCH/DELETE/ABA and
current-record-only reconciliation limits are unchanged.

## Required external providers — no production adapters are supplied

All provider objects are explicit own-method records, not requests/env. Outputs
are versioned closed records tied to a fresh challenge and exact policy digest.
`contracts.ts` documents the required durability/exclusion semantics; shape
validation alone cannot prove provider truth or secret custody.

| Capability | Candidates and trade-offs | Required decision/evidence |
|---|---|---|
| Purpose-specific secrets | Existing approved vault/cloud secret manager with audited access, separate from JWT; envelope KMS retrieval may keep a short-lived raw AES key in application memory. Non-exportable HSM encryption would need a separately reviewed crypto adapter | Provider/RBAC/custody/rotation audit, cost and availability. None chosen/purchased |
| Shared authority and quota | Dedicated service over a transactional durable ledger or quorum store, independently protected from financial DB restore. Conditional consume plus immutable material identities, idempotency and monotonic policy/revocation checkpoints | Storage/schema/deployment/backup/anti-rollback approval; no such store is configured |
| Redis candidate | Lua/atomic operations alone are insufficient: eviction, asynchronous failover, persistence/restore can resurrect budget or locks | Separate deployment/durability design and dependency approval; no Redis added |
| Application MongoDB | Existing classification documents/lastMutation do not represent a fleet quota, tombstone archive or maintenance authority | New collection/schema is NOT approved; none added/reused |
| Trusted UTC health | Independently monitored authenticated host/time service with uncertainty, freshness and durable high-water/restart policy; NTP/chrony operational monitoring may feed a reviewed adapter | Trust root/transport, skew/jump monitoring and operator review; environment flag/HTTP Date alone is insufficient |
| Maintenance exclusion | Durable admissions coordinated with a privileged operator workflow that fences every possible writer and verifies database quiescence before DDL/restore | App lease must not auto-expire on pause/partition while a CAS can commit; external admin/network/session fencing and process roster required |
| Telemetry | Synchronous nonthrowing sink/approved bounded buffer for fixed enum events | External ingress/APM/proxy/SW/logging capture audit; no endpoint or external sink activated |

Tests use Maps only in `tests/helpers/operational-runtime.cjs`, labelled SYNTHETIC.
Two runtime instances and actual restarted child processes share a parent-held
authority. This models no-reset semantics but does not prove real crash durability,
replication, secret custody, clock accuracy or operator behavior. No production
implementation is hidden behind a test helper.

The conservative bounded keyring retains revocation tombstones. Before its 32-row
cap is exhausted, an independently reviewed durable archive/checkpoint design is
needed; silently pruning history or reusing material is forbidden.

## Non-mutating preflight

The explicit connection's connected/name/driver namespace must match config.
The existing `classificationReadiness` and **single existing manifest** check the
exact collection validator, enforcement, unique index/key order/collation. Operational
preflight additionally rejects extra options/indexes/build state, requires the
ordinary `_id` index, reads buildInfo/hello metadata, and rejects unsupported major
versions (currently tested MongoDB 7) and mongos routing. It never creates a
collection/index, reads user/financial documents, deletes/repairs or runs migration.
Errors expose only a closed code, no URI/name/user/driver message.

Actual FCV, unsharded namespace, required least privileges, backup/erasure/retention,
private external telemetry and administrative DDL/restore exclusion require the
trusted operator-evidence provider. They are UNVERIFIED in production. The app is
not granted getParameter/administrative DDL privileges just to inspect FCV; the
operator must independently inspect actual FCV and roles. Required application
classification access is find/insert/update with owner-scoped filters, plus source
and current-account reads; privileged schema maintenance is a separate identity.
No DML probes are used to test production privileges. Evidence must be current
and bound to this release/namespace, never a collection of environment booleans.

## Activation order — PROCEDURE ONLY, separately approved execution required

1. Approve actual environment/namespace, release SHAs, provider implementations,
   secret custody, time-health trust, durable quota/revocation history, maintenance
   exclusion, account/source-ID non-reuse, privacy/retention, backup and restore drill.
   Record which facts were independently verified and by whom; missing evidence STOP.
2. Keep all production write/review gates off. Inventory every process/version,
   background worker and financial writer. Verify real operator exclusion/fencing;
   an in-memory local controller cannot authorize administrative DDL.
3. With separately approved migration credentials and backups, inspect namespace.
   If missing, create ONLY the approved manifest's empty collection then named full
   unique index from the reviewed compiled manifest. On any existing nonempty or
   conflicting schema/index STOP; no deletion/deduplication/drop/recreate/repair.
   No source backfill or financial document migration is authorized here.
4. Re-run exact preflight/read-only dry run, including actual FCV/roles/topology.
   Verify backups and restored integrity/erasure replay/RPO/RTO in a disposable
   environment. Production bootstrap never performs these migration steps.
5. Provision dedicated keys out of band; publish the approved durable policy/era,
   distribute current verifier material to all compatible instances, verify clock
   evidence and fleet roster. Stale instances stay unavailable. This implementation
   prefers a controlled availability pause over accepting mixed policy revisions.
6. A separately reviewed deployment composition root may explicitly call the secure
   installer with `operational` providers. Verify recovery/read paths and diagnostics
   first. Only after separate activation approval enable global apply/issuance
   controls and exact existing feature flags. Verify a synthetic nonproduction smoke
   before any real rollout; do not turn test assurance into production evidence.

## Emergency disablement / drain / shutdown

1. Durably disable new issuance at shared authority on all instances; disable apply
   admissions too. Set existing REVIEW/WRITE flags off as additional local guards.
2. Locally invoke disableIssuance/disableApply or drain; keep read-only reconcile
   available with healthy keys/time/namespace and RECONCILE/READ gates as approved.
   Unknown outcome remains unknown; no automatic fresh write/ID/review.
3. `drain(timeout)` closes local prepare/apply admission and waits for pending/active
   request leases. It conservatively includes active recovery requests. Success is
   LOCAL only; sustained recovery traffic may require the full shutdown step.
4. For full shutdown call shutdown: close new reconciliation admission, drain all
   local work, release every shared lease, then uninstall. Invalid timeout, active,
   unknown or unreleased lease returns false. Do not override false with DDL or
   assume a killed process/expired TTL proves that MongoDB cannot still commit.
5. Independently verify global zero admissions/leases AND fence/stop all other
   financial writers and privileged administrators before DDL/restore/backup work.
   No automatic lease expiration or force-release policy is supplied. An orphan
   admission is an availability cost until an operator safely resolves it.

## Rotation, rollback and recovery

Normal rotation: global new issuance off -> drain affected writers -> provision
new material to all compatible verifiers -> publish a monotonic new policy with
one active issuer, closed old issue window and bounded verify-only key -> replace
managed runtimes explicitly -> verify roster/current evidence -> separately
approved enablement. Hold old material only for its permitted 300s apply / 24h
recovery windows; retire/revoke through a new current policy. Emergency revocation
invalidates old-policy instances immediately at their next readiness/admission
check, but cannot cancel already admitted/committed database work.

Rollback: issuance/apply off -> local and global drain/fence -> safe read-only
recovery while supported -> roll back compatible application binaries only.
Never restore an old authority policy, revoked key, quota counter or proof era
from an application backup. Incompatible code stays unavailable. Do not delete
classifications/indexes or restore old sources over newer real operations.

Backup/restore: quiesce all relevant writers, independently verify a consistent
sources/users/classifications/catalog backup and erasure/retention replay. Restore
first into a disposable environment; verify exact manifest, ownership/revisions,
source facts and checksums with restricted diagnostics. A controlled synthetic
BSON round-trip test demonstrates this ordering and new-era rejection only; it
is NOT a production backup tool or RPO/RTO verification. Preserve quota/revocation
history independently. After incompatible restore publish a strictly newer policy
and **new proof era**, fence old instances/proofs, re-run full preflight. Do not
claim restored lastMutation is a historical audit. Reconcile may be indeterminate;
missing/deleted account denies even old recovery. Account erasure must coordinate
all financial/classification writers and avoid identity reuse; current existence
checks alone do not close the deletion race or implement server session revocation.

## Privacy and test evidence

Operational events have only fixed `version` and closed enum `type`. No owner,
operation, amount, key ID, proof/JWT, fingerprint, namespace/URI, raw body/error or
high-cardinality labels can be serialized. Unknown event values are dropped and
poison readiness; sink failures never expose exception contents. No public metrics
route. B3g Winston policy is unchanged. External capture remains UNVERIFIED.

The existing Node test runner retains failure events and TAP parents. New tests
cover strict config/key/clock policy; shared quota concurrency, exhaustion,
restart, late reservations, unknown admission, drain/release failures, stale
configuration, revocation, actual HTTP/CAS/owner isolation, lost commit ack,
read-only recovery, no startup DDL/financial reads, exact preflight, and an owned
BSON restore/new-era drill. P10 now installs this same managed adapter with
synthetic providers while retaining all 14 unchanged browser scenarios and its
flags-only/default-off test. Frontend pins the exact reviewed backend SHA.

P11.1 adds optional concrete single-host adapters without activating this procedure:
see [Ubuntu operations](classification-ubuntu-operations.md). The earlier provider
candidate matrix records P11's baseline. SQLite alone still provides no whole-disk
anti-rollback; missing independent anchors intentionally block operational use.
