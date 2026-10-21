# Classification read API v1 (C3.2)

## Contract

`GET /classifications/:dataset/:operationId` is mounted after the existing JWT guard.
No existing endpoint, authentication contract or financial calculation changes.
Only `expenses` / `incomes` and exactly 24 ASCII hexadecimal ID characters are
accepted. Uppercase ID aliases are accepted and returned as canonical lowercase.
Query parameters, array/scalar bodies and nonempty parsed objects are rejected;
empty objects are allowed.
Owner-like custom headers are ignored. Only the authenticated principal supplies owner.
The response has `Cache-Control: no-store`; clients must not persist a freshness claim.

Every successful response has exactly these fields:

```json
{
  "version": "classification-read-v1",
  "dataset": "expenses",
  "operationId": "111111111111111111111111",
  "status": "approved",
  "storedState": "approved",
  "decisionRevision": 1,
  "confirmed": { "economicRole": "ordinary_expense", "layer": "everyday" },
  "consistency": "observed_only_non_atomic"
}
```

| status | storedState / decisionRevision | confirmed |
| --- | --- | --- |
| `unreviewed` | both null; source exists and ready collection has no owned tuple | null |
| `approved` | validated manual state and positive safe revision | validated role/layer only |
| `explicit_unclassified` | same validated manual state / revision | null |
| `cleared` | same validated manual state / revision | null |
| `stale` | underlying fully valid manual state / revision, including opt-out/reset | null |
| `blocked` | both null in v1: no partial metadata from an invalid record | null |

`stale` and `blocked` are derived, never persisted states. Freshness is required
for every manual state. Stale `explicit_unclassified` retains that storedState;
future suggestion logic must continue suppressing replacements until explicit review.
A blocked record is not permission to generate/approve a replacement. There are
no suggestion or write handlers in this implementation. No silent repair/delete.

The DTO never includes owner, raw documents, financial facts, digest, canonical
input, timestamps, lastMutation or internal authorization details. `confirmed`
contains only the validated assignment; no assignment for stale/blocked/nonapproved.

| HTTP | meaning / response |
| --- | --- |
| 400 | invalid request: `{"message":"Invalid classification request"}` |
| 401 | existing JWT/auth errors; controller additionally checks principal shape |
| 404 | missing, foreign or previously deleted source: `{"message":"Operation not found"}` |
| 503 | gate off, disconnected DB, invalid source facts, unavailable/mismatched infrastructure or read failure: `{"message":"Classification reads unavailable"}` |
| 500 | unexpected controller failure: `{"message":"Classification read failed"}` |

Standard parent authentication, body parsing, CORS and unknown-route behavior remain
unchanged. A body-parser failure can occur before this controller. No private driver
exceptions enter the legacy error handler or HTTP output on the new read path.

## Read protocol and boundaries

1. Validate principal and parameters; gate requires the exact server env value
   `CLASSIFICATION_READ_ENABLED=1`. Absent, `0`, `true`, whitespace and all other
   values disable it. This PR sets no deployment/environment value.
2. Use the existing connected database only; never bootstrap or connect from a GET.
3. Native-driver source lookup uses both `_id` and JWT-derived `owner`. Missing
   source returns 404 before inspecting classification availability/status.
4. Read only necessary financial fields, without Mongoose hydration, defaults,
   getters, trim or casting. The adapter validates native ObjectId identities,
   closed own data properties, exact Number/Date/string/comment representations,
   then creates an explicit projection for source fingerprint v1. It invokes no
   user conversion hooks. `promoteLongs:false` prevents lossy Long coercion:
   Long/Decimal128 amounts fail closed (including safe Long amounts in v1).
   Binary64 fractions, signed zero, exact persisted Unicode and absent/null/empty
   comments retain the existing fingerprint semantics. Storage timestamps and
   `__v` are excluded. Newly introduced business fields require adapter/version
   review; an explicit projection cannot discover fields it does not select.
5. Inspect readiness below, then lookup classification by the full
   `{owner,dataset,operationId}` tuple. Read through the native driver to retain
   malformed fields instead of hiding them behind casting or a DTO projection.
6. Recheck readiness after lookup, including a missing document. This catches a
   common drop/alter race; it does not establish an atomic infrastructure snapshot.
7. Validate the full stored document with the C3.1 mapper (including exact stable
   taxonomy, D3 role/dataset policy, revision, metadata and versioned digest).
   Recheck returned tuple identity. Compare fingerprints with the C2.4 helper.

All GET operations are reads. There is no classification model initialization,
collection/index creation, syncIndexes, migration, update or source mutation.
Source rows with unrepresentable facts return 503 even when no decision exists;
unknown facts never become `unreviewed`. Record interpretation failures return
`blocked` and discard all partial metadata conservatively.

## Infrastructure readiness and operator enablement

No readiness cache is used. Each successful owned-source read does two bounded
listCollections/listIndexes inspections. Missing infrastructure fails closed even
with the feature flag on or when an otherwise valid decision exists.

Readiness requires a regular, noncapped/nontimeseries collection of the manifest
name; exact validator structure; strict/error validation; simple collation; and
`ux_owner_dataset_operation` with ordered `{owner:1,dataset:1,operationId:1}`,
unique true, nonsparse, visible, no partial filter or TTL and simple collation.
MongoDB's omitted default simple collation / false sparse/hidden metadata is
accepted. A semantically equivalent but structurally different validator or renamed
index fails closed. Unrelated extra indexes are not interpreted or repaired.
The built-in `_id` index remains MongoDB's normal collection invariant.

Before enabling reads, operators must separately approve and execute the C3.1
[readiness plan](classification-persistence-readiness.md):

- Verify exact production namespace, topology/version/FCV and unsharded compatibility;
  verify backup/restore, retention/account erasure, restore-ID reuse and rollback.
- Keep this gate off while the separately approved migration installs the exact
  checked-in `CLASSIFICATION_MANIFEST` validator and unique index; verify installed
  metadata and existing records. This PR contains no migration command/runner.
- Provide least-privilege `find` on sources/classifications and collection/index
  metadata inspection (`listCollections`, `listIndexes`) in the intended DB. The
  endpoint needs no write/DDL privileges. Denied inspection returns 503.
- Only after review, set exact `CLASSIFICATION_READ_ENABLED=1` through the approved
  deployment process. That enables reads only; it cannot install/repair readiness.
- Verify safe synthetic smoke checks in an approved nonproduction environment,
  monitor sanitized availability, and disable the flag if checks fail. No write
  rollout or production data inspection is authorized by this PR.

Two inspections cost four metadata commands in addition to two document reads;
this favors correctness over throughput. Server execution is bounded by 3000 ms
per read/metadata command, not a total HTTP or network deadline. Existing driver
selection/socket settings still govern network failures. Measure before replacing
this with a cache/infrastructure lease; do not introduce indefinite positive caching.
No concurrent DDL/restore consistency guarantee follows from either inspection.

## Option A limitations and tests

This is an observation, not a transaction/shared source revision. A PATCH or DELETE
can happen immediately after source read and before the response. The response can
therefore contain an assignment matching the observed source while the source has
already changed or disappeared. The next read detects stale facts or returns 404.
Even a final reread cannot eliminate changes after that reread. A→B→A restores the
same fingerprint and hides intermediate edit history. `__v` and `updatedAt` are not
adequate source revision/fences for current writer paths. No freshness cache,
atomic totals, source lock, CAS or transaction is implied by this DTO.

D1–D10 remain architecturally approved, including Option A and SHA-256 v1. SHA-256
is not encryption, anonymization, authorization or protection against guessing
low-entropy facts; fingerprints stay private. Operational migration, production
backup/erasure readiness and deployment remain unverified and separately authorized.

Focused tests use compiled app, real JWT/HTTP and the existing isolated MongoDB
harness. Fixtures/DDL are allowed only in a generated guarded disposable database.
They cover all states/field edits, malformed records/source representations,
owner/dataset isolation, safe DTOs/errors, absent/mismatched readiness, no readiness
cache or auto repair, no GET writes, unchanged complete BSON, cleanup, and controlled
PATCH/DELETE interleavings. The interleaving tests deliberately mutate synthetic
fixtures between the real source and classification reads and demonstrate Option A's
limitations; the HTTP implementation remains unmocked. No production bootstrap runs.
