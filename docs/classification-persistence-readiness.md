# C3.1 — classification persistence foundation and operational readiness

D1–D10 were explicitly approved by the project owner in task C3.1 on 2026-10-21.
Option A, SHA-256 source fingerprint v1 and current-record audit v1 are selected.
This records design approval, **not deployment or production migration approval**.
See the [approved RFC](individual-operation-classification-persistence-rfc.md).

## Implemented, isolated components

- `domain/classification.ts`: exact provisional and stable taxonomy support. Existing
  provisional structural invariants are preserved. No version aliases or fallback.
- `domain/classification/stablePolicy.ts`: explicit approved D3 policy, stable only.
  Ordinary expense/loan issuance are expenses; ordinary income/loan repayment/refund
  are incomes; transfer/capital movement accept both. Only ordinary expense has a
  spending layer; all other approved roles require explicit null.
- `persistence/classification.ts`: strict pre-cast boundary, stable only; full record
  validation, server-generated `_id` preparation, BSON/lean read mapping. No DB calls.
- `models/operationClassification.ts`: connection-explicit factory, no ambient
  connection/model bootstrap; autoCreate/autoIndex false, strict/strictQuery throw,
  versionKey false, local cast:false paths and full-document pre-validation.
- `persistence/classificationManifest.ts`: immutable data defining exact collection
  options, validator and unique index. No connection, environment selection,
  installation function or migration side effect.

Only `financial-classification-v1` may be persisted. Provisional decisions remain
readable by the pure C2.1/C2.3 validators but are rejected by the durable boundary.
No automatic upgrade, classification, source edits or financial aggregation.

## Internal validation and mapping contract

`prepareClassificationDocument(unknown)` accepts the complete stable internal
envelope **excluding `_id`**; rejects caller-supplied `_id`, extra keys, accessors,
hidden/inherited properties, invalid prototypes, type coercion and contradictory
states. It generates `_id` and explicitly converts validated hex identities to
BSON ObjectId only after checking decision, D3 policy and metadata.
Dates/timestamps must be native valid Date values; no strings or Date hooks.
All timestamps and decision revision are required explicit server metadata; no
implicit time/revision/state defaults. Schema timestamps are intentionally manual
(`timestamps:false`): the future trusted service must set them; it cannot depend
on replace/upsert resetting createdAt or overriding a failed boundary check.

`classificationFromBson(unknown)` reads only closed plain driver/lean records.
It inspects native ObjectId bytes and safe Long components without invoking input
toJSON/toObject/toString/toHexString. BSON int/double normally arrive as primitive
numbers; safe native Long is converted only after exact bigint range checks.
Decimal128, unsafe Long and other unsupported wrappers fail closed. It returns a
complete stable record or a stable safe code, never a raw public model DTO.
Native Date copies prevent caller aliases; freezing an envelope does not make
Date internal slots immutable. Consumers must treat returned internal dates as data.

Model validation is a secondary defense; it is not a replacement for validating
unknown input before constructing Mongoose documents. Raw Mongoose/driver exceptions
may contain input details and must never be logged or returned by future APIs.
Low-level writes still require the collection validator; runValidators alone cannot
validate whole-record transitions or authorize updates. Metadata digest syntax does
not prove that the command/source was observed or computed by a trusted server.

This foundation does not authenticate callers, prove source ownership/existence,
enforce principal-scoped queries, freshness, CAS or idempotency. Those future
services must derive owner from the authenticated principal, query by owner and
operation identity and perform the approved protocols. A structurally valid owner
string is not authorization. Neither the DB validator nor index is a foreign key.
Immutable Mongoose identity paths are not a DB-level authorization/immutability rule.

## Exact collection/index definition

Approved collection name: **`operation_classifications`**, initially unsharded,
simple collation. The deployment database name is deliberately not configured here.
Required fields: `_id`, owner, dataset, operationId, state, stable taxonomyVersion,
manual decisionOrigin, decisionRevision, sourceFingerprint/version, sourceObservedAt,
lastMutation and createdAt/updatedAt. Assignment is required only for approved and
absent for cleared/explicit_unclassified; null is never an absent assignment.

The manifest's validator uses `validationLevel:strict`, `validationAction:error`:
closed `$jsonSchema`, required BSON ObjectId/Date/string/numeric fields; safe positive
integer revision; exact taxonomy/origin/version enums; lowercase 64-hex digests;
closed UUID-v4 lastMutation; disjoint state/role/dataset/layer branches; `$expr`
enforces createdAt <= updatedAt. It is tested independently using raw driver writes
on standalone MongoDB 7.0.45. No transaction/replica-set assumption is made.

Index keys, in order: `{owner:1,dataset:1,operationId:1}`.
Options: `name:ux_owner_dataset_operation`, `unique:true`, `sparse:false`,
`collation:{locale:'simple'}`. No partial filter, TTL or other index; MongoDB's
standard unique `_id` index is retained. Clearing preserves tuple uniqueness and
revision continuity. Different owners/datasets may reuse operationId.
The executable-data manifest is the single source of exact validation expressions;
this document does not substitute a weaker prose-only validator.

## Migration readiness checklist — production remains blocked

No operational DB checks or migration were run by C3.1. No migration script exists.

1. Independently attest the target environment/database/namespace, responsible
   operator, approved release and manifest. Verify MongoDB version/FCV, unsharded
   topology, privileges, durability/write concerns and capacity. Do not select a
   database via application URI fallback. Production topology is **UNVERIFIED**.
2. Verify a consistent backup, catalog/validator/index manifest and restore in a
   separate environment; agree RPO/RTO, standalone snapshot/write-pause procedure,
   backup retention and erasure replay. Backup/restore readiness is **UNVERIFIED**.
3. Establish account-erasure/retention/orphan/restore-ID-reuse safeguards before
   writes. D9's design choice does not prove that these operational workflows exist.
   Current-record storage has no full historical audit; no retention automation.
4. Future dry-run must report namespace existence/options/indexes/emptiness using
   bounded reads without financial values. Absent collection is expected. An
   unexpected nonempty/mismatching namespace means STOP; do not delete/dedupe/repair.
5. Keep application writes disabled on every instance. Currently routes/services
   do not exist, so writes are unavailable; no new feature flag/config is added.
   Future rollout needs a default-off kill switch and drained/incompatible writers.
6. Under separately authorized maintenance, create an empty collection with the
   **exact** manifest options/validator, then build its named full unique index.
   No source backfill, autoIndex, autoCreate, bootstrap migration or index sync.
7. Verify exact installed namespace, validation level/action/expression, collation,
   index key order/unique/options and empty initial state. Record a release manifest
   and operator result without secrets or financial data. Do not enable on mismatch.
8. On interruption keep writes off: inspect the recorded manifest against actual
   collection/index state; continue only missing approved steps after revalidation.
   Wait boundedly for an index build; STOP on conflict. Never silently drop/recreate.
9. Only later reviewed PRs add owner-scoped reads, Option A stale handling, approved
   write/CAS/idempotency handlers and frontend. Test races, unavailable/stale sources,
   owner isolation and exact retry behavior before operational enablement.
10. Roll back by disabling/draining writes and removing new routes/UI. Keep existing
    classifications/index/collection, backups and source financial documents intact.
    Never restore an old source DB over newer operations to undo this feature.
    Incompatible readers stay off or block unknown versions; repairs are forward-only.

## Tests and limits

The regular test command includes the new no-DB suite; the existing fail-event
integration runner includes the new real MongoDB suite. It reuses the exact
test-only URI/configuration and generated-name/drop/close guards. Installation of
the manifest happens only in that owned disposable DB. Import/init is checked
before installation; raw inserts/updates prove DB validation without Mongoose.
Source financial documents are compared as BSON bytes; cleanup verifies empty DB
and closed connection, with failures propagated by the existing runner.

Option A tolerates the documented source PATCH/DELETE race; matching SHA-256 facts
cannot detect A→B→A history or replace ownership checks. No stable record is a
guarantee of current source freshness. SHA-256 is not anonymization; do not log
fingerprints, raw financial facts or metadata. No source hashing or CAS handler is
added by this persistence layer. No production deployment, indexes, collections,
data, financial models, public HTTP API or frontend were changed.
