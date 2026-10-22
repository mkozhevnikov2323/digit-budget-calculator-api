# P12: disposable history baseline and integrity coverage

Parent: main `491bae6ab05a28e0e3d26ddfaadc15a06aba9b4b`.
Frontend benchmark implementation: sibling `digit-budget-calculator`, commits
`ab3848addd1b5fca735903b7ee4e3e36ad929852` and baseline report successors.
Backend measured tooling: `81ee073d2acadb22dc212a48a2e1c6a5c020a9a2`.
All production backend files, source models, manifests, APIs, financial logic and
security limits remain unchanged. The other P12 PR consumes this test harness
at an immutable SHA; review this test foundation first. Neither PR may auto-merge.

## Commands and isolation

After `npm ci`, `npm run typecheck` and `npm run build`, run:

```sh
MONGODB_INTEGRATION_TEST=1 MONGODB_TEST_BASE_URI=mongodb://127.0.0.1:27017 npm run test:performance:smoke
npm run test:integration:runner
MONGODB_INTEGRATION_TEST=1 MONGODB_TEST_BASE_URI=mongodb://127.0.0.1:27017 npm run test:integration
```

The new suite also belongs to the default guarded integration runner. Use only
the official immutable MongoDB 7.0.45 service already specified in CI. Its helper
requires the exact loopback base URI, rejects application connection variables,
generates a cryptographic database name, checks the active namespace before
cleanup, drops it, verifies emptiness and closes MongoDB/HTTP/log/temp resources.
No application bootstrap or external service is used. Monitoring is an optional
boolean passed BEFORE opening the driver pool; normal harness calls stay unchanged.

`benchmarks/p12/backend.cjs` is IPC-only, requires a dedicated test opt-in and
exports only closed aggregate metrics, counts and redacted query plans. It never
prints request bodies, JWTs, documents, source fingerprints, raw queries or errors.
No HTTP debug/control endpoints are installed. The frontend parent owns lifecycle
and asserts exact BSON immutability before verified cleanup.

## Fixture and independent oracle

Approved sizes: 100/1,000/10,000/50,000. Deterministic 80% expenses/20% incomes,
foreign-owner distractors, outside-window boundary rows, varying month density,
equal source dates with distinct createdAt, all seven allowed roles/five layers,
missing/null/empty/Unicode comments, approved/unreviewed/explicit-unclassified/
cleared/stale decisions. Expected money partitions use independently summed
integer BigInt kopecks, never the production money/statistics calculator.
Main and foreign owners are isolated, including cross-dataset ObjectId collisions.

## Measured query evidence (L = 10,000 main operations)

Node 22.23.3, MongoDB 7.0.45, two-CPU quota/8 GiB cloud container. Full raw metrics
are in the frontend `docs/performance/p12-*-baseline.json` artifacts. These are
synthetic local observations, not home Ubuntu or production capacity estimates.

| Plan | Shape | docsExamined | keysExamined | server ms | stages |
|---|---|---:|---:|---:|---|
| baseline | expenses/first | 8802 | 0 | 9 | COLLSCAN, SORT |
| baseline | expenses/deep | 8802 | 0 | 16 | COLLSCAN, SORT |
| baseline | expenses/count | 8802 | 0 | 7 | COLLSCAN |
| baseline | incomes/first | 2202 | 0 | 5 | COLLSCAN, SORT |
| baseline | incomes/deep | 2202 | 0 | 4 | COLLSCAN, SORT |
| baseline | incomes/count | 2202 | 0 | 1 | COLLSCAN |
| proposedDisposableIndexes | expenses/first | 100 | 100 | 1 | FETCH, IXSCAN |
| proposedDisposableIndexes | expenses/deep | 100 | 8000 | 3 | FETCH, IXSCAN |
| proposedDisposableIndexes | expenses/count | 0 | 8001 | 2 | COUNT_SCAN |
| proposedDisposableIndexes | incomes/first | 100 | 100 | 0 | FETCH, IXSCAN |
| proposedDisposableIndexes | incomes/deep | 100 | 2000 | 3 | FETCH, IXSCAN |
| proposedDisposableIndexes | incomes/count | 0 | 2001 | 0 | COUNT_SCAN |

Actual source collections have only `_id_`; no source compound indexes are
assumed. Classification uses its approved unique owner/dataset/operationId index
and `_id_`; source batches use owner plus bounded `_id` membership and projection.
A mixed batch observes exactly 8 commands: account find, two source finds, one
decision find, two listCollections and two listIndexes. Readiness checks remain
before/after the observation. They are a security contract, not safely cached here.

Source expense GET hydrates Mongoose documents; income GET uses lean. Changing
expense hydration/projection could affect legacy casting/serialization/public
contracts; the measured dominant scan/count problem needs an index decision.
No speculative backend optimization is implemented. The bounded <=100 identity
lookup's O(100²) association is not an unbounded financial N+1.

## Source index proposal — documentation only

Candidate on each of `expenses` and `incomes`:

```js
{ owner: 1, date: 1, createdAt: 1 }
```

The harness creates `p12_proposal_only` **only in its generated test DB**, explains
queries, then drops it. At L, source index bytes change from 4,096 to 192,512
(expenses) and 24,576 to 65,536 (incomes); see raw artifacts for observed storage.
This is a small-fixture measurement with WiredTiger allocation granularity, not a
production-size or write-throughput estimate. First-page examined documents fall
to 100; deep offset still scans skipped keys. Count still scales with the number
of selected keys, so two full membership passes repeat many counts.

Each source write would additionally maintain one B-tree. Deployment would need
owner approval, actual production index inventory/capacity, controlled creation,
resource/latency monitoring and rollback by explicit drop of that named index.
No autoIndex/syncIndexes, startup DDL, schema or application database mutation is
part of P12. Do not promote test DDL into application startup.

A future cursor RFC should compare offset compatibility, a unique tie-breaker
(date/createdAt alone is not a total order), owner-period-scoped cursor integrity,
page counts/coverage and mutation behavior. Cursor pagination alone cannot create
a transactional snapshot. A new snapshot/revision mechanism needs separate API,
schema, migration and security review. No such architecture is implemented here.

## Real load/fault guarantees

The P12 integration suite verifies complete membership, fixed mixed-batch query
budget, foreign-owner failure, exact/stale expense and income facts, moved/deleted
sources, classification revisions without financial BSON writes, 4 per-owner and
16 process-wide active read caps, another owner's small request making progress,
oversized fields, unsupported precision, MongoDB driver loss/reconnect, a bounded
injected code-50 failure with observed maxTimeMS=3000, and an actual HTTP client
abort while a native query is paused. All barriers have deadlines and release in
finally. Query time-limit fault injection verifies error handling; it is not a
physical server execution-time benchmark. No OOM/DoS payload or quota increase.

Client cancellation does not imply server/MongoDB cancellation; an already
admitted query may complete within existing limits and then releases admission.
Tests explicitly retain this distinction. No incomplete batch is converted to
zero spending or an approved classification.

Known limitations remain: non-atomic after-source-observation PATCH/DELETE,
A→B→A, changes after final observation, and classification changes after a batch
may escape detection. UI invalidation/session checks cannot supply DB transactions.
The frontend P12 report contains the full 23-scenario consistency matrix.

Production classification activation remains unapproved. P11/P11.1 operational
providers, proof/CAS/idempotency, default-off gates and unknown outcomes are intact.
