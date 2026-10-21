# Explicit classification business policy (C2.3)

> C3.1 update (2026-10-21): the owner approved RFC D1–D10, selecting Option A,
> SHA-256 v1 and current-record audit. Production operational gates remain unverified.
> C2.1 now accepts exact provisional and stable taxonomy versions without conversion;
> C2.3 still requires explicit matching policy. Stable D3 policy is defined separately
> in `stablePolicy.ts`; only stable records may pass the isolated persistence boundary.
> No application routes/writes are enabled.


`domain/classification/policy.ts` is pure, synchronous TypeScript compiled to
CommonJS. It imports only C2.1, performs no IO and is not connected to the app.
The generic evaluator has no implicit matrix, registry, fallback or global mutable
policy selection. C3.1 defines the explicitly selected stable D3 matrix separately
in `stablePolicy.ts`. The RFC candidate matrix exists **only in the synthetic tests**.

## Two separate validations

1. C2.1 `validateClassificationDecision` checks the complete decision shape,
   identities, state/assignment, role/layer and provisional taxonomy invariants.
2. `validateCompatibilityPolicy(unknown)` checks an explicit policy definition
   and returns an opaque immutable `ValidatedCompatibilityPolicy`. Then
   `evaluateClassificationDecision(unknown, validatedPolicy)` runs C2.1 and checks
   approved dataset/role compatibility under that exact policy.

Policy definition fields (all required, no defaults):

- `policyId`: explicit caller-managed versioned matrix identity; 1–80 ASCII chars,
  lowercase letter first, lowercase alphanumeric groups separated by `.`, `_` or
  `-`. No whitespace, trimming, coercion or case normalization. The trusted caller
  must assign a new identity when matrix semantics change; this module cannot prove
  identity uniqueness, product approval or where a definition came from.
- `policyVersion`: exactly `dataset-role-compatibility-v1`, the supported policy
  **structure** version, not approval of any matrix.
- `taxonomyVersion`: exactly provisional or stable; must match the evaluated decision
  exactly. Supporting both does not declare the versions equivalent.
- `allowedDatasets`: a complete map for all seven C2.1 economic roles. Each value
  is a dense ordinary array of zero, one or two distinct `expenses`/`incomes`
  strings. `[]` explicitly denies both; omission is rejected, never a default deny
  or allow. Caller ordering is preserved; it does not affect membership evaluation.

Closed plain/null-prototype objects, own enumerable data fields only; reject extra
keys, inherited fields, classes, symbols, accessors and hidden properties. Arrays
must have only their dense entries and length. Getters/toJSON/coercion hooks are
not evaluated; throwing reflection traps return safe codes. As in C2.1, arbitrary
JavaScript proxy traps are not sandboxed. All accepted data is copied and frozen;
validation neither mutates nor freezes the caller's input.

The opaque value uses a native private field and a private TypeScript constructor.
The evaluator requires it as a non-optional argument and rejects omitted/raw/cast/
cloned/proxied objects at runtime. There is no hidden registry or dependence on the
order of earlier calls. This guards accidental API misuse, not malicious code
execution or authentication. The opaque value is not a wire/storage format;
serialization/cloning loses its validation identity. Revalidate original definitions
from trusted code when needed, never accept a policy from an application user.

Results are `{ok:true,value}` or `{ok:false,error:{code}}`; errors contain no input,
private financial facts, arbitrary messages or stacks. C2.1 error codes pass through
unchanged. Invalid/missing validated policy gives `unvalidated_policy` before reading
the decision; structurally valid but disallowed approval gives `incompatible_assignment`.
Success contains a frozen C2.1 decision snapshot and the policy identity/version/
taxonomy used, never a persisted record. No decision is reclassified or repaired.

## Structure is not financial interpretation

An ordinary expense needs exactly one C2.1 layer; every other role requires
explicit null. Policy never overrides these invariants. Non-approved
`explicit_unclassified`/`cleared` need an explicit policy too, remain distinct and
do not undergo role compatibility because they have no assignment. `unreviewed`
and `proposed` remain invalid decision states, as in C2.1.

Category is not an input to policy: two expenses in `Транспорт` can be independently
`everyday` and `irregular`. Recurrence is evidence, not approval or a default layer.
The tests explicitly supply the RFC candidate (expense/loan issuance out;
income/loan repayment/refund in; transfers/capital both) and an alternative synthetic
matrix to prove that the evaluator does not select policy by name or hardcode it.
Neither fixture approves backend mappings or reinterprets loans, interest or capital.

Compatibility does not prove confirmation, authentication, source ownership,
freshness, CAS, persistence or that the chosen economic role is financially correct.

## Future controller boundary and unresolved architecture

A future trusted backend caller would
validate its explicitly chosen immutable definition, handle failure, and pass the
successful value to each evaluation. It must independently enforce server owner,
source existence/freshness and any approved write protocol. No controller is wired
up here. The generic evaluator has no default; the isolated durable boundary
explicitly selects the approved stable D3 policy.

Reference: merged [RFC #17](https://github.com/mkozhevnikov2323/digit-budget-calculator-api/pull/17),
`docs/individual-operation-classification-persistence-rfc.md`, backend baseline
`01168dae272b71718195c5bba4ad525b018ac022`.
Its D1–D10 decisions were approved in C3.1; their operational execution is not authorized
by domain/policy validation:

- D1–D2: persistence schema/states/index/migration preconditions.
- D3–D4: approved dataset/role matrix and stable taxonomy/mapping.
- D5–D7: source consistency, fingerprint and idempotency/CAS protocols.
- D8–D10: audit, retention/erasure/backup and migration/rollout/rollback.

`financial-classification-v1` is supported explicitly in C3.1, with no alias or
automatic mapping from provisional. Persistence accepts only stable. Any future
version, mapping or migration needs a separate reviewed change.
This module alone does not authorize database writes or operational rollout.

## Verification

```sh
npm ci
npm run typecheck
npm run build
node --test tests/classification-policy.test.cjs
npm run test
git diff --check
```

The existing explicit `test:smoke` command includes the new suite, so the existing
Node.js 22 CI runs it. No new dependency or CI configuration is needed.
