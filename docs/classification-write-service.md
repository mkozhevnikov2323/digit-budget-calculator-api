# C3.3a — isolated manual classification write service

This module is disconnected from the application. No routes, startup imports,
production feature flag, database connection or migration are added. It can be
constructed only with an explicit existing Mongoose connection and a mandatory
trusted server boundary. All executed writes in this PR use guarded disposable
test databases. C3.3b and production write enablement remain blocked below.

## Internal call contract and trust boundary

`createClassificationWriteService(connection, trust).execute(context, command, evidence)`
returns a safe `WriteResult`. It never accepts a URI or chooses a database from env.
Neither importing nor constructing the service performs I/O or initializes a model.

`trust` is **trusted application configuration**, never request data. Both methods
are required; there is no permissive/default identity resolver:

- `resolveAuthenticatedOwner(context)` must authenticate/admit a trusted server
  context and return the closed own-data projection `{owner}` or reject it.
  A shape-valid ID, arbitrary JWT-like object, client owner, or raw `req.user`
  forwarded without a verified server boundary is not authentication.
- `resolveVerifiedReview(context, evidence, checkedCommand)` must independently verify **prior
  explicit manual review** and its binding to that authenticated actor and checked
  command intent. The third argument is an owned validated command snapshot; it
  lets the future verifier reject proof for a different intended action. It returns
  a closed observation `{kind:'verified_manual_review', owner, dataset, operationId,
  sourceFingerprint, sourceFingerprintVersion:1}` or rejects it. The service then
  strictly validates shape/version and compares all identities with the owner and
  command. The resolver must not just forward request.body or accept a digest
  because it has valid hexadecimal syntax.

These callbacks are a security-critical internal port, not an implemented HTTP
proof verifier. Their authenticity is a caller obligation; shape validation cannot
prove it. This PR intentionally supplies **no production resolver or evidence
issuer**. The test-only helper uses private WeakMaps and opaque synthetic handles,
so raw JSON copies, IDs and digests have no authority in those tests.

No service method observes current source facts and mints them as proof of review.
The reviewed fingerprint must already be associated with the facts presented and
manually confirmed by the user. Computing a new hash during save only checks that
previous evidence still matches; it does not establish review. The literal command
kind or observation kind alone is also not evidence of genuine human action.

Strict `unknown` command example (the owner is deliberately absent):

```json
{
  "kind": "manual_classification",
  "dataset": "expenses",
  "operationId": "111111111111111111111111",
  "state": "approved",
  "assignment": { "economicRole": "ordinary_expense", "layer": "everyday" },
  "expectedRevision": null,
  "requestId": "12345678-1234-4234-8234-123456789abc"
}
```

The allowed target states are `approved`, `explicit_unclassified`, `cleared`.
Assignment is required only for approved and must be entirely absent otherwise
(including no null/undefined). Approve/change use the same target state with
explicit null for initial insert or a positive safe expected revision for CAS.
Initial cleared is an explicit manual reset allowed by D1. New same-value commands
still increment revision. Stable D3 role/dataset/layer policy is enforced.

The command is closed plain/null-prototype own enumerable data only. Getters,
class instances, inherited/hidden/symbol/extra properties, toJSON/coercion hooks,
MongoDB operators/filters and caller storage metadata are rejected. Dataset is an
exact literal; IDs are exact 24 ASCII hex characters and canonicalized to lowercase;
requestId is exactly canonical lowercase UUID-v4. No default revision sentinel.
The server alone chooses `_id`, owner, taxonomy, manual origin, revision, timestamps
and lastMutation. Validation snapshots inputs before asynchronous persistence.

## Read / write protocol

1. Resolve trusted owner, validate the command, resolve and validate prior review,
   bind owner/dataset/operation/version, compute command hash. Never log hashes.
2. Read source with `{_id,owner}` using the explicit C3.2 field projection and
   native driver, `promoteLongs:false`; reuse the strict fingerprint adapter.
   Missing/deleted/foreign sources have the same `source_not_found` result. Invalid
   facts or unsupported Long/Decimal128 amounts fail closed, never get cast/rounded.
3. Verify collection readiness using the exact C3.2 checker, then read the full
   classification by `{owner,dataset,operationId}`. Validate through the C3.1 BSON
   mapper; check returned identities. Unsupported/malformed records are never
   repaired or silently upgraded. Metadata alone cannot authorize a replay.
4. Recognize latest request ID/digest replay or reject payload reuse. Otherwise
   require exact current revision (or null and no record); reject overflow.
5. Recheck readiness without a positive cache. Re-read and fingerprint source
   immediately before building/validating the complete prospective record and
   the one persistence operation. Changed/deleted/invalid facts prevent the write.
6. Initial insert uses `prepareClassificationDocument` with server-generated `_id`,
   revision 1 and full validation, then one native `insertOne`. No blind upsert.
   The full unique tuple index arbitrates concurrent initial commands.
7. Existing update validates a complete prospective record and issues exactly one
   conditional `updateOne` with `_id,owner,dataset,operationId,decisionRevision`.
   `$set` writes next exact revision, state/assignment, source observation, timestamps
   and lastMutation together; `$unset` removes assignment for nonapproved states.
   `_id`, owner, identity and createdAt remain unchanged. `upsert:false` always.
   Setting the validated next revision under CAS is the atomic increment; there is
   no unguarded read/modify/write or timestamp/__v-based concurrency claim.
8. Both writes require acknowledged majority write concern with a bounded 3000 ms
   write-concern timeout. Server read/write execution uses maxTimeMS 3000; this is
   not an overall network/HTTP deadline. Existing connection timeouts/topology still
   matter. Majority acknowledgement is not verified backup/restore readiness.
9. Perform an owner-scoped post-write source read. Return only an acknowledgement
   plus an observed source status; **confirmed is always null**. A write can be
   applied while this observation is stale/missing/invalid/unavailable. Never roll
   it back, reset a decision, or claim atomic freshness because persistence worked.

Server timestamps use native Date. CAS preserves createdAt, chooses updatedAt at
least the previous updatedAt even if the clock moves backwards, and records a new
sourceObservedAt after the final source read. These times are not source revisions.
The existing Mongoose schema and MongoDB manifest remain unchanged; native writes
still obey the DB validator and never enable bypassDocumentValidation.

## Bounded last-command idempotency (RFC §5 / D7)

Command SHA-256 v1 is computed over compact UTF-8 JSON, no newline/BOM, in exactly
this order. Owned tuple arrays have null prototypes to avoid inherited toJSON:

```text
["budget-classification-command",1,ownerHex,dataset,operationHex,requestId,
 expectedRevision,["source",1,reviewedSourceFingerprint],
 "financial-classification-v1","manual",state,assignmentValue]
assignmentValue = ["assignment",economicRole,layer] OR ["absent"]
```

IDs are canonical lowercase, expectedRevision is numeric safe integer or null,
assignment follows stable policy. Operational timestamps and input property order
are excluded. Five literal fixed vectors were independently calculated with
Python `json.dumps(..., separators=(',',':'))` plus `hashlib.sha256`, not the JS
implementation under test. SHA-256 is not a signature or privacy/anonymization
mechanism; never expose either digest or canonical input in public DTOs/logs.

Latest same requestId + same digest causes no new write/revision/timestamp update.
Replay also verifies actual stored state/assignment, source digest and the expected
resulting revision. Latest same ID + changed intent conflicts. Old exact commands
after an intervening accepted command conflict. Once an ID is no longer latest,
reusing that ID with **new** intent/current revision is not recognizable; there is
no ledger, full history, exactly-once delivery or unlimited replay retention.

A native duplicate-key error is reconciled only when its code is 11000 and key
pattern is the approved full tuple; `_id`/unrelated unique-index errors are not
called successful retries. CAS matchedCount=0 performs one owner-scoped reread,
never a new write with a newer revision. A now-latest identical request can be
acknowledged as replay; other winners produce conflicts. Source freshness is
observed again, so a replay never restores an old confirmed assignment.

Timeout/disconnect/write-concern failure can follow a committed write. It returns
`persistence_failure` with `persistence:'unknown'`, not a claim of rollback. A retry
with the **same** command/request ID and evidence can reconcile the latest result.
The service never blindly repeats a write or invents a new request ID. Driver-level
retry behavior belongs to the explicitly supplied connection configuration.

## Safe outcomes / possible future HTTP mapping

Success is an internal acknowledgement, **not the existing GET DTO**:

```text
{ok:true,value:{version:"classification-write-result-v1",
 outcome:"created"|"updated"|"replayed",
 storedState:"approved"|"explicit_unclassified"|"cleared",
 decisionRevision:<positive safe integer>,
 sourceStatus:"matching_observed"|"stale"|"missing"|"invalid"|"unavailable",
 confirmed:null,consistency:"observed_only_non_atomic"}}
```

Errors contain only `{ok:false,error:{code},persistence:"not_applied"|"unknown"}`.
`not_applied` concerns **this invocation**; an earlier timed-out invocation may
already have committed. No owner, raw BSON, financial facts, error message/stack,
source/command digest or mutation details are returned. Unsupported stored source
version is identified only by a separate validation probe; no converted record is
persisted or treated as approved.

| code / result | proposed future HTTP treatment (not implemented) |
| --- | --- |
| invalid_context | 401; do not accept a client owner fallback |
| invalid_command, invalid_review | 400; cryptographically invalid proof can be 403 under an approved design |
| review_mismatch | generic 400/403 without disclosing foreign metadata |
| stale_review, revision_conflict, request_id_conflict, revision_overflow | 409; explicit new review when appropriate |
| source_not_found | uniform 404 |
| malformed_source, blocked_decision, unsupported_taxonomy, unsupported_fingerprint_version | fail closed, generic 409/503; no automatic replacement |
| source_unavailable, infrastructure_unavailable | generic 503 |
| persistence_failure | sanitized 500/503; unknown commit needs explicit reconciliation, not a new command |
| created/updated/replayed | separate acknowledgement; do not turn matching_observed into a fresh confirmed API claim |

Final HTTP codes/proof semantics must be approved in C3.3b. A nonmatching post-write
observation remains an applied-command acknowledgement with no confirmed assignment.

## Accepted limitations and production blockers

Option A has no source lock/fence/transaction. PATCH/DELETE can occur between final
verification and write or immediately after post-read. A decision can be saved
already stale; post-read can detect, not prevent, that race. Even matching_observed
is only about the values actually read. A→B→A hides edit history; __v and updatedAt
are not adequate source revisions. Concurrent decision updates can also supersede
the acknowledged revision before the response. Existing owner-scoped GET re-evaluates
current facts; this service does not change its contract or introduce totals.

Readiness inspection is not an atomic DDL fence. **Concurrent drop/rename/collMod,
index changes, restore or erasure must be administratively excluded while writers
run.** MongoDB insert can implicitly create a namespace if an operator drops it
between the readiness check and insert. The service installs nothing and refuses
an already missing/mismatched collection, but no preflight-only algorithm can
eliminate that DDL race. Do not claim that this PR provides such a guarantee.
Approved operational rollout must drain/disable writers before DDL; any demand for
an atomic namespace fence requires separate architecture review. No production
writes are reachable/enabled here, so that operational precondition is not assumed
satisfied by the published environment or by passing standalone CI.

C3.3b must resolve the **HTTP review-proof design** before wiring this service:

- Prove which exact source facts were shown and manually confirmed before save;
  bind actor, dataset, operation, supported version and explicit command intent.
- GET v1 deliberately returns no hash/proof and cannot itself supply this evidence.
  Never trust a client owner/digest or automatically mint proof from save-time reads.
- Approve an opaque server-held reference (including storage/retention decisions)
  or appropriately protected opaque proof with separate purpose-specific key
  management, expiry/replay/CSRF and rotation strategy. A readable signed payload
  containing a digest would still disclose it. No design/key is selected here;
  JWT auth secrets must not be silently reused for a new purpose.
- Implement/review trusted context/proof resolvers; literal labels, callback names
  or shape checks do not establish authentication, genuine user confirmation,
  account status or token revocation.

D1–D10 remain approved. Before any production enablement, the separate C3.1
[operational readiness plan](classification-persistence-readiness.md) still requires
verified namespace/manifest, version/FCV/topology, durable privileges/write concerns,
backup/restore, account erasure/retention and ID-reuse safeguards, default-off kill
switch, writer draining and non-destructive rollback. All remain operationally
UNVERIFIED here. No production inspection/migration, new collection, frontend,
HTTP write route, source-model/controller, financial calculation, recurrence or
logging-policy change is included.

## Test scope

Pure tests exercise unknown input, independent hash vectors, review identity/version
binding, immutability, hooks and mandatory trust ports. Real MongoDB tests use the
unchanged generated-name/URI/drop/close guards, install only the exact manifest in
the owned disposable DB, and invoke the real service/driver. Synchronized wrappers
control concurrent timing but delegate actual insert/update/index enforcement to
MongoDB. Tests verify one-winner insert/CAS, same-command concurrent replay, full
source BSON preservation, lost acknowledgements, stale/deleted/invalid source
windows, post-write observations, malformed records, missing/mismatched readiness,
nonmanual inputs and no public write route/application import. Source _id uniqueness
means two live owners cannot share an ID in one dataset; a synthetic foreign orphan
classification exercises that tuple-isolation case without pretending otherwise.
