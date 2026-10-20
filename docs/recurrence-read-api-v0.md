# F2.2 — Provisional owner-scoped recurrence read API

**Status:** DRAFT implementation / approval required. No production rollout is authorized by this PR.
This endpoint is an independent read-only proposal that does not modify existing
\`GET /expenses\`, \`GET /incomes\`, any MongoDB schema/index, or existing financial records.

## HTTP proposal

Authenticated:
\`GET /analytics/recurrence?startMonth=2025-01&endMonthExclusive=2026-01\`

Both query fields are required, must be canonical YYYY-MM UTC month identifiers
and describe an inclusive start and exclusive end. Only completed UTC months
are supported. V0 accepts 1–12 months; 12 months is a conservative query-size
upper bound, **not** a classifier threshold or required lookback/default.

Example response shape, illustrative counts only:

\`\`\`json
{
  "version": "observations-v0",
  "window": {
    "startMonth": "2025-01",
    "endMonthExclusive": "2025-04"
  },
  "coverage": {
    "source": "stored_records_only",
    "historicalContinuity": "unverified",
    "atomicSnapshot": false,
    "maxRecordsPerDataset": 1000
  },
  "observations": [
    {
      "group": {
        "dataset": "expenses",
        "level": "category_or_source",
        "identity": { "provenance": "label_only", "value": "Fictional Food" }
      },
      "operationCount": 3,
      "activeMonthCount": 2,
      "activeMonths": ["2025-01", "2025-02"],
      "intervalsInMonths": [1],
      "longestConsecutiveMonths": 2
    }
  ]
}
\`\`\`

The backend trusts only the verified JWT owner claim, not an owner query value.
Both MongoDB reads filter by owner and \`date >= start\`, \`date < end\`, and
use \`limit(1001)\` and \`maxTimeMS(3000)\`. Results are discarded (HTTP 413)
if either income or expense dataset exceeds 1000 rows. No partial report
is returned. Failures (including MongoDB query timeouts) follow the existing
global error path. Malformed request parameters fail 400; missing/invalid
JWT preserves existing 401 semantics.

The response does **not** contain financial amounts, individual operation IDs,
manual classifications, economic roles, proposed layers or monetary totals.
It returns only observed group counts, date evidence and identifying category
labels / expense title+recipient / income source. Those labels can still be
sensitive; use the existing allowlisted file logger and authenticated transport.

## Crucial limitations before a real frontend rollout

- A complete bounded query of *stored* records does not prove that the user
  was actively recording expenses in every month. A historical absence must not
  be labeled "rare" or "irregular" as an economic conclusion.
- Expense.category is a String, not a reliable system/custom dictionary
  identity; labels are explicitly \`label_only\`, never \`verified_id\`.
- Exact text matching in F2.1 does not fold case or normalize Unicode. Nothing
  here assigns "regular", "periodic", a spending layer or economic role.
- The two dataset reads are not an atomic cross-collection snapshot. Concurrent
  inserts/edits/deletes may produce differently-timed observations. Do not
  expose the result as confirmed financial truth.
- 1000 rows/dataset and a 3-second database query timeout are **provisional
  safety bounds**, not measured performance/SLA policy. If more history is
  needed, propose a separately reviewed bounded pagination/count strategy.
- The current app's login token validates syntactic owner ID but does not
  prove that the account still exists or is active. That security model is
  unchanged here.
- This endpoint does not convert financial amounts; confirmed money metrics
  require a separate checked precision contract.
- No persistence for manual reviews, no migration and no frontend integration.
  Review the contract, performance, privacy, index coverage and concurrency
  before merging or enabling a live classification UI.

## Alternatives

- Reuse existing expense/income GET with noPagination: rejected for this first
  API because completeness, timezone semantics and the unbounded payload are
  different across the current handlers.
- Fetch everything in React: rejected because it duplicates authoritative
  classification policies across clients and exposes unnecessary history.
- Precompute/store recurrence in MongoDB: deferred because it requires
  versioning, migration, cache invalidation and separate owner isolation.
