# P5 coherent historical read

R1–R4 and H1–H10 were explicitly approved in the P5–P9 implementation task.
The older RFC's PENDING labels record its historical proposal state.

`POST /classifications/history/read` implements the versioned request and response
in the coherent-history RFC. `CLASSIFICATION_HISTORY_READ_ENABLED=1` enables only
this route; absent/other values return 503 before DB access. Existing classification
GET and its gate are unchanged. No keys or write capability are needed.

New routes require verified JWT authentication, finite integer unexpired `exp`
and a currently existing account. Account deletion can still race subsequent reads;
this is existence eligibility, not server session revocation. All responses have
no-store, Vary Authorization/Origin and no ETag. JSON-only, no compressed bodies,
8192 decoded bytes, duplicate decoded object keys rejected, maximum depth 16.
Origin absent is allowed for authenticated non-browser clients; supplied Origin
must exactly match the existing frontend allowlist. Driver errors are sanitized.

Each batch contains 1–100 unique canonical identities, two bounded owner-scoped
source queries and one bounded decision query, with 3000ms driver limits and exact
readiness before/after decisions. No DML/DDL, model hydration or source modification.
Same validated source object supplies private fingerprint and displayed facts.
Amounts are shortest binary64 round-trip strings, including `-0`; dates include
exact UTC milliseconds and ISO serialization; comments distinguish missing/null/value.
Unsupported source/oversized strings fail closed (503), missing/foreign/deleted
sources uniformly fail the entire batch (404), outside-window edits return 409.
Invalid stored decisions become blocked, never confirmed. No raw BSON/digest leaks.

Per-instance admission is bounded to 16 active requests, 4 per owner, 600/minute per
owner and 4096 tracked owners. This protects this process only, not a fleet limit.
Deployment ingress must enforce approved shared resource limits and avoid body,
credential and financial-payload capture. Enabling production is not part of this PR.

The frontend adapter reads existing paginated expense/income APIs with page size100,
ceiling50000 across both datasets and exact envelope validation. It then sends batches
of100 with concurrency4, validates every identity exactly once, and re-reads complete
membership and facts before publication. Empty periods require two validated empty
passes. Any failure, unsupported kopeck precision, changed membership/facts, session
transition or abort invalidates the aggregate; no partial totals. A full source list
does not prove real-world recording completeness. No automatic annual GET N+1.

These are **observed-only, non-atomic** guarantees. Multiple lists/batches are not a
transactional snapshot; PATCH/DELETE after an observation, later classification
changes and A→B→A may escape detection. Classification and amount within each item
always use the same source observation. Refresh discards the old aggregate.

Synthetic local/CI activation: use only the existing guarded MongoDB runner, a
fresh disposable MongoDB service, generated database names, fixture account/source
documents and the existing explicit manifest installation in tests. Never enable
application DB fallback, auto-create production indexes or run server bootstrap.
