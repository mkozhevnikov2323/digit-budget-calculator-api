# Budget Calculator API — agent guidance

## Project overview

Budget Calculator is a personal finance application with sensitive,
business-critical financial data. It currently has one primary user and is
intended to support multiple users. The React/TypeScript frontend is a separate
repository; this repository contains only the backend.

The current backend provides incomes, expenses, balance calculations, users and
financial reference data (categories, sources, recipients and expense titles).
There is no dedicated loan model or route in this baseline; do not assume that
frontend loan-related features establish a separate backend loan domain.

## Current stack and architecture

- Node.js, Express 5, MongoDB and Mongoose 8.
- JWT authentication and Celebrate/Joi validation.
- CommonJS with strict TypeScript entry points (`app.ts`, `server.ts`) and
  error modules (`errors/*.ts`) and all shared middleware (`middlewares/*.ts`).
  Controllers, routes and models remain legacy JavaScript;
  the incremental migration is not complete.
- Preserve `controllers/`, `routes/`, `models/`, `middlewares/` and `errors/`
  unless a refactor is explicitly approved.
- Prefer small incremental improvements over rewrites. Do not introduce NestJS,
  another ORM, ESM or a different framework without approval.
- Keep HTTP handling, domain rules and persistence separate where practical;
  reuse existing validation and business logic.
- Preserve public HTTP contracts. MongoDB document changes require explicit
  approval and a migration plan. Financial calculations and date semantics are
  compatibility-sensitive.
- Client-supplied owner identifiers are not authorization evidence. Enforce
  owner isolation on the backend for private data; never log passwords, tokens,
  secrets or sensitive financial records.

These are policies for future work, not permission to refactor existing modules.

## TypeScript migration strategy

- Migrate one small module group at a time, preserving CommonJS and working
  local development after every PR. Do not rename all JavaScript files at once.
- Use strict TypeScript checks for new TypeScript code. Temporary `allowJs`
  support and `checkJs: false` permit existing JavaScript during migration;
  they do not establish type safety for that JavaScript.
- Avoid `any` except at a justified, narrow boundary. Prefer `unknown` and
  validation for external input, and established Node.js, Express and Mongoose
  type definitions when the corresponding modules are migrated.
- Do not combine migration with unrelated business-logic changes. Remove
  transitional settings only after migration is complete and reviewed.

## Testing and verification

- Add focused tests for new functionality. Prioritize authentication,
  authorization, ownership, income/expense logic, money precision and dates.
- Use synthetic fixtures and isolated, reproducible tests. Never connect unit
  tests to production MongoDB or use real user financial records.
- Run applicable available scripts before completing a PR and follow the task's
  verification scope. Report actual results, missing coverage and unverified
  behavior; never claim an unexecuted check passed.
- Keep test-only work separate from unrelated production refactoring.
- Run `npm run build` before `npm run test` (or `test:smoke`): JWT contracts load
  `dist/middlewares/auth.js`, error contract tests load
  compiled `dist/errors/*.js` and the existing 14 isolated Express checks
  use compiled `dist/app.js` and Node's built-in test runner. They use real
  middleware, a temporary log directory and
  ephemeral loopback listeners, with database access blocked. Expense/income
  ownership contracts use real HTTP/JWT/controllers and mocked persistence;
  real MongoDB integration and ownership in other domains remain future work.
- `server.ts` and compiled `dist/server.js` connect to MongoDB and listen as an
  import side effect. Never import/execute either in automated checks. Keep
  dotenv initialization before application evaluation in compiled CommonJS.

## Security and financial data

- Backend authorization is authoritative; frontend guards are defense in depth.
  Never trust ownership from request bodies or query parameters.
- Do not silently change financial amounts, dates or ownership. Data migrations
  require explicit approval. Do not change authentication protocols or JWT claims
  without approval.
- AI/OCR must not persist a detected financial transaction without explicit user
  confirmation. Prefer local processing when feasible and sufficiently accurate.

## Git and PR workflow

- Start a dedicated branch from current `main`; keep PRs focused and reviewable.
  Never push directly to `main` or discard unrelated uncommitted work.
- Do not merge without owner review or explicit authorization.
- Explain significant architectural decisions, alternatives and risks before
  major changes. Stop for approval if a task needs broader architecture changes.
- Identify changed files, verification results and limitations in the PR/report.

## Current development workflow

The project currently runs locally. `npm run dev` uses existing nodemon to run
`tsx server.ts`, watching TS/JS/JSON while ignoring `dist/` and the default
node_modules/.git exclusions. Do not start the full bootstrap for verification.
`app.ts` exports the Express instance via `export =`; legacy JS imports remain
unchecked migration boundaries. `server.ts` preserves optional environment
values and the existing non-awaited MongoDB connection before listen. A narrow
URI assertion is erased; it does not validate or replace a missing runtime URI.

`npm run typecheck` emits nothing; `npm run build` outputs CommonJS only into
ignored `dist/`. Package main points to `dist/server.js` because the source JS
entry point was removed; this is not a deployment/start command. CI on Node.js 22
runs install, typecheck, build, compiled-app/middleware contracts and artifact checks.
Compilation does not prove legacy JavaScript type safety or DB bootstrap behavior.

`errors/authorizationError.ts`, `forbiddenError.ts`, `notFoundError.ts` and
`globalErrorHandler.ts` use strict TypeScript and `export =` so legacy CommonJS
consumers receive classes/functions directly, without `.default`. Preserve the
handler's legacy metadata semantics (`statusCode || 500`, original messages and
headersSent delegation); the narrow erased metadata assertion adds no runtime
validation. `tests/error-contract.test.cjs` covers compiled classes and handler
contracts alongside the unchanged HTTP smoke tests. The tsx CJS loader also
resolves these TypeScript modules from legacy JS consumers without bootstrap.

`middlewares/auth.ts` uses Express 5 RequestHandler, real jsonwebtoken and
`export = auth` for unchanged legacy require consumers. `types/express.d.ts`
adds only optional `Request.user?: unknown`: a verified JWT is not proof of
validated owner identity or checked data ownership. The erased secret assertion
preserves missing production JWT_SECRET behavior (verification fails); prefix,
replace-based extraction, secret selection, valid-payload assignment and both
error messages/punctuation remain unchanged. B3e explicitly adds owner-claim shape
validation; do not combine it with broader authentication redesign.
`tests/auth-contract.test.cjs` uses synthetic JWTs, real signing/verification,
a fixed clock, serial environment-sensitive cases and restored NODE_ENV/JWT_SECRET.
The previous 14 HTTP smoke and 21 error contracts remain unchanged.

Known follow-ups require separate approval: legacy non-production secret selection,
account existence/status and token revocation. B3e rejects malformed owner claims.
Future owner/security contracts must separately establish identity validation and
data ownership. This migration is not a complete authentication security audit.
`middlewares/cors.ts` uses RequestHandler and export =; `logger.ts` exports
exactly { requestLogger, errorLogger } with Express 5 types and bundled
Winston/express-winston definitions. app.ts uses import = require for the logger
object because a typed export = object cannot keep the old named TS import.
Middleware order and property lookup timing are unchanged.
CORS keeps the two exact origins and module-time DEFAULT_ALLOWED_METHODS capture;
undefined preflight values still reach Express and become the literal "undefined".
Logging creates File transports request.log/error.log with JSON at import.
B3c preserved defaults; B3g intentionally restricts their output (policy below).

`npm run test` aliases the explicit `test:smoke` command: the previous 57 tests
plus `cors-contract.test.cjs` and `logger-contract.test.cjs`, all using compiled
modules after build. CORS tests isolate env and require cache. Logger tests use
real Winston/File I/O in a temporary cwd, close loggers and await actual fs stream
close events before deleting logs; DB/network/listen are blocked. Existing app
smoke tests cover the real compiled app with these middleware.

The old express-winston defaults exposed headers/url/query and exception metadata;
B3g replaces them with the final serialization allowlist below. Other logging
channels are not audited. Unknown-origin OPTIONS still ends without allow-origin;
missing preflight configuration is not repaired.
JWT signature verification is not sufficient to establish valid owner identity.
Backend authorization and ownership require separate contract/security verification
before adding live multiuser financial classification.
Controllers, routes and models remain unchecked JavaScript.
Do not start B4 or another migration without architectural review.
No production deployment is configured or authorized.

## Financial ownership contracts (B3d)

`tests/financial-ownership-contract.test.cjs` exercises the real compiled app,
routes, Celebrate, JWT middleware and controllers for expense/income CRUD.
`tests/helpers/financial-persistence.cjs` replaces only model persistence calls:
it records model/method/filter/payload/options/query chains, requires a supplied
owner matching the independently expected HTTP actor, and selects or mutates
only fixtures matching the actual filter. It must never repair a missing owner.
Explicit assertions cover find/count and {_id, owner} mutations; create must
carry the JWT-derived owner. Unscoped methods and real DB execution are blocked.

Fixtures are fictional A/B owners, with serial alternating requests, pagination,
lean differences, filters, foreign/missing records and validation/auth failures.
The explicit test:smoke script includes this suite; npm run test stays its alias.
Build first. Temporary cwd/logs, real Winston/fs resources, env/model mocks and
ephemeral loopback listeners must be restored/closed. Never print auth headers.

This is a mocked-model HTTP/controller contract baseline, not MongoDB integration
or complete owner-isolation proof. B3e checks claim shape but not user existence;
balance/users/reference ownership, date boundaries, money precision and
logging redaction remain outside these contracts. These require separately
approved security/integration work.
Do not begin further JWT changes, real DB tests or B4 automatically.

## JWT owner claim validation (B3e)

After real jwt.verify, auth.ts requires a non-null, non-array object with an own
_id claim that is a primitive string of exactly 24 ASCII hex characters (either
case). A local unknown-based guard checks both length and regex: JavaScript $
can match before a trailing newline. No coercion, trimming, case normalization,
request-field fallback or database lookup is allowed. Invalid claims use the
existing AuthorizationError/401 message ending in ! before req.user assignment.
Valid requests retain the original payload and other claims unchanged.
Request.user remains optional unknown; a syntactically valid ID proves neither
account existence/status, token non-revocation nor ownership of any resource.

The original 22 JWT contracts retain their unrelated assertions; successful
fixtures now use valid synthetic hex IDs, and the former string/missing-ID/
object-ID acceptance cases intentionally expect rejection. Added real-JWT tests
cover malformed claims, uppercase IDs and login-compatible Mongoose ObjectId
serialization with seven-day expiry. HTTP ownership tests reject malformed
signed claims on GET/writes before persistence, including body/query/header
fallback attempts; the B3d persistence assertions and A/B tests stay intact.
No login/signing/secret/algorithm, financial controller, schema or owner-filter
change is authorized here. MongoDB integration needs separate review.

## Real MongoDB ownership integration (B3f)

B3f adds an explicitly authorized, separate `npm run test:integration` command.
Build first: it imports `dist/app.js`, never `server.ts` or `dist/server.js`.
The existing 144 database-free contracts and `test`/`test:smoke` meaning remain
unchanged. Real MongoDB is required to establish actual ObjectId casting, model
validation, queries/count/sort/pagination, updates/deletes and persisted isolation;
mocked B3d ownership contracts remain an independent baseline.

Use only a dedicated disposable test MongoDB, never an existing application DB.
The CI service is official MongoDB 7.0.45 pinned by digest in ci.yml, loopback-only
on Node 22, with tmpfs data directories, bounded health checks and no secrets.
Only explicit MONGODB_INTEGRATION_TEST=1 and the exact allowlisted
MONGODB_TEST_BASE_URI are accepted. No application URL fallback, credentials,
remote/SRV hosts, DB paths or query options; reuse of DATA_BASE_URL or
DATA_BASE_URL_LOCAL is rejected. Do not loosen these guards for convenience.

The helper generates a cryptographic unique database name per run, resets only
its fixtures, verifies exact active names before drop, verifies the database is
empty afterwards and closes its connection. Never add general database cleanup
scripts or reuse a generated name. Keep all real persistence/controllers/auth
unmocked in the financial integration suite. Test-owned loggers are silent to
avoid writing synthetic JWTs/request bodies; production logging policy is intact.
Release the ephemeral HTTP server, File transports, temp cwd/logs and env on every
exit path. Unreachable MongoDB or cleanup failure must fail, not skip or pass.

Both verify and mongodb-integration CI jobs must pass before merge readiness.
No claims of complete security auditing: user existence/status, JWT revocation,
other owner-scoped domains, concurrency, logging redaction, date boundaries,
money precision and frontend end-to-end remain unproven. Do not start B4 or
change production code automatically when an integration test exposes a defect;
report synthetic evidence and wait for architectural review.

B3f.1: `test:integration` uses the built-in programmatic test runner plus TAP
reporter and fails on every `test:fail` event, including parent suites/hooks.
Node 22 summary counters and a green job alone are insufficient evidence: inspect
all TAP results for parent failures, cancelled/skipped tests and cleanup errors.
`test:integration:runner` separately proves deliberate hook/file/test failures are
rejected, while diagnostic strings are not treated as failure events. Keep this
CI self-check and the 105 integration assertions intact. Suite hook contexts do
not support diagnostic(); use plain static logging only after cleanup assertions.
The expected Docker log-retrieval warning from --log-driver none is documented;
do not weaken isolation or logging safeguards to hide it.

## Safe File logging (B3g)

Preserve real express-winston/Winston File transports request.log/error.log,
JSON, export = { requestLogger, errorLogger }, next()/next(originalError), and
middleware order. Only fixed level/message (info/http_request or error/http_error),
enum method (GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD/CONNECT/TRACE, otherwise OTHER)
and request-only final integer statusCode 100–599 are allowed. Omit invalid
statuses; the error middleware runs before the final status is selected.

Disable built-in req/res metadata and exception serialization. Keep the fresh
allowlisted object immediately before format.json: do not copy arbitrary metadata,
toJSON or MESSAGE/SPLAT symbols. Exclude headers/auth/cookies, bodies, query,
user/params, full URLs including pathname, financial data, raw error messages,
stacks and properties. Paths and errors can contain user secrets or DB URIs;
field-name blacklists and query removal cannot enforce this policy.

Build then run test/test:smoke: 144 existing database-free tests plus 31 real-file
logging-security tests (full contents after actual flush/close, real compiled app,
JWT/Celebrate, synthetic loopback success/400/401/404/500, no persistence).
Keep B3f silent logging, DB guards, 105 integration cases and 5 runner self-tests
independent and unchanged. Keep Node 22 CI jobs and Docker logging configuration.

This audits only these two middleware outputs. Console/dependency/proxy logs and
external storage are outside the guarantee. Existing logs are not retroactively
sanitized; retention, rotation, filesystem permissions and old-log handling need
separate operational review. Reduced diagnostics are intentional. Do not add raw
exception/route identifiers without review or start B3h/B4 automatically.
