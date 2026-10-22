# Disposable Chromium backend fixture (P10)

This is **test infrastructure**, outside production imports and startup. It does
not implement fleet key governance and must never be deployed as an application.

A parent must fork `server.cjs` with an IPC channel and explicitly supply
`BUDGET_BROWSER_TEST=1`, `MONGODB_INTEGRATION_TEST=1` and the existing exact
`MONGODB_TEST_BASE_URI=mongodb://127.0.0.1:27017`. Build first, using Node 22.
The existing helper validates configuration before imports/IO, generates the DB
name, forbids production bootstrap and creates the real `dist/app.js` listener
on an ephemeral loopback port. There are no test-only HTTP routes. A pre-existing
application database/URI is never a fallback.

The fixture prepares only its own DB with the exact classification manifest and
unique index. Fictional password hashes use real bcrypt; browser login exercises
real JWT/account validation. Previously approved synthetic decisions pass the
existing fingerprint and persistence validators. The primary expense starts
unreviewed and must be approved through the real UI/proof/CAS protocol.

`ready` IPC includes only the listener address and fictional IDs. `inspect`
returns counts, a revision/layer and a comparison of complete serialized BSON
sources; it never returns passwords, JWTs, proofs, financial documents or keys.
The remaining fixed commands prepare bounded fixtures or test faults; they are
not available over HTTP. `changeSource`/`unsupportedPrecision` deliberately reset
the expected BSON baseline after the authorized fixture mutation.

P11 routes protocol installation through the same explicit secure runtime adapter
used by operational integration tests, with synthetic providers only.
Protocol installation is test-only, with a fresh 32-byte AES key, distinct test
era, bounded shared single-process issuance quota, current real manifest
readiness and a documented +301s clock adjustment for expiry tests. Ordinary
JWT verification retains the real clock; fixed history is 2024/2025. Setting
`BUDGET_BROWSER_DEFAULT_OFF=1` omits installation **despite enabled flags** to
prove production-style fail-closed behavior. Production app/server are unchanged.

The lost-ack fault throws after the real native classification insert completes;
it does not mock the writer or bypass proof verification. This yields the real
unknown-outcome HTTP contract and allows real read-only reconciliation. Existing
Express/MongoDB suites remain authoritative for the full race/recovery matrix.

Managed runtime shutdown must drain and release admissions before fixture disposal;
failure is fatal. The parent must always send `close` and require `cleanupVerified: true` plus a
zero child exit. Disconnect/SIGTERM/SIGINT also initiate teardown. Cleanup uses
the existing helper: close listener/connections, guard exact generated DB, drop,
verify no collections, disconnect, close real silent Winston transports, remove
temp logs, restore context. Failure is fatal. No raw subprocess diagnostics are
forwarded to CI. The enclosing CI service/container must be disposable too.


## P11.1 opt-in local provider verification

`BUDGET_BROWSER_LOCAL_PROVIDER=1` additionally selects the real built-in SQLite
ledger and protected disposable systemd-style credential directory plus the strict
chrony parser/clock adapter. External ledger/time anchors and time infrastructure
remain SYNTHETIC test fixtures, labelled `isolated-test`; no host service is used.
All14P10 browser scenarios, manual checkbox, default-off case, guard/cleanup and
privacy reporter remain unchanged. No moving backend branch: frontend pins an exact
reviewed SHA. Teardown closes SQLite and deletes generated credential files; failure
propagates. This is not production custody, filesystem power-loss or anti-rollback
infrastructure verification. Without the opt-in P11's original fixture still runs.
