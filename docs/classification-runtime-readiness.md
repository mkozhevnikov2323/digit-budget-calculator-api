# P11 classification runtime: evidence and deployment boundary

H1–H10 are approved implementation decisions (P11 task). The older RFC's pending
labels describe its historical proposal, not current implementation permission.
No production migration, deployment, feature-flag or infrastructure change is
approved by this work. No production environment or database was contacted.

## Baseline

Backend main: `3dc55f148c7363ce284af91286c192752b5f6e45`; frontend main:
`58b89d77d5c7dc7a53aa99ff3ba199582b19dab1` (P10 merged). Existing app/server
never install the review protocol. Flags alone cannot create keys or authority.
P10 supplies only a single-process disposable test adapter. It does not attest
fleet durability, clock health, operator privileges, or backup/restore readiness.
No shared atomic operational store, secret manager, time attestation or deployment
manifest is configured in the repositories. External deployment facts are UNVERIFIED.

## Production-readiness matrix

| Requirement | Code baseline / permitted implementation | Production status / next evidence |
|---|---|---|
| Keyring | AEAD codec exists; P11 strict metadata/material boundary and lifecycle policy | Requires external secret-custody choice; provisioning/authorization UNVERIFIED |
| Fleet issuance | No approved durable authority; provider contract and synthetic multi-instance tests only | Requires external infrastructure choice and durable <=2^20/material budget across restart/restore |
| Trusted clock | Local Date.now is not time-health evidence; P11 external-evidence/monotonic boundary | Requires external evidence source and operator verification |
| Rotation/revocation | P11 bounded issuance/verification and monotonic transition checks | Durable revocation tombstones and rollout require external authority/operator verification |
| Deployment/proof era | Explicit immutable configuration binding, not Host/env fallback | Requires operator-approved namespace/era; incompatible restore needs new era |
| Mongo readiness | Existing exact manifest/listCollections/listIndexes inspection | Implementable with existing driver; target namespace/topology/FCV/privileges require operator verification |
| DDL/restore exclusion | Preflight cannot fence an administrator; operational admission provider required | Requires external maintenance design and separately approved procedure |
| Write drain | Explicit request-lifetime admission accounting can surround existing writer | Local drain is not fleet drain; every instance/financial writer must be fenced and verified |
| Account lifecycle | Real JWT exp + current account existence on new routes | Concurrent deletion/reused IDs/session revocation remain; erasure controls require operator verification/approval |
| Backup/restore | No approved operational backup evidence in repository | Requires verified restore rehearsal, retention/erasure replay, RPO/RTO and separate production approval |
| Safe telemetry | B3g File allowlist already tested; bounded internal operational events possible | External APM/proxy/ingress/SW capture remains UNVERIFIED |
| Deployment config | No production provider wiring; server bootstrap remains default-off | Secret custody, durable authority, trusted clock and explicit operator enablement required; deployment NOT APPROVED |

These categories are intentionally separate: **CODE READY**, **TESTED IN
ISOLATION**, **OPERATIONALLY VERIFIED**, **PRODUCTION ACTIVATION APPROVED**.
Synthetic success cannot promote either of the last two states.

## Configuration/lifecycle foundation

`domain/classification/runtimeConfiguration.ts` accepts unknown closed data only:
version, bounded ASCII deployment identity, positive policy revision, explicit
non-system database name, issuing kid (or null for recovery-only), 1–32 key
metadata rows. Accessors/proxies/inherited/extra fields, coercion, duplicate kids
and material aliases fail with code only. No secret is accepted as config data.

Each material identity is SHA-256 of the dedicated 32-byte key, used privately to
prevent changing kid from resetting the global per-material budget. Neither this
identity nor policy digest belongs in HTTP/telemetry. The secret provider must
supply the exact purpose/version/bytes. There is no environment lookup, key
creation or JWT_SECRET fallback. This boundary does not implement secret custody.

Issue intervals are bounded to 30 days; verification cannot exceed issueUntil +
24h. Exactly one active issuing key is required to issue; zero active keys permits
recovery-only operation. Revoked keys map to the existing disabled codec state.
Authenticated proof timestamps must lie within the approved key issue interval.
Old keys may verify admitted proofs for at most 300s after retirement, then only
reconcile within both their bounded lifetime and the codec's issuedAt + 86400.
Revocation always denies. Existing 300s TTL / 30s future skew / 24h recovery stay.

Policy transition checks require a strictly newer revision, stable material/kid
and original issue start, non-extended windows, retained tombstones and no retired
issuer reactivation. Incompatible restore additionally requires a new proof era.
The caller must supply the durable current policy; a previous config from process
memory is NOT anti-rollback authority. With the current conservative 32-row cap,
tombstone compaction is not automatic: a separately reviewed durable archive/checkpoint
policy is needed before exhausting the bounded ring. Silent material reuse is forbidden.

## Time foundation

The clock boundary consumes fresh, request/binding-specific UTC evidence from a
trusted provider. Local wall time and monotonic elapsed time are distinct. UTC
uncertainty must be <=1000ms, local skew <=2000ms; a validated sample is usable
for at most 5000ms. Missing/invalid/stale evidence gives no usable protocol time.
Rollback or excessive forward/monotonic jumps poison that runtime; provider loss
does not erase its rollback history. A new runtime still requires fresh external
evidence; cross-process high-water protection is the durable authority's job.
These conservative readiness thresholds do not extend the codec's accepted skew.

No production activation is added by importing these pure foundations.

## Operational implementation (dependent P11 PR)

Explicit provider contracts, bounded calls, admission/drain controls, safe event
serialization and non-mutating operational preflight are implemented in
`services/classificationRuntime/`. The existing HTTP protocol uses optional trusted
hooks; app/server remain unchanged and default-off. The P10 test-only bootstrap
now exercises this managed installer with synthetic providers. See the
[operator runbook](classification-operational-runbook.md) for exact controls,
external choices, evidence limitations and separately approved execution order.

Readiness is not a commit-time revocation/fencing guarantee. An already admitted
write can still finish after disablement; local drain is not fleet drain. Real
secret custody, durable fleet ledger/anti-rollback checkpoints, credible time,
DDL/restore exclusion, privileges, lifecycle and backups remain OPERATIONALLY
UNVERIFIED. Production activation is NOT APPROVED by code/tests/CI.

## P11.1 standalone Ubuntu adapters (dependent work)

Concrete built-in SQLite authority, protected credential-directory provider, strict
chrony health adapter and optional composition are added under `ubuntu/`. See
[ledger/rollback boundary](classification-ubuntu-ledger.md), [credentials/time](classification-ubuntu-security-providers.md)
and [disabled templates, preflight and restore procedure](classification-ubuntu-operations.md).
They do not change the baseline app/server wiring. Independently protected ledger/
time anchors are mandatory ports, NOT newly provisioned infrastructure. Home Ubuntu
storage/systemd/chrony/MongoFCV/custody/privileges remain UNVERIFIED, installation/
migration/deployment/activation NOT APPROVED. Synthetic tests cannot promote them.
