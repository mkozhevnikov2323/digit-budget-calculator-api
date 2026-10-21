# C3.3b-1 — isolated experimental review proof foundation

`domain/classification/reviewProof.ts` implements an independently testable subset
of [RFC §4](classification-http-review-proof-rfc.md#4-предлагаемый-aead-proof-v1).
It is **experimental and disconnected**: no application/startup/route imports,
HTTP endpoints, production adapters, key provisioning or application writes.
H1–H10 remain PENDING. Merging this foundation does not approve option A or enable
production issuance. C3.3a, existing GET/auth and D1–D10 are unchanged.

## Internal API and trusted caller

`createReviewProofFoundation(keyring, deploymentId, trust)` returns either a frozen
foundation with `issue(context, command)` / `verify(token, context, command)`, or
`{ok:false,error:{code}}`. No environment, filesystem, network, database, secret
manager or default clock/key lookup occurs. The only dependencies are Node built-ins
and existing pure domain validators. No JWT_SECRET use or bearer parsing/signing.

The factory's `ReviewProofTrust` is trusted **server configuration**, never client
data. Its three synchronous callbacks are mandatory and captured at construction:

- `resolveIssuance(context)` supplies a closed `TrustedIssuance`: `actor`,
  `credentialBinding`, `credentialExpiresAt`, `browserReviewContext` and `review`.
  `review` is the existing closed `VerifiedReview` projection. It must represent
  a **prior** authorized reviewed observation and the intent being issued. The
  issuer compares its owner/dataset/operation to the actor and validated command.
- `resolveVerification(context)` supplies a closed `TrustedProofContext` containing
  the same four context fields, independently of token/client claims. It must
  describe the **currently authenticated and admitted** caller.
- `nowSeconds()` supplies a healthy trusted nonnegative safe integer UTC time.
  Promise-valued callbacks, invalid/missing time and thrown exceptions fail closed.

These callbacks are ports, **not implemented production trust resolvers**. Structural
validation cannot authenticate their output. A caller that forwards request JSON,
client owner/digest, unverified decoded JWT or save-time source read through them
violates the boundary. Tests use private WeakMap handles; raw identity/JSON copies
are rejected by that synthetic boundary. The module does not itself authenticate,
fetch accounts/financial records, prove source ownership or human action.

The trusted adapter must compute `credentialBinding` as SHA-256 of compact UTF-8
JSON `['classification-review-credential',1,exactVerifiedBearer]`, **after** real
credential verification. Only that private lowercase 64-hex binding enters this
module. A primitive 64-hex string is not authentication. `credentialExpiresAt` must
be the actual verified JWT exp, not a fallback. Account existence, eligibility,
revocation and freshness remain future adapter responsibilities.

`issue` accepts the existing closed `ManualCommand`, validates stable D3 policy,
and returns only `{reviewProof,expiresAt}`. It generates proofId via CSPRNG UUID-v4;
callers cannot supply nonce/proofId/algorithm. `verify` authenticates, validates and
compares the entire command and trusted context, returning only the frozen existing
`VerifiedReview` projection. **That successful internal result contains a private
source digest and must never be returned to HTTP clients or logged.** No production
`resolveAuthenticatedOwner` / `resolveVerifiedReview` adapters are supplied.

## Wire, plaintext and validation contract

Wire: `crp1.<kid>.<nonce>.<ciphertext>.<tag>`, exactly five segments, at most 4096
ASCII characters. The only algorithm is AES-256-GCM: 32-byte key, fresh 12-byte
`randomBytes` nonce, full 16-byte tag. No negotiation, compression or version fallback.
Base64url is canonical and unpadded (decode then exact re-encoding); nonce/tag
lengths are exact, ciphertext is 1–2048 bytes. Invalid encodings/lengths are rejected
before crypto or trusted-context callbacks. Unknown/disabled keys give the same
safe `invalid_proof` result. No unauthenticated plaintext is parsed or used.

AAD is compact UTF-8 `['budget-classification-review',1,deploymentId,kid]`.
Deployment is explicitly supplied trusted proof-era identity (1–128 ASCII characters,
first alphanumeric, remainder alphanumeric or `._:-`); never request Host/origin.
Kid is exact 1–32 lowercase ASCII letters/digits/`_-`, starting alphanumeric. No
case folding, lookup by prefix, dynamic URL/path or external key fetching.

Authenticated plaintext uses RFC §4's closed field set, **in this order**:

```text
proofVersion, purpose, audience, deploymentId, proofId, actor,
credentialBinding, browserReviewContext, dataset, operationId,
sourceFingerprint, sourceFingerprintVersion, taxonomyVersion, kind, state,
assignment? {economicRole,layer}, expectedRevision, requestId, issuedAt, expiresAt
```

This experimental codec deliberately accepts only its fixed-order compact JSON
serialization: exact re-encoding must equal authenticated plaintext bytes. This
rejects duplicate keys (also nested), malformed UTF-8, whitespace, reordered keys,
alternate escaping and numeric spellings instead of allowing JSON last-key-wins.
Future issuers in another language must produce this documented subset or agree
on a new codec/version; generic JSON semantic equivalence is insufficient.

Fixed values are proofVersion 1, purpose `manual-classification-review`, audience
`classification-command-v1`, sourceFingerprintVersion 1, stable taxonomy
`financial-classification-v1`, kind `manual_classification`. Digests are lowercase
64-hex; actor and sealed operation IDs canonical lowercase 24-hex; proofId/browser
context/requestId canonical lowercase UUID-v4. Commands reuse existing validation
and ObjectId canonicalization; approved assignment is mandatory and stable-compatible,
otherwise wholly absent. Revision is explicit null or positive safe integer.
Only fingerprints/intent metadata enter ciphertext: no raw amount, financial date,
title, recipient, source description, comment or bearer.

All object inputs are closed own enumerable data records with plain/null prototype.
Accessors, hidden/symbol/extra/inherited properties, class instances and reflection
proxies are rejected without invoking getters/coercion/toJSON. Nested assignments,
context, observation, key definitions and array entries are inspected too. Returned
snapshots have no caller-owned mutable aliases; caller input is not frozen/mutated.
Owned null-prototype serialization avoids inherited toJSON hooks.

## Time and safe failures

Candidate H3 parameters: lifetime 1–300 seconds, future issuedAt skew at most 30
seconds, no expiry/write grace. Issuance uses trusted now and
`expiresAt=min(now+300,credentialExpiresAt)`. Both operations reject expired/missing
credential expiry. Verification requires `issuedAt<expiresAt`, lifetime<=300,
`issuedAt<=now+30`, `now<expiresAt`, and expiresAt<=current verified credential exp.
Times must be nonnegative safe integers (not -0); clock values too near integer
overflow fail closed. Exact credential/actor/browser/deployment and **all** intent
fields must match. There is no automatic renewal, rebase or classification approval.

Expiry is **resolver admission time**, not a MongoDB commit deadline. A future
accepted command may finish after exp. This module never authorizes expired proofs
for writes. RFC's bounded 24h read-only reconciliation needs a **separate mode and
adapter**, neither implemented here. Do not pass an expired proof to C3.3a execute
"just for replay": absent state could cause a new write.

Every validation/crypto failure is only `{ok:false,error:{code}}`, using the exported
`ReviewProofErrorCode` union. Error codes distinguish malformed configuration,
context/intent/claims, invalid cryptographic proof, time and expiry without keys,
digests, decrypted claims, exact credentials, driver/crypto messages or stacks.
No logging occurs. Successful opaque proofs are also sensitive capabilities and
must not enter logs/URLs/analytics/persistent browser storage.

## Keyring, rotation and unresolved operational blockers

Explicit keyring: `{activeKid:string|null,keys:[{kid,state,key?},...]}`, 1–32 entries.
Exactly one `active` entry must match activeKid, or activeKid is null and none are
active (verification-only mode). Active/`verify_only` entries require a plain
32-byte Node Buffer, copied descriptor-by-descriptor. Disabled entries must omit
key bytes. Duplicate IDs, unsupported states/representations, sparse/accessor arrays,
malformed/extra fields and ambiguous active selection are rejected.

Only the active key issues; active and verify-only keys verify. Disabled/unknown
keys never do. A ring instance is an immutable configuration snapshot: mutating
caller buffers/states does **not** rotate or revoke it. Rotation/revocation requires
constructing and atomically selecting a new foundation on **every instance** and
retiring all old references. There is no automatic timer, secret reload or emergency
revocation service. JS memory does not promise key zeroization, isolation from
process compromise or protection against heap/core dumps.

Fresh random nonces are not an absolute uniqueness guarantee or fleet quota. The
RFC's proposed <=2^20 issuances/key, <=30-day rotation, restart-safe fleet accounting,
distribution, compromised-key disable and proof-era rollback policy remain H4
blockers. No per-process counter claims to implement them. No persistent key is
generated; fictional public keys live only in tests. Production issuance must stay
disconnected until an approved coordinator/nonce policy and operational readiness
exist. This module does not implement reconcile-only keys or key issuance intervals.

## Guarantees and limits

AEAD detects tampering and hides authenticated claims from observers without the
key. It does not hide token length, prevent a legitimate owner computing a source
digest from known facts, provide an audit ledger, guarantee single use, or survive
key compromise. Possession of a proof is not independent authentication. Stolen
JWT/proof, XSS and an untrusted issuer remain threats.

Exact credential binding does not provide logout revocation: the same bearer bytes
may return after logout/re-login; browserReviewContext is client lifecycle metadata,
not a server session/epoch. UI guards cannot prove server-side invalidation.
Option A source PATCH/DELETE races and A→B→A undetected history remain; matching
fingerprints concern observed values, not transactional consistency. Human reading
or understanding cannot be cryptographically proven: a future frontend must display
the complete coherent snapshot/intent and require a separate final action, discard
old session/tab drafts, and handle unknown commits without blind retries.

Before any production adapter/wiring, **all H1–H10 remain pending**:

| Decision | Still required |
| --- | --- |
| H1 | Approve mechanism A versus alternatives; this is only an experiment |
| H2 | Approve prepare/apply/reconcile endpoints and exact DTO contracts |
| H3 | Approve TTL/skew, admission semantics and separate readonly recovery |
| H4 | Secrets/key lifecycle, fleet nonce budget, clocks, era and rollback |
| H5 | Accept credential/browser lifecycle residual risk or design server sessions |
| H6 | Account/exp eligibility and exact-bearer recovery policy |
| H7 | Authorized financial display, precision/limits and memory-only trade-offs |
| H8 | Frontend/parser/Origin/cache/error/rate integration and review |
| H9 | Production DB/readiness, write gate, DDL drain, erasure/restore and rollout |
| H10 | Authorize later production implementation and complete T01–T39 verification |

## Synthetic verification

Build then `node --test tests/review-proof.test.cjs`; the same tests are explicitly
included in `npm run test`. The literal fixture in `tests/fixtures/review-proof-v1.json`
was generated independently with Python cryptography AESGCM and compact json.dumps;
it contains public fictional key material, no real credentials or financial records.
Other authenticated malformed payloads use low-level Node crypto to reach validation
after tag verification. Diagnostics compare booleans/code-only failures, never dump
private tokens, keys or claims. No new dependencies were introduced.

These tests cover the isolated format/crypto/trust/time/key lifecycle contracts;
they **do not complete RFC T01–T39**, production session/HTTP/UI/DB/nonce coordination
or deployment verification. Existing application and integration suites remain
separate safeguards; passing them cannot authorize production use of this module.
