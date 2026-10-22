# P6 manual review/confirm/apply/reconcile

H1–H10 and R1–R4 were explicitly approved for implementation in the owner's P5–P9
task. The older RFC/foundation's PENDING/disconnected descriptions are historical.
Their approved wire DTOs and Option A/D7 limitations remain authoritative.

The three POST routes from RFC §6 are implemented. Prepare captures one owned
source object, uses its exact facts for presentation and its private fingerprint
for the sealed manual intent. Only prepare supplies the private issuance WeakMap;
apply cannot populate it. Apply delegates to C3.3a, whose trusted resolver verifies
the authenticated proof again at admission. Existing global JWT and classification
GET contracts, source schemas, logging allowlist and source CRUD are unchanged.

## Default-off operational boundary

`CLASSIFICATION_REVIEW_ENABLED`, `CLASSIFICATION_WRITE_ENABLED` and
`CLASSIFICATION_RECONCILE_ENABLED` must each equal `1` for their respective route.
Flags alone are insufficient: **app/server bootstrap deliberately installs no
protocol runtime or key resolver**. Missing server wiring returns 503 before DB
access. No production keys, values, secrets or external services are created.

The server-owned `installClassificationProtocol(app, connection, configuration)`
accepts an explicitly supplied purpose-specific keyring/era and mandatory ports:

- `ready(mode)`: attest current key rotation/revocation/era, clock health, writer
  drain/DDL exclusion, classification rollout and fleet safeguard policy;
- `reserveIssuance()`: atomically reserve a fleet-wide nonce/issuance budget before
  encryption, across every instance and restart; never refund failed encryption;
- `nowSeconds()`: the approved healthy UTC clock.

These ports are **not** implemented production governance. A boolean environment
flag or local counter cannot establish their truth. Production issuance/writes
remain unavailable until a reviewed deployment adapter provides actual shared
governance, secret-management, time, writer drain and key lifecycle controls.
Uninstall/reconfiguration requires operational drain: an already admitted write
can finish, just like expiry after admission. No startup DDL/repair is performed.

Safe local/CI activation is demonstrated exclusively in
`classification-protocol.integration.test.cjs`: generated disposable DB,
explicit test-only manifest installation, synthetic accounts/JWTs, disposable
CSPRNG AES keys, a controlled clock and shared synthetic quota callback. These
callbacks prove protocol behavior under supplied policy, not fleet readiness.
The existing guarded integration runner and cleanup are unchanged.

New endpoints use the P5 JSON/Origin/no-store transport and additional account
existence/unexpired finite JWT exp checks. Shared per-instance admission now permits
600/minute per owner so a bounded 50000-record history's 500 batches can complete;
4 active per owner,16 global,4096 tracked owners remain. This is not nonce governance.
Private upstream proxy/APM capture, TLS, key custody and production account lifecycle
are deployment checks, not properties proven by middleware tests.

## Apply and recovery

Proofs retain AES-256-GCM, exact credential/browser/actor/intent binding,300s TTL,
30s future skew and no write grace. Original `verify` behavior is unchanged.
`verifyRecovery` returns a deliberately separate `{review}` envelope, allowing
expired proof only until issuedAt+86400. It still requires current valid same
credential/account/key/era/context. Only reconcile uses it; no recovery path calls
`execute` or mutates either financial sources or classifications.

Reconcile reads source before decision, checks readiness twice, validates stored
intent/revision/private command hash and lastMutation. It returns latest_applied,
indeterminate, conflict or a safe unavailable/expired response, never false
not-applied. Missing/foreign/deleted source is uniform404 without orphan receipt.
Applied acknowledgements have confirmed:null, including stale/missing post-read.

CAS/D7 is current-record deduplication, not an unbounded execution ledger. Same
bearer logout/ABA, source A→B→A, PATCH/DELETE after final source read, account erasure
races, DDL/restore races and overwritten receipts retain the documented limits.
Abort does not roll back a commit. No automatic fresh command after uncertainty.

## RFC T01–T39 evidence map

HTTPxx labels in the new suite are local scenario identifiers, not a replacement
for RFC T IDs. All test material is fictional; assertions never dump proof/key/JWT.

| RFC | Focused evidence / boundary |
| --- | --- |
| T01 | HTTP01/07/20 + income HTTP scenario; real insert/update ack, confirmed:null |
| T02 | HTTP02/03/09/10; foreign sources and actors, forbidden owner/digest fields |
| T03 | operation/dataset substitution and aliases; existing identity/crypto contracts |
| T04 | HTTP08; every mutable intent field and browser context |
| T05 | HTTP14/15 plus existing write/source-fingerprint field-by-field regressions |
| T06 | HTTP05 and P5 exact binary64/date/comment projection tests; existing fixed vectors |
| T07 | controlled source PATCH during prepare; one owned display/hash snapshot |
| T08 | HTTP06 and oversize presentation test; no token/truncation |
| T09 | HTTP12/13 + existing proof future-iat/time boundary contracts |
| T10 | clock advances after resolver admission before real insert; applied acknowledgement |
| T11 | HTTP11 +181 existing bounded crypto/key/encoding contracts |
| T12 | existing authenticated malformed-claim/AAD/era/purpose tests; HTTP era test |
| T13 | verify-only/disabled rotation test + invalid keyring; operational adapter must enforce policy |
| T14 | reinstall independent runtime sharing key/era, apply/reconcile; no prior issuance map needed |
| T15 | exhausted quota and unhealthy ready/clock fail closed; real fleet accounting/rollback remains deployment BLOCKER |
| T16 | frontend session guards, unmount/page restore tests; same-token backend logout limitation retained |
| T17 | HTTP08/19/27 browser-context and competing-intent CAS; existing cross-tab lifecycle tests |
| T18 | HTTP17/18 double submission/replay; frontend synchronous in-flight guard |
| T19 | HTTP23 real commit then lost insert acknowledgement + existing write-service failure injection |
| T20 | HTTP24/25/38; expired apply denied, reconcile has mutation traps |
| T21 | HTTP22/25/26, indeterminate absent/overwritten; hash conflict |
| T22 | HTTP09/10/27, recovery checks same credential/actor |
| T23 | HTTP26/28, overwritten lastMutation and missing source; no history promise |
| T24 | existing D7 service tests; current-record-only bound documented |
| T25 | HTTP03/04/08/32, P5 duplicate JSON parser tests, existing UUID/revision overflow validators |
| T26 | HTTP21 and existing initial/update manual states; no delete |
| T27 | HTTP15/28 and existing write post-source missing tests |
| T28 | HTTP16/29, P5 concurrent PATCH/DELETE and ABA demonstrations |
| T29 | HTTP39 plus existing exact manifest/index/DDL race read/write tests; no repair |
| T30 | HTTP30 and verify-only issuance test; GET contract tests unchanged |
| T31 | HTTP13/27/31; actual account existence only; erasure/ID reuse residual race retained |
| T32 | HTTP32/34 and P5 transport tests; legacy CORS/preflight suite preserved |
| T33 | HTTP33, frontend escaped raw facts, original real File B3g security suite preserved; upstream capture UNVERIFIED |
| T34 | HTTP34, no-store/ETag assertions, frontend page restoration purge; external SW/proxy policy UNVERIFIED |
| T35 | frontend unmount/late-response/lost-ack tests, HTTP35; abort not rollback |
| T36 | HTTP36; private issuance map populated only by prepare |
| T37 | HTTP37 + stable DTO validators; no suggestions/provisional authority |
| T38 | HTTP38/other failed writes + existing BSON source-immutability assertions |
| T39 | guarded generated databases, event-aware TAP runner, cleanup assertions and parent-suite inspection |

Production fleet/governance and external infrastructure checks are intentionally
unimplemented, explicitly fail closed, and cannot be inferred from successful tests.
