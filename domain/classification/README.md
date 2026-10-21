# Classification domain foundation (C2.1)

`domain/classification.ts` is a pure, synchronous, provisional TypeScript module
compiled to CommonJS. It imports nothing, performs no IO and is not wired into
the application. This is neither a MongoDB document schema nor a public API DTO.

## Guarantees

- Identity is the exact `(owner, dataset, operationId)` tuple. Dataset is explicitly
  `expenses` or `incomes`; an identical ID in the two datasets denotes different
  operations. Owner and operation ID must be primitive strings of exactly 24 ASCII
  hex characters. Both cases are accepted and preserved, without trimming or
  normalization. This checks syntax only, not existence, canonical database
  equality, account status or ownership. No identity-key/equality policy is added.
- `ClassificationAssignment` separates the economic role from the spending layer.
  `ordinary_expense` requires exactly one of `everyday`, `irregular`, `emergency`,
  `major_goals`, `long_term_capital`. The six other provisional roles require
  explicit `layer: null`; missing values are not silently converted to null.
  `unknown` is not an approved role.
- `ClassificationDecision` is a discriminated union. `approved` requires an
  assignment. `explicit_unclassified` and `cleared` forbid the assignment field
  entirely (including null/undefined). They remain different decisions.
- `decisionOrigin: manual` is mandatory. Recommendations, category rules and
  recurrence evidence have no approved-decision representation in this module.
  This marker does not prove that a human actually confirmed the input.
- `DecisionRevision` is a branded positive safe integer. It is intended to be
  server-owned and represents decision concurrency only. Shape validation does
  not establish authority or perform incrementing, historical ordering or CAS.
  It cannot substitute for MongoDB `__v`, `updatedAt`, a source revision, frontend
  `caller_local` revision, session generation or recurrence algorithm version.
- The only supported version is `financial-layers-v1-provisional`, mirroring the
  inspected frontend vocabulary. This explicitly provisional **domain** version
  does not approve a stable server taxonomy, persistence/wire format or compatibility
  with frontend decision objects. Missing/future/other versions fail closed.

`validateOperationIdentity`, `validateDecisionRevision`,
`validateClassificationAssignment`, `validateClassificationDecision` take
`unknown` and return either a complete owned value or `{ ok: false, error: { code } }`.
No coercion, defaults, authorization, financial interpretation or partial values.
Errors contain only stable codes, never raw input, IDs, messages, amounts or stacks.
Validation follows a fixed field order after rejecting invalid object shapes.

Object boundaries accept only plain or null-prototype objects with own enumerable
data properties and the exact permitted keys. Inherited/class properties,
accessors, hidden fields, symbol keys and unexpected keys (including `__proto__`,
`constructor`, `$set`, category and financial facts) are rejected. Getters, toJSON
and coercion hooks are not called. Throwing proxy reflection traps are contained
without exposing exceptions; arbitrary proxy traps can themselves execute caller
code and are not sandboxed by a validator. Successful object values are fresh,
frozen snapshots; inputs are never mutated or frozen by validation.

## Product semantics and boundaries

A category is a source label, not a classification identity or an approved role.
Two expenses in `Транспорт` may independently be fuel/`everyday` and car
repair/`irregular`. Category and other financial facts are deliberately absent
from this decision contract.

Recurrence reports historical observations, not approval, roles or layers. This
module does not infer any assignment from frequency, amount, category or source.
Recommendations remain proposals: no resolver or automatic conversion into manual
decisions exists here. Future policy must preserve explicit user decisions over
suggestions; an explicitly unclassified operation must not be silently approved.

- `approved`: structurally valid manually approved assignment; future reads must
  still establish owner access, compatible policy and source freshness.
- `explicit_unclassified`: deliberate refusal to classify; not approved.
- `cleared`: deliberate reset of a decision; not approved and not an explicit
  refusal. Preserve decision revision/history continuity rather than treating
  reset as physical deletion. This module does not store an audit history.
- `unreviewed`: conceptual absence of a decision record, not an accepted decision
  state or a fabricated default record. No DB records are created here.

## Decisions still open

Inspected backend main: `b550ac8afc7164768507b35bece0c6a555a46929`.
[RFC #17](https://github.com/mkozhevnikov2323/digit-budget-calculator-api/pull/17)
was an open draft, not merged, at implementation time. Its document was inspected
at `ba5bd12ec3f68ca052bc9111f4b99be433d1d4a5`, path
`docs/individual-operation-classification-persistence-rfc.md`. Its proposed
collection/index/model is not approved by C2.1.

Still require separate architectural approval:

- Dataset ↔ economic role compatibility matrix. **Validation is intentionally
  structural, not business approval of every role/dataset combination.** The
  frontend's provisional matrix is not imported as backend policy. Do not expose
  this validator as a sufficient write-API guard before this policy is agreed.
- Stable server taxonomy/version evolution and explicit frontend mapping.
- MongoDB schema, unique index, migration/backup/rollback and topology.
- Source fingerprint representation/version, canonical facts, algorithm,
  confidentiality and freshness/conflict behavior. No fingerprint type/field is
  accepted yet: accepting arbitrary strings would imply unsupported guarantees.
- Conservative stale detection vs strict cross-collection consistency with source
  PATCH/DELETE; transactions/source revision, CAS and retry/idempotency protocols.
- Full append-only audit history, orphan/retention policy and future rules.

No BSON schema, indexes, models, routes, authentication, calculations, recurrence
engine or frontend files are changed. No money/date processing, persistence,
source hashing or recommendations are implemented.

## Next steps (separate approvals)

1. Approve the MongoDB schema and index migration.
2. Add an owner-scoped classification read API.
3. Agree source freshness and decision concurrency protocols.
4. Add a safe write API after compatibility, consistency and audit decisions.
5. Integrate frontend review with explicit approval and stale/conflict handling.

## Verification

Build before running compiled tests:

```sh
npm ci
npm run typecheck
npm run build
node --test tests/classification-contract.test.cjs
npm run test
git diff --check
```

The normal `test:smoke` list includes the new suite, so existing Node.js 22 CI
executes it through `npm run test` without workflow or dependency changes.
