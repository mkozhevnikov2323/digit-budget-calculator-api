# Classification domain foundation (C2.1)

> C3.1 update (2026-10-21): the owner approved RFC D1–D10, selecting Option A,
> SHA-256 v1 and current-record audit. Production operational gates remain unverified.
> C2.1 now accepts exact provisional and stable taxonomy versions without conversion;
> C2.3 still requires explicit matching policy. Stable D3 policy is defined separately
> in `stablePolicy.ts`; only stable records may pass the isolated persistence boundary.
> No application routes/writes are enabled.


`domain/classification.ts` is a pure, synchronous, versioned TypeScript module
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
- Supported versions are exactly `financial-layers-v1-provisional` and
  `financial-classification-v1`; the supplied version is preserved, never converted.
  Stable v1 was approved in C3.1. Support for both does not imply frontend wire
  compatibility or permission to persist provisional. Missing/future versions fail closed.

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

## Approved design and remaining boundaries

The owner approved RFC D1–D10 in C3.1 (2026-10-21), selecting Option A,
SHA-256 source fingerprint v1 and one current decision record without full audit
history. The current RFC is `docs/individual-operation-classification-persistence-rfc.md`.
The stable D3 matrix is explicit in `stablePolicy.ts`, not implicit in this structural
validator. The separate persistence mapper accepts only stable taxonomy and checks
its own storage envelope; storage fields remain unexpected in a domain decision.

C3.1 adds the isolated Mongoose model/manifest/mapper and disposable-DB tests.
It adds no HTTP endpoints, app writes, CAS handlers, migrations or frontend logic.
No source financial model or existing calculations are changed. Structural validation
still proves neither financial interpretation nor authorization/freshness.

Production namespace/topology, backup/restore, erasure/retention, exact migration
execution and rollout remain unverified. See `docs/classification-persistence-readiness.md`.
Source PATCH/DELETE races remain possible under the approved Option A; model/storage
validation cannot close them or establish an unchanged source edit history.

## Next steps (separately authorized implementation/operations)

1. Verify operational gates and explicitly authorize any production installation.
2. Add an owner-scoped classification read API and Option A stale handling.
3. Implement safe writes/CAS/idempotency under the approved protocol, with race tests.
4. Integrate frontend review with explicit confirmation and stale/conflict handling.
5. Keep full audit history and future rule/automation work separate.

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
