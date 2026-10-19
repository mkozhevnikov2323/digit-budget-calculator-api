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
- CommonJS with strict TypeScript entry points (`app.ts`, `server.ts`).
  Controllers, routes, models, middleware and errors remain legacy JavaScript;
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
- Run `npm run build` before `npm run test:smoke`: the isolated Express checks
  use compiled `dist/app.js` and Node's built-in test runner. They use real
  middleware, a temporary log directory and
  ephemeral loopback listeners, with database access blocked. Broader contract,
  authenticated ownership and financial tests remain future work.
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
runs install, typecheck, build, compiled-app smoke tests and artifact checks.
Compilation does not prove legacy JavaScript type safety or DB bootstrap behavior.

The next step (shared errors/middleware/auth typing) needs separate review; do
not begin it automatically. No production deployment is configured or authorized.
