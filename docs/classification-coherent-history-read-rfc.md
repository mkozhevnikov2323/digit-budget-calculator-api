# Proposed coherent historical classification read — approval required

Status: PROPOSED / disconnected request validator only. No handler, public endpoint,
DB access, new gate, collection, index, migration, write or production adapter added.
Base: main 1e36bea6049ad73d717b04045fa005947ef6d568. H1–H10 stay PENDING.

## Problem and minimum proposal

Frontend P1–P4 can load complete recorded history, but existing C3.2 GET omits the
source facts/fingerprint used for its classification comparison. Joining approved
GET status with an earlier expense amount can misreport classified money after a
PATCH. Re-fetching status alone cannot repair that mismatch; A→B→A still hides history.
Thousands of individual GETs additionally repeat readiness/metadata work.

Propose a separately approved read-only batch handler, potentially POST
`/classifications/history/read` (query semantics, zero DML), default unavailable until
HTTP/readiness review. GET v1 remains unchanged. Route/method and activation are not
approved by merging this prototype. Alternative: keep existing per-operation GET for
inspection and keep monetary reports unavailable (current behavior); alternatively
introduce a snapshot/store, requiring further persistence decisions. Do not create
a second classification collection or add source revision fields implicitly.

Request (implemented only as pure unknown-input validation):

```text
{version:"classification-history-read-request-v1",
 startInclusive:<UTC midnight epoch milliseconds>,endExclusive:<UTC midnight epoch milliseconds>,
 operations:[{dataset:"expenses"|"incomes",operationId:<ObjectId hex>}, ...]}
```

Exactly 1–100 unique canonical dataset/operation IDs, CE UTC dates 0001–9999 (exclusive
boundary 10000 allowed), start<end, no caller owner/filters/operators/extra fields.
Plain own data only, no accessors/proxies/hidden/symbol fields or sparse arrays.
The disconnected validator proves syntax only, not auth, source ownership, review
or whole-period completeness. It is not imported by app/startup/routes.

Proposed response (not implemented):

```text
{version:"classification-history-read-v1",
 window:{startInclusive,endExclusive},coverage:"requested_identities_only",
 consistency:"observed_only_non_atomic",returnedCount:<exact requested count>,
 operations:[{dataset,operationId,facts:<exact owned source projection>,
              classification:<existing C3.2 read DTO>}, ...]}
```

For each identity, read source with authenticated owner and compute its fingerprint
privately. Facts DTO and classification comparison must use **that same validated
source snapshot**. Reuse sourceFingerprintFromBson, stable policy/BSON mapper and
exact readiness checks. Return all expense category/title/recipient or income source,
comment missing/null/empty distinction and exact binary64/date presentation from
the review RFC; no rounding, raw documents, owner/digest/lastMutation/key leakage.
The frontend derives financial sums from returned facts, not its earlier list.
Money precision unsupported by reporting must fail the report, not be skipped.

Missing/foreign/deleted sources use a uniform missing-source failure for the batch;
out-of-period edits, duplicates, invalid facts, unknown taxonomy/readiness or partial
results prevent complete reporting. No silent omission or repair. No classification
HTTP write or proof issuance is involved. Errors remain sanitized; B3g logging and
existing auth are unchanged. TLS/no-store, bounded body/rate/query/time limits and
private proxy/APM handling must be approved before registration.

## Completeness and consistency limits

The request is a bounded identity set, NOT a whole-year completeness claim. A future
client/adapter must first validate the complete owned period membership, track every
batch exactly once, reject missing/duplicate/foreign identities, and detect changed
membership/periods before publishing. Concurrency cap (proposed 4) and record ceiling
must be explicit. Empty recorded periods require a validated empty membership result.
Membership/facts must never be inferred from only total metadata or a truncated page.

Option A remains observation-only: PATCH/DELETE/insert may race any read, and A→B→A
is undetected. Multiple batches are not a transactional annual snapshot. A stronger
guarantee requires separately approved source revision/fence/snapshot architecture.
Recorded completeness is not evidence that every real-world expense was entered;
forecasting additionally needs explicit recording-continuity evidence. The current
frontend therefore keeps real classified reports/forecasts/comparisons gated.

## Approval and verification plan

R1: approve route/method/request/response/error/body/rate limits and default-off gate.
R2: approve exact same-source facts projection, membership protocol/limits and
observed-only wording. R3: approve privacy/owner eligibility/readiness/performance.
R4: approve future handler/service implementation and UI adapter wiring. These are
new read-policy decisions, not silent approval of classification write H1–H10.

Future synthetic tests must cover exact facts/classification binding under PATCH/
DELETE, cross-owner/missing identities, unreviewed/stale/blocked states, membership
changes, multi-batch omissions/duplicates, limits, UTC/precision/overflow, gate/readiness,
zero DML/DDL, sanitized logs, session/period changes and isolated MongoDB cleanup.
This PR only tests request validation; it does not implement that future matrix.
