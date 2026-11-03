# Single-intent classification decision v1

`PUT /classifications/:dataset/:operationId/decision` is additive to the old C and
P11 routes. It uses the existing JWT/account/owner checks and
`CLASSIFICATION_C_WRITE_ENABLED=1` gate. No new environment settings, DDL, schema,
ledger, preparation store or startup activation.

Request (8 KiB bounded application/json; existing origin, duplicate-key and depth
checks apply):

```json
{
  "version": "classification-decision-v1",
  "requestId": "12345678-1234-4234-8234-123456789abc",
  "expectedRevision": null,
  "state": "approved",
  "assignment": {"economicRole": "ordinary_expense", "layer": "everyday"},
  "expectedFacts": {
    "amount": {"format": "binary64-roundtrip-decimal", "value": "12.34"},
    "dateEpochMs": 1736942400000,
    "date": "2025-01-15T12:00:00.000Z",
    "category": "Транспорт",
    "title": "Synthetic fuel",
    "recipient": "Synthetic",
    "comment": {"kind": "missing"}
  }
}
```

`expectedFacts` is the existing SourceFacts DTO from classificationObservation and
frontend manualClient/coherentHistory: exact persisted strings, roundtrip binary64
amount (`-0` is distinct), UTC epoch milliseconds AND canonical ISO date. Income
uses `source` instead of category/title/recipient. Comment distinguishes
`{"kind":"missing"}`, `{"kind":"null"}`, and `{"kind":"value","value":""}`.
The frontend can construct it from its already displayed HistoryOperation; no
extra facts/preparation request is needed. Never round or normalize these facts.
The server compares them against its own owner-scoped observation, then the
existing writer rechecks the source, manifest, revision and idempotency digest.

For `explicit_unclassified`, omit assignment entirely. Only these two states are
accepted. Changing an existing decision uses its current expectedRevision.

201 created / 200 updated or replayed:

```json
{
  "version": "classification-decision-v1",
  "outcome": "created",
  "decision": {
    "version": "classification-read-v1",
    "dataset": "expenses",
    "operationId": "111111111111111111111111",
    "status": "approved",
    "storedState": "approved",
    "decisionRevision": 1,
    "confirmed": {"economicRole":"ordinary_expense","layer":"everyday"},
    "consistency": "observed_only_non_atomic"
  }
}
```

The server rereads source and decision within this HTTP request, validating that
it still observes this request's revision/state/assignment. Changed source yields
stale/null confirmation. Missing/invalid/unavailable source, lost acknowledgement
or an unidentifiable/later decision produces 503 with persistence unknown; never
pretend that the write was absent. Failures carry version/error/persistence (writer
failures also include ok:false). Revision/fact/request-id conflicts are 409,
foreign/missing source 404, invalid input 400 and unavailable infrastructure 503.
Transport/authentication retain their existing error envelopes. Responses are no-store.

This is still a non-atomic observation (concurrent PATCH/DELETE, later decisions,
and A→B→A history remain possible). Idempotency uses the existing lastMutation,
not an unlimited replay ledger. Replaying identical requestId/intent at the same
source/revision returns replayed; do not automatically resend after unknown
outcomes. Explicitly read current state, then require a deliberate user decision.

Frontend PR43 follow-up: replace prepare/apply calls with one PUT per explicit
primary or unclassified click, keep double-click/session locks, validate the full
returned decision via classification-read-v1, update only the affected row and
close only after confirmed success. No client second GET is needed. Retire
preparation IDs, admission expiry and old preparation-based reconciliation from
this new flow only. Old prepare/apply/reconcile and their security checks remain
unchanged for older clients until separately retired.
