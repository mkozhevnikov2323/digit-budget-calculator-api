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
replace-based extraction, secret selection, payload assignment and both error
messages/punctuation remain unchanged. Do not add claim validation in a migration.
`tests/auth-contract.test.cjs` uses synthetic JWTs, real signing/verification,
a fixed clock, serial environment-sensitive cases and restored NODE_ENV/JWT_SECRET.
The previous 14 HTTP smoke and 21 error contracts remain unchanged.

Known follow-ups require separate approval: legacy non-production secret selection
and acceptance of signed strings/objects without a valid _id remain in place.
Future owner/security contracts must separately establish identity validation and
data ownership. This migration is not a complete authentication security audit.
`middlewares/cors.ts` uses RequestHandler and export =; `logger.ts` exports
exactly { requestLogger, errorLogger } with Express 5 types and bundled
Winston/express-winston definitions. app.ts uses import = require for the logger
object because a typed export = object cannot keep the old named TS import.
Middleware order and property lookup timing are unchanged.
CORS keeps the two exact origins and module-time DEFAULT_ALLOWED_METHODS capture;
undefined preflight values still reach Express and become the literal "undefined".
Logging still creates File transports request.log/error.log with JSON at import.
No filtering, redaction, defaults, transports or logging policies were changed.

`npm run test` aliases the explicit `test:smoke` command: the previous 57 tests
plus `cors-contract.test.cjs` and `logger-contract.test.cjs`, all using compiled
modules after build. CORS tests isolate env and require cache. Logger tests use
real Winston/File I/O in a temporary cwd, close loggers and await actual fs stream
close events before deleting logs; DB/network/listen are blocked. Existing app
smoke tests cover the real compiled app with these middleware.

Security follow-up: express-winston defaults include request headers/url/query
with an empty header blacklist; sensitive headers/query and error metadata may be
logged. This PR does not audit or change logging policy. Unknown-origin OPTIONS
still ends without allow-origin; missing preflight configuration is not repaired.
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
or complete owner-isolation proof. It does not validate JWT _id shape/user
existence, balance/users/reference ownership, date boundaries, money precision or
logging redaction. These require separately approved security/integration work.
Do not begin JWT hardening, real DB tests or B4 automatically.
