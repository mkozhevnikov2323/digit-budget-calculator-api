import { plain } from '../../domain/classification/runtimeConfiguration';
import type { RuntimeMode } from '../../domain/classification/runtimeConfiguration';
import type { LocalClock } from '../../domain/classification/runtimeClock';

/** Trusted server-to-provider requests only. Never accept these from HTTP.
 * Bindings/digests/material IDs must not become telemetry labels. */
export type Binding = Readonly<{ version: 'classification-operational-binding-v1'; deploymentId: string;
  revision: number; policyDigest: string; databaseName: string }>;
export type EvidenceRequest = Readonly<{ binding: Binding; requestId: string }>;
export type AdmissionRequest = EvidenceRequest & Readonly<{ mode: RuntimeMode }>;
export type ReservationRequest = EvidenceRequest & Readonly<{ materialId: string; maximum: number; issueUntil: number }>;
export interface SharedAuthority {
  /** Durable current policy, fleet rollout, administrative exclusion and reviewed
   * operator facts. Must reject stale revision/era, not echo arbitrary requests. */
  attest(request: EvidenceRequest, signal: AbortSignal): Promise<unknown>;
  /** Atomic admission vs maintenance/gates. A lease MUST NOT auto-expire while a
   * paused/partitioned writer could still commit. Crash/unknown leases block DDL
   * until an operator fences the writer and durably resolves them. */
  begin(request: AdmissionRequest, signal: AbortSignal): Promise<unknown>;
  end(request: AdmissionRequest, signal: AbortSignal): Promise<unknown>;
  /** Atomic durable consume BEFORE encryption, <=2^20 per MATERIAL over all
   * instances/restarts/config rollbacks. Duplicate ID is NOT a new grant; never
   * refund failures/timeouts. Requires independently protected backup/restore. */
  reserve(request: ReservationRequest, signal: AbortSignal): Promise<unknown>;
}
export interface SecretProvider {
  /** Purpose-specific keys, exact declared material identities; never JWT_SECRET. */
  load(request: EvidenceRequest, signal: AbortSignal): Promise<unknown>;
  /** Fresh current-version availability/revocation/custody evidence, not a flag. */
  check(request: EvidenceRequest, signal: AbortSignal): Promise<unknown>;
}
export interface ClockProvider {
  /** Fresh challenge/binding-specific UTC evidence with bounded uncertainty.
   * Durable high-water/restart/rollback policy is a provider requirement. */
  sample(request: EvidenceRequest, signal: AbortSignal): Promise<unknown>;
}
export const OPERATIONAL_EVENTS = ['runtime_ready', 'runtime_unavailable', 'keyring_unavailable', 'clock_unhealthy',
  'manifest_mismatch', 'issuance_admitted', 'issuance_denied', 'quota_exhausted', 'admission_denied',
  'lease_release_unavailable', 'drain_completed', 'drain_incomplete', 'write_applied', 'write_conflict',
  'write_unknown', 'reconcile_completed', 'reconcile_indeterminate'] as const;
export type OperationalEventType = typeof OPERATIONAL_EVENTS[number];
export type OperationalEvent = Readonly<{ version: 'classification-operations-event-v1'; type: OperationalEventType }>;
export type RuntimeProviders = Readonly<{ version: 'classification-providers-v1'; assurance: 'synthetic' | 'operator-verified';
  authority: SharedAuthority; secrets: SecretProvider; clock: ClockProvider;
  telemetry: Readonly<{ emit(event: OperationalEvent): void }>;
  /** Local measurement ONLY. Tests can control both clocks; this is never UTC evidence. */
  localClock?: LocalClock }>;
export type DeploymentEvidence = Readonly<{ mongoMajor: 7; fcvMajor: 7; privilegesReviewed: true;
  ownerLifecycleReviewed: true; backupsRestoreReviewed: true; privateTelemetryReviewed: true;
  unshardedReviewed: true; ddlExcluded: true; restoreExcluded: true; fleetPolicyCurrent: true }>;

export const deploymentEvidence = (input: unknown): DeploymentEvidence | undefined => {
  const fields = ['mongoMajor', 'fcvMajor', 'privilegesReviewed', 'ownerLifecycleReviewed', 'backupsRestoreReviewed',
    'privateTelemetryReviewed', 'unshardedReviewed', 'ddlExcluded', 'restoreExcluded', 'fleetPolicyCurrent'];
  const d = plain(input, fields);
  return d && Object.keys(d).length === fields.length && d.mongoMajor === 7 && d.fcvMajor === 7
    && fields.filter(k => k !== 'mongoMajor' && k !== 'fcvMajor').every(k => d[k] === true)
    ? d as DeploymentEvidence : undefined;
};
