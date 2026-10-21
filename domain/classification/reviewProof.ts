/** Experimental, disconnected AEAD foundation. Shape checks are NOT authentication.
 * Mandatory trusted callbacks are server configuration, never request data.
 * No application imports, IO, env, persistent keys or production adapters here. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { STABLE_TAXONOMY_VERSION } from '../classification';
import { readWriteFields, validateManualCommand, validateVerifiedReview,
  type ManualCommand, type VerifiedReview } from './writeCommand';

export const REVIEW_PROOF_VERSION = 1 as const;
export const REVIEW_PROOF_MAX_TTL_SECONDS = 300;
export const REVIEW_PROOF_MAX_FUTURE_SKEW_SECONDS = 30;
const MAX_PLAINTEXT = 2048, MAX_TOKEN = 4096, MAX_KEYS = 32;
const PURPOSE = 'manual-classification-review', AUDIENCE = 'classification-command-v1';
export type ReviewProofErrorCode = 'invalid_keyring' | 'invalid_configuration' | 'invalid_context'
  | 'invalid_observation' | 'invalid_command' | 'invalid_token' | 'invalid_proof' | 'invalid_claims'
  | 'context_mismatch' | 'intent_mismatch' | 'proof_expired' | 'invalid_time'
  | 'issuance_unavailable' | 'crypto_failure';
export type ReviewProofResult<T> = Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Readonly<{ code: ReviewProofErrorCode }> }>;
const fail = (code: ReviewProofErrorCode): ReviewProofResult<never> =>
  Object.freeze({ ok: false, error: Object.freeze({ code }) });
const pass = <T>(value: T): ReviewProofResult<T> => Object.freeze({ ok: true, value });

/** Supplied only AFTER credential authentication/admission. Binding is RFC §4's
 * hash of the exact verified bearer, not a client digest or a decoded JWT claim. */
export type TrustedProofContext = Readonly<{
  actor: string; credentialBinding: string; credentialExpiresAt: number; browserReviewContext: string;
}>;
/** Prior reviewed observation from one authorized source snapshot, NEVER a
 * save-time read minted into evidence. Its source facts are not accepted here. */
export type TrustedIssuance = TrustedProofContext & Readonly<{ review: VerifiedReview }>;
export interface ReviewProofTrust {
  /** Synchronous server-owned ports. Implementations must reject untrusted handles.
   * Returning a shape-valid object does not itself establish trust or human review. */
  resolveIssuance(context: unknown): unknown; // closed TrustedIssuance
  resolveVerification(context: unknown): unknown; // closed TrustedProofContext
  nowSeconds(): unknown; // trusted, healthy UTC clock; nonnegative safe integer
}
export type ReviewProofKey = Readonly<{
  kid: string; state: 'active' | 'verify_only'; key: Buffer;
}> | Readonly<{ kid: string; state: 'disabled' }>;
export type ReviewProofKeyring = Readonly<{ activeKid: string | null; keys: readonly ReviewProofKey[] }>;
export interface ReviewProofFoundation {
  issue(context: unknown, command: unknown): ReviewProofResult<Readonly<{ reviewProof: string; expiresAt: number }>>;
  /** Internal projection only; never serialize the successful result into HTTP/logs. */
  verify(token: unknown, context: unknown, command: unknown): ReviewProofResult<VerifiedReview>;
}

const commandFields = ['kind', 'dataset', 'operationId', 'state', 'assignment', 'expectedRevision', 'requestId'] as const;
const contextFields = ['actor', 'credentialBinding', 'credentialExpiresAt', 'browserReviewContext'] as const;
const claimFields = ['proofVersion', 'purpose', 'audience', 'deploymentId', 'proofId', 'actor',
  'credentialBinding', 'browserReviewContext', 'dataset', 'operationId', 'sourceFingerprint',
  'sourceFingerprintVersion', 'taxonomyVersion', 'kind', 'state', 'assignment', 'expectedRevision',
  'requestId', 'issuedAt', 'expiresAt'] as const;
const data = (input: unknown, fields: readonly string[]) =>
  types.isProxy(input) ? undefined : readWriteFields(input, fields);
const uuid = (x: unknown): x is string => typeof x === 'string' && x.length === 36
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const digest = (x: unknown): x is string => typeof x === 'string' && x.length === 64 && /^[a-f0-9]{64}$/.test(x);
const owner = (x: unknown): x is string => typeof x === 'string' && x.length === 24 && /^[a-f0-9]{24}$/.test(x);
const keyId = (x: unknown): x is string => typeof x === 'string' && x.length >= 1 && x.length <= 32
  && /^[a-z0-9]/.test(x) && !/[^a-z0-9_-]/.test(x);
// An explicit bounded opaque ASCII deployment/proof-era identifier, never a Host header.
const deployment = (x: unknown): x is string => typeof x === 'string' && x.length >= 1 && x.length <= 128
  && /^[a-zA-Z0-9]/.test(x) && !/[^a-zA-Z0-9._:-]/.test(x);
const seconds = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x)
  && x >= 0 && !Object.is(x, -0);
const owned = <T extends object>(x: T): T => Object.assign(Object.create(null), x);
const compact = (x: object): string => JSON.stringify(x);
const aad = (deploymentId: string, kid: string): Buffer => {
  const tuple = ['budget-classification-review', REVIEW_PROOF_VERSION, deploymentId, kid];
  Object.setPrototypeOf(tuple, null);
  return Buffer.from(compact(tuple), 'utf8');
};
const checkedCommand = (input: unknown): ManualCommand | undefined => {
  const r = data(input, commandFields);
  if (!r) return undefined;
  if (Object.hasOwn(r, 'assignment')) {
    const assignment = data(r.assignment, ['economicRole', 'layer']);
    if (!assignment) return undefined;
    r.assignment = assignment;
  }
  const c = validateManualCommand(r);
  return c.ok ? c.value : undefined;
};
const checkedContext = (r: Record<string, unknown> | undefined): TrustedProofContext | undefined => {
  if (!r || !owner(r.actor) || !digest(r.credentialBinding) || !uuid(r.browserReviewContext)
    || !seconds(r.credentialExpiresAt)) return undefined;
  return Object.freeze({ actor: r.actor, credentialBinding: r.credentialBinding,
    credentialExpiresAt: r.credentialExpiresAt, browserReviewContext: r.browserReviewContext });
};

/** Descriptor-only copy: no overridden Buffer methods, iterators or caller aliases. */
const copyKey = (input: unknown): Buffer | undefined => {
  if (!input || typeof input !== 'object' || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Buffer.prototype || !Buffer.isBuffer(input)) return undefined;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 32) return undefined;
  const key = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    const d = Object.getOwnPropertyDescriptor(input, String(i));
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value') || typeof d.value !== 'number'
      || !Number.isInteger(d.value) || d.value < 0 || d.value > 255) return undefined;
    key[i] = d.value;
  }
  return key;
};
type Ring = { activeKid: string | null; keys: Map<string, Buffer> };
const checkedRing = (input: unknown): Ring | undefined => {
  const r = data(input, ['activeKid', 'keys']);
  if (!r || !(r.activeKid === null || keyId(r.activeKid)) || !Array.isArray(r.keys) || types.isProxy(r.keys)
    || Object.getPrototypeOf(r.keys) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(r.keys, 'length')?.value;
  if (!Number.isInteger(length) || length < 1 || length > MAX_KEYS || Reflect.ownKeys(r.keys).length !== length + 1)
    return undefined;
  const keys = new Map<string, Buffer>(), seen = new Set<string>();
  let active: string | null = null;
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(r.keys, String(i));
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return undefined;
    const k = data(d.value, ['kid', 'state', 'key']);
    if (!k || !keyId(k.kid) || seen.has(k.kid)) return undefined;
    seen.add(k.kid);
    if (k.state === 'disabled') {
      if (Object.hasOwn(k, 'key')) return undefined;
    } else {
      if (k.state !== 'active' && k.state !== 'verify_only') return undefined;
      const key = copyKey(k.key);
      if (!key) return undefined;
      keys.set(k.kid, key);
      if (k.state === 'active') {
        if (active !== null) return undefined;
        active = k.kid;
      }
    }
  }
  return active === r.activeKid ? { activeKid: active, keys } : undefined;
};

type Claims = Readonly<{
  proofId: string; deploymentId: string; context: TrustedProofContext; review: VerifiedReview;
  command: ManualCommand; issuedAt: number; expiresAt: number;
}>;
/** Canonical compact JSON subset: fixed field order, no duplicate keys, whitespace
 * or alternative number/escape encodings. Owned null-prototype records defeat toJSON. */
const encodeClaims = (c: Claims): string => compact(owned({
  proofVersion: REVIEW_PROOF_VERSION, purpose: PURPOSE, audience: AUDIENCE, deploymentId: c.deploymentId,
  proofId: c.proofId, actor: c.context.actor, credentialBinding: c.context.credentialBinding,
  browserReviewContext: c.context.browserReviewContext, dataset: c.command.dataset, operationId: c.command.operationId,
  sourceFingerprint: c.review.sourceFingerprint, sourceFingerprintVersion: c.review.sourceFingerprintVersion,
  taxonomyVersion: STABLE_TAXONOMY_VERSION, kind: c.command.kind, state: c.command.state,
  ...(c.command.assignment ? { assignment: owned({ economicRole: c.command.assignment.economicRole,
    layer: c.command.assignment.layer }) } : {}),
  expectedRevision: c.command.expectedRevision, requestId: c.command.requestId,
  issuedAt: c.issuedAt, expiresAt: c.expiresAt,
}));
const decodeClaims = (plaintext: Buffer): Claims | undefined => {
  const r = data(JSON.parse(plaintext.toString('utf8')) as unknown, claimFields);
  if (!r || r.proofVersion !== REVIEW_PROOF_VERSION || r.purpose !== PURPOSE || r.audience !== AUDIENCE
    || r.taxonomyVersion !== STABLE_TAXONOMY_VERSION || !deployment(r.deploymentId) || !uuid(r.proofId)
    || !owner(r.operationId) || !seconds(r.issuedAt) || !seconds(r.expiresAt)
    || r.issuedAt >= r.expiresAt || r.expiresAt - r.issuedAt > REVIEW_PROOF_MAX_TTL_SECONDS) return undefined;
  // Credential expiry is trusted context, not a plaintext claim. Its upper bound is checked later.
  const context = checkedContext({ actor: r.actor, credentialBinding: r.credentialBinding,
    browserReviewContext: r.browserReviewContext, credentialExpiresAt: r.expiresAt });
  const command = checkedCommand({ kind: r.kind, dataset: r.dataset, operationId: r.operationId,
    state: r.state, ...(Object.hasOwn(r, 'assignment') ? { assignment: r.assignment } : {}),
    expectedRevision: r.expectedRevision, requestId: r.requestId });
  const review = validateVerifiedReview({ kind: 'verified_manual_review', owner: r.actor, dataset: r.dataset,
    operationId: r.operationId, sourceFingerprint: r.sourceFingerprint, sourceFingerprintVersion: r.sourceFingerprintVersion });
  if (!context || !command || !review.ok) return undefined;
  const c: Claims = { proofId: r.proofId, deploymentId: r.deploymentId, context, command, review: review.value,
    issuedAt: r.issuedAt, expiresAt: r.expiresAt };
  // Also rejects duplicate JSON keys and invalid UTF-8 without permissive parsing fallbacks.
  return Buffer.from(encodeClaims(c), 'utf8').equals(plaintext) ? c : undefined;
};
const base64url = (text: string, min: number, max: number): Buffer | undefined => {
  if (text.length < Math.ceil(min * 4 / 3) || text.length > Math.ceil(max * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length >= min && bytes.length <= max && bytes.toString('base64url') === text ? bytes : undefined;
};
const sameIntent = (a: ManualCommand, b: ManualCommand): boolean => a.kind === b.kind && a.dataset === b.dataset
  && a.operationId === b.operationId && a.state === b.state && a.expectedRevision === b.expectedRevision
  && a.requestId === b.requestId && a.assignment?.economicRole === b.assignment?.economicRole
  && a.assignment?.layer === b.assignment?.layer;

/** Factory validates/copies an explicitly supplied ring. No default trust, clock,
 * key source or deployment. Callbacks and key policy are a trusted configuration port. */
export const createReviewProofFoundation = (
  keyringInput: unknown, deploymentId: unknown, trustInput: ReviewProofTrust,
): ReviewProofResult<ReviewProofFoundation> => {
  let ring: Ring | undefined;
  try { ring = checkedRing(keyringInput); } catch { return fail('invalid_keyring'); }
  if (!ring) return fail('invalid_keyring');
  const trust = data(trustInput, ['resolveIssuance', 'resolveVerification', 'nowSeconds']);
  if (!deployment(deploymentId) || !trust || typeof trust.resolveIssuance !== 'function'
    || typeof trust.resolveVerification !== 'function' || typeof trust.nowSeconds !== 'function')
    return fail('invalid_configuration');
  const { resolveIssuance, resolveVerification, nowSeconds } = trust;
  const { activeKid, keys } = ring;
  const encryptionKey = activeKid === null ? undefined : keys.get(activeKid);
  const now = (): number | undefined => {
    try { const n: unknown = nowSeconds(); return seconds(n) && n <= Number.MAX_SAFE_INTEGER - 300 ? n : undefined; }
    catch { return undefined; }
  };
  return pass(Object.freeze({
    issue(contextInput: unknown, commandInput: unknown) {
      if (activeKid === null || !encryptionKey) return fail('issuance_unavailable');
      const command = checkedCommand(commandInput);
      if (!command) return fail('invalid_command');
      let r: Record<string, unknown> | undefined;
      try { r = data(resolveIssuance(contextInput), [...contextFields, 'review']); }
      catch { return fail('invalid_context'); }
      const context = checkedContext(r), time = now();
      if (!context) return fail('invalid_context');
      if (time === undefined) return fail('invalid_time');
      if (context.credentialExpiresAt <= time) return fail('invalid_context');
      const observation = data(r?.review, ['kind', 'owner', 'dataset', 'operationId', 'sourceFingerprint', 'sourceFingerprintVersion']);
      const review = validateVerifiedReview(observation);
      if (!review.ok) return fail('invalid_observation');
      if (review.value.owner !== context.actor || review.value.dataset !== command.dataset
        || review.value.operationId !== command.operationId) return fail('context_mismatch');
      const expiresAt = Math.min(time + REVIEW_PROOF_MAX_TTL_SECONDS, context.credentialExpiresAt);
      try {
        const plaintext = Buffer.from(encodeClaims({ proofId: randomUUID(), deploymentId, context,
          review: review.value, command, issuedAt: time, expiresAt }), 'utf8');
        if (plaintext.length > MAX_PLAINTEXT) return fail('invalid_claims');
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce, { authTagLength: 16 });
        cipher.setAAD(aad(deploymentId, activeKid));
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const token = ['crp1', activeKid, nonce.toString('base64url'), encrypted.toString('base64url'),
          cipher.getAuthTag().toString('base64url')].join('.');
        return pass(Object.freeze({ reviewProof: token, expiresAt }));
      } catch { return fail('crypto_failure'); }
    },
    verify(token: unknown, contextInput: unknown, commandInput: unknown) {
      if (typeof token !== 'string' || token.length > MAX_TOKEN) return fail('invalid_token');
      const parts = token.split('.');
      if (parts.length !== 5 || parts[0] !== 'crp1' || !keyId(parts[1])) return fail('invalid_token');
      const nonce = base64url(parts[2], 12, 12), ciphertext = base64url(parts[3], 1, MAX_PLAINTEXT), tag = base64url(parts[4], 16, 16);
      if (!nonce || !ciphertext || !tag) return fail('invalid_token');
      const key = keys.get(parts[1]);
      if (!key) return fail('invalid_proof');
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        decipher.setAAD(aad(deploymentId, parts[1])); decipher.setAuthTag(tag);
        // Do not parse/use any partial plaintext until final() authenticates the tag.
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch { return fail('invalid_proof'); }
      let claims: Claims | undefined;
      try { claims = decodeClaims(plaintext); } catch { return fail('invalid_claims'); }
      if (!claims) return fail('invalid_claims');
      let context: TrustedProofContext | undefined;
      try { context = checkedContext(data(resolveVerification(contextInput), contextFields)); }
      catch { return fail('invalid_context'); }
      if (!context) return fail('invalid_context');
      const time = now();
      if (time === undefined) return fail('invalid_time');
      if (context.credentialExpiresAt <= time) return fail('invalid_context');
      if (claims.deploymentId !== deploymentId || claims.context.actor !== context.actor
        || claims.context.credentialBinding !== context.credentialBinding
        || claims.context.browserReviewContext !== context.browserReviewContext) return fail('context_mismatch');
      if (claims.expiresAt > context.credentialExpiresAt || claims.issuedAt > time + REVIEW_PROOF_MAX_FUTURE_SKEW_SECONDS)
        return fail('invalid_time');
      if (time >= claims.expiresAt) return fail('proof_expired');
      const command = checkedCommand(commandInput);
      if (!command) return fail('invalid_command');
      if (!sameIntent(claims.command, command)) return fail('intent_mismatch');
      return pass(claims.review);
    },
  }));
};
