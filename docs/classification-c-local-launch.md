# Classification C: local launch and first confirmed decision

Use the merged HTTP bind support and existing C handlers. No P11 proof runtime,
new API, MongoDB upgrade or operational ledger is required. Source expenses and
incomes are never rewritten by classification. Never reinstall an already correct
manifest or use the working database as an integration-test sandbox.

## Private runtime configuration

Keep the runtime file outside Git, for example
`/home/maksim/.config/budget-calculator/backend.env`, in an owned 0700 directory
with an owned regular 0600 file. Provision a persistent CSPRNG JWT secret of at
least 32 random bytes directly into that file, without printing it. Do not rotate
it on every launch or place it in shell history, argv, a PR or a report.

Required configuration:

- `NODE_ENV=production` so both login and verification use `JWT_SECRET`.
- `DATA_BASE_URL` must be the independently verified existing local `budgetdb`
  connection. Production does not select `DATA_BASE_URL_LOCAL`. Do not guess a
  namespace or silently fall back to an empty database.
- `PORT=3000`, `BUDGET_HTTP_HOST=127.0.0.1`.
- `CLASSIFICATION_C_WRITE_ENABLED=1`, `CLASSIFICATION_READ_ENABLED=1`,
  `CLASSIFICATION_HISTORY_READ_ENABLED=1`.
- `CLASSIFICATION_REVIEW_ENABLED=0`, `CLASSIFICATION_WRITE_ENABLED=0`,
  `CLASSIFICATION_RECONCILE_ENABLED=0` for the old P11 protocol.
- Retain the reviewed CORS preflight methods, including GET, POST and OPTIONS.

With the old backend stopped and no competing listener on 3000, run exactly one
process from a private log working directory using absolute paths:

```sh
node --env-file=/home/maksim/.config/budget-calculator/backend.env /home/maksim/Dev/pet/digit/digit-budget-calculator-api/dist/server.js
```

Build the reviewed backend first. Do not use nodemon, cluster or multiple workers
for C: preparations and uncertain receipts belong to one process. The env file
is loaded by Node before any application import. Launch without conflicting
inherited NODE_ENV, JWT, database or classification variables. Check the actual
listener is 127.0.0.1:3000, metadata readiness is true, and authorized read routes
work; an HTTP listening message alone does not prove MongoDB readiness.

Frontend uses its existing C implementation:

```sh
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://localhost:5173` (an existing allowed Origin). Its `VITE_API_URL` must
select the local backend. Do not inadvertently use a production frontend config
pointing to a remote API. JWTs issued with the former development secret are
invalid after the switch: sign in again with the existing account/password.

## First real decision and persistence check

1. Select one existing expense in the real history UI. Read the current decision.
2. Select state, economic role and layer; request server preparation.
3. Review the returned source facts, then explicitly check the confirmation box
   and press save once. Preparation alone must not write anything.
4. Require a validated successful apply acknowledgement; refresh the page and
   check the stored decision/revision, then load real statistics for that period.
5. A deliberate edit uses a fresh preparation at the current revision. Verify
   the revised decision after another refresh; the source amount/date stay intact.
6. After a controlled backend restart, read the persisted decision again. Keep
   the JWT secret stable. Old preparations and receipts are lost on restart.

Timeout, lost response or unknown persistence never authorizes automatic retry.
Use the existing read-only reconcile while its context exists; after context loss,
refresh current state and require a fresh human decision. Current-record receipts
are not a permanent historical execution ledger.

## Disable without deleting classifications

Close the review UI and allow current work to finish. Stop the one backend, set
`CLASSIFICATION_C_WRITE_ENABLED=0` in its private runtime file, then start it again.
Read/history may stay enabled. An already admitted apply may have committed;
stopping a process is not rollback. Preserve the collection, indexes and backup.

## Isolated verification

Use the existing guarded integration runner and its exact loopback URI. On a host
whose real MongoDB occupies 27017, run tests in a separate network namespace with
only its own loopback and a separate temporary MongoDB/dbPath. Verify the namespace
differs and that the instance is empty before running tests. Never relax the URI
guard or run the runner against the working MongoDB, even with random DB names.
The harness owns generated database names and verifies drop/close on cleanup.
MongoDB 6 acceptance runs C, persistence, read/history, writer, owner and safety
suites; the unchanged P11 operational MongoDB-7-only suites remain CI's responsibility.
