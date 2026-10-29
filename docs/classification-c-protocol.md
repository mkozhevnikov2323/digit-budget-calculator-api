# P11-C1 — process-local manual classification protocol

Architecture C is additive. P11 `/reviews`, `/commands`, `/commands/reconcile`
are unchanged; no proof runtime/provider is installed or bypassed.
`CLASSIFICATION_C_WRITE_ENABLED=1` is the new explicit gate (absent means off).
No connection, migration, collection creation, key provisioning or activation is
performed at import/startup. A separately approved deployment must verify the
existing classification manifest/index and single-host operational safeguards.

## Contract

All endpoints are POST, behind the existing JWT guard, under
`/classifications/:dataset/:operationId/c-v1/`:

- `prepare`: `{version:"classification-c-v1",command:<existing ManualCommand>}`.
  The command includes kind, dataset, operationId, requestId (canonical UUID-v4),
  expectedRevision (null for initial), state, and assignment for approved only.
  Server validates current account/JWT expiry, owner-scoped source facts,
  fingerprint, manifest readiness and current decision/revision. Response 200:
  `{version,preparationId,expiresAt,command,facts,currentDecision,consistency}`.
  Facts and fingerprint come from the same observation; expiry is epoch ms.
- `apply`: `{version,preparationId,confirmation:"confirm_prepared_intent"}`.
  Client may not resubmit or override command/facts/owner/revision. A confirmation
  flag alone supplies no authority. The 256-bit random ID selects the server-owned
  prepared intent bound to authenticated owner AND exact bearer-session hash.
  Response `{version,result:<unchanged WriteResult>}`: 201 created, 200 updated/
  replayed/cached acknowledgement; 404 missing source, 409 conflict, 503 infrastructure failure or uncertain write.
- `reconcile`: `{version,preparationId}`. Read only; returns
  `{version,outcome:"latest_applied"|"indeterminate",consistency}`. Match requires
  persisted requestId, canonical command hash, revision, state, assignment and
  source fingerprint. It never invokes execute or retries a write. A later
  decision makes the old result indeterminate; this is not an unlimited ledger.

Handler errors: `{version,error:{code},persistence:"not_applied"|"unknown"}`.
Authentication by the existing JWT guard and the shared bounded JSON/origin/media
transport retain their existing error envelopes (classification-http-error-v1 for
transport). Responses are no-store. No facts/tokens/private errors are logged.
Malformed/extra fields are 400; binding mismatch 403; absent/foreign source 404;
revision conflict 409; unavailable/expired preparation 410; closed gate/unready
manifest/capacity 503. Unknown preparation returns persistence unknown: absence
is never evidence that a prior command did not commit.

## Lifecycle and trust

Each process keeps at most 256 contexts, with monotonic five-minute apply lifetime and
24-hour bounded receipt/reconciliation retention after that deadline. Expired
unused entries and old receipts are swept at admission; no background timer or
persistent store. Capacity is checked again after async prepare reads. Contexts
retain commands/fingerprints/session hashes, not source display facts or JWTs.

Only one apply invocation per context may enter the existing writer. Duplicate
requests return the cached result or pending/unknown; a persistence-unknown result
is never retried. Multiple independently prepared intents still cross the existing
writer's CAS/idempotency/source checks. The trusted review resolver is private to
this handler and accepts only the selected server context and identical intent.
It does not mint a P11 cryptographic proof or change the old proof verifier.

Restart loses all pending contexts AND receipts. Old IDs return 410/unknown and
must never trigger automatic reprepare/reapply. Inspect current read state, then
require a fresh deliberate human decision. No cross-worker/load-balanced runtime
is supported without a separately designed shared context store. Retained receipts
are memory-only and subject to process loss; no durability/anti-rollback claim.

Missing authentication and a changed bearer cannot use a preparation. Clients
must discard IDs on logout/account/session transitions. The existing auth system
has no logout revocation endpoint: an otherwise valid copied old bearer remains
valid until expiry/account removal. This protocol does not invent revocation;
server-authenticated logout invalidation needs a separate auth decision.

Option A remains: source rechecks and post-write observations are non-atomic;
concurrent PATCH/DELETE and A→B→A history cannot be excluded. Classification writes
never mutate expense/income documents or financial amounts. Existing readers and
history consume the same classification documents and taxonomy.

## Verification and follow-up

`tests/classification-c.integration.test.cjs` runs in the normal integration runner
using its unchanged explicit loopback guard, randomly named disposable database,
real compiled app/JWT/writer and verified database/log/listener cleanup. MongoDB 6
verification must install the EXACT existing manifest/index, never weaken it.
Existing P10/P12 protocol/history/financial regressions remain mandatory.

Frontend follow-up: display prepare facts and intended assignment, obtain separate
explicit confirmation, keep IDs only in the current session memory, never silently
retry after timeout/restart, offer read-only reconciliation, refetch existing read/
history APIs after acknowledged writes. No frontend or production activation is
included here. Deployment requires separate approval, backup/readiness verification,
reviewed single-host composition and keeping all old P11 write gates disabled.

MongoDB 6 caveat: the old P11 operational preflight explicitly requires server
major/FCV 7 (`services/classificationRuntime/preflight.ts`). Its operational suites
are therefore not a MongoDB 6 acceptance target and fail closed there; that check
is unchanged. C does not install that abandoned proof runtime. C, the exact
manifest and existing writer are tested directly on disposable MongoDB 6.0.26;
the full legacy regression suite additionally runs on CI's MongoDB 7.0.45.

## Review corrections

Writer errors map consistently on both first apply and cached receipts: missing
source 404; source/infrastructure/persistence failures 503; actual stale/revision/
request-id conflicts 409. Unknown persistence always remains unknown and HTTP 503.

Capacity is concurrent retention, not a daily throughput quota. On pressure the
oldest terminal known outcome (success or definitely not-applied) may be evicted.
Pending and uncertain writes are never evicted to admit new work, so their bounded
read-only reconciliation window survives ordinary successful history processing.
Unused preparations also remain protected until expiry. All 256 slots being
pending/uncertain/unused still fails closed with 503. Evicted IDs return 410/unknown
and cannot invoke the writer, even with confirmation; never auto-prepare/reapply.
Known-outcome receipt retention is therefore best-effort under pressure, up to the
existing retention deadline. Restart and retention expiry limitations remain.
