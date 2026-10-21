# Experimental source fingerprint foundation (C2.4)

`domain/classification/sourceFingerprint.ts` is standalone strict TypeScript,
compiled to CommonJS. It imports built-in `node:crypto` and the existing C2.1
identity validator only. No app/model imports, IO, logging or persistence.
It is **not connected to live operations** and does not approve RFC D1–D10.

## Boundary and API

`fingerprintSourceOperation(unknown, version)` requires the explicit numeric
version `1`. Missing/unsupported/string versions fail closed. Success returns
only `{sourceFingerprint, sourceFingerprintVersion: 1}`; no raw facts/preimage.
`validateSourceFingerprint(unknown)` validates that exact two-field envelope.
`compareSourceFingerprints(unknown, unknown)` validates both envelopes and returns
`{matches: boolean}`. Invalid digests and unsupported versions are errors, never
silently treated as mismatches or upgraded. Every function returns `{ok:true,value}`
or `{ok:false,error:{code}}`, with stable codes only, no input values/messages/stacks.

Facts are a deliberately projected plain/null-prototype object with these keys:

- Required `owner`, `dataset`, `operationId`: C2.1 structural identity checks.
- Required `amount`: primitive finite Number >= 0, including negative zero.
  No strings, Number wrappers, BigInt, Decimal128, Long objects or numeric coercion.
  A representable Number above the safe-integer range is still fingerprinted as
  its exact binary64 value; this does not certify financial precision.
- Required `date`: genuine native Date, valid internal UTC epoch milliseconds,
  exactly Date.prototype, no own properties. Reject strings/numbers, invalid dates,
  subclasses, proxies, overridden methods and arbitrary BSON/Mongoose objects.
  Read with intrinsic `Date.prototype.getTime.call`, never Date serialization.
- Expenses require primitive `category`, `title`, `recipient` strings; incomes
  require primitive `source`. Fields belonging to the other dataset are rejected.
- Optional `comment`: absent, null or primitive string. Present undefined is invalid.

String values are exact stored facts, including empty/whitespace strings; the
fingerprint boundary does not reapply Mongoose's required/trim business behavior.
A future adapter must separately validate source-document eligibility. It must
not trim or repair the facts to manufacture a reviewable document.

Reject extra keys, symbols, inherited/class properties, invalid prototypes,
accessors and hidden fields. Raw documents, `_id`, `__v`, timestamps, taxonomy,
assignment and fingerprint metadata are not accepted as source facts. Never invoke
input getters, toJSON or coercion hooks. Reflection failures are contained without
exception data; arbitrary JavaScript proxy traps are not sandboxed.
Fresh canonical arrays have null prototypes so even inherited toJSON cannot run
during encoding. Caller objects/dates are never mutated or frozen; successful
envelopes/comparison values are fresh frozen objects with no mutable input aliases.

## Exact canonical v1 format

Follows merged [RFC #17](https://github.com/mkozhevnikov2323/digit-budget-calculator-api/pull/17),
§4, inspected at backend main `a1ebda6e871a2fe12e2d165532345be2292f44ae`.
Canonical bytes are compact ECMAScript JSON.stringify UTF-8, no BOM/newline:

```text
expenses: ["budget-classification-source",1,ownerHex,"expenses",operationHex,
           ["amount",["number64",bitsHex]],["date",["date-ms",millisecondsText]],
           ["category",["string",category]],["title",["string",title]],
           ["recipient",["string",recipient]],["comment",commentValue]]
incomes:  ["budget-classification-source",1,ownerHex,"incomes",operationHex,
           ["amount",["number64",bitsHex]],["date",["date-ms",millisecondsText]],
           ["source",["string",source]],["comment",commentValue]]
commentValue: ["absent"] OR ["null"] OR ["string",exactStoredComment]
```

- Identities: validated 24 ASCII hex strings, converted to lowercase for this
  canonical representation only. No trim; no change to C2.1 case-preserving values.
- Amount: exactly eight big-endian IEEE-754 binary64 bytes, 16 lowercase hex chars.
  No rounding, monetary conversion or decimal string formatting. `+0`/`-0` differ;
  `0.3` and `0.1 + 0.2` differ. This preserves observed bits, not unavailable
  precision already lost before input or distinctions normalized by storage.
- Date: canonical signed base-10 UTC epoch milliseconds string; no plus/leading
  zeros, zero is `0`. Includes valid negative dates and the native Date range.
  Date construction/parsing is the caller's responsibility, not this module's.
- Strings: no trim, case folding or Unicode normalization. JSON escapes embedded
  quotes/control characters/lone surrogates without ambiguous field delimiters.
- Digest: SHA-256 of those bytes, 64 lowercase hex chars, numeric version `1`.
  Fingerprint version is independent of taxonomy, policy version and decisionRevision.

Eight fixed expected hashes in `tests/source-fingerprint.test.cjs` were computed
independently with Python stdlib `struct.pack('>d', amount).hex()`, fixed UTC
milliseconds and `hashlib.sha256` over `json.dumps(tuple, ensure_ascii=False,
separators=(',', ':')).encode('utf8')`. The vectors use ordinary Unicode/JSON
characters where those Python bytes equal ECMAScript's; no runtime Python is
required by the suite. Tests use literal expected digests, not this implementation
or another JS canonicalizer to calculate expected results. Vectors cover expense,
income, signed zeros, adjacent fractions and NFC/NFD comments.

## Limits and future adapter requirements

SHA-256 is not encryption, authorization, a signature or anonymization. Low-entropy
financial facts can be guessed offline if digests leak. Do not log fingerprints,
preimages or raw facts, or use them as public IDs/metric labels. HMAC/key management
is a separately proposed alternative; no production fingerprint configuration is
created. D6 still needs approval of fields, version, privacy and algorithm.

Matching means equal observed canonical facts subject to hash collision limits.
It does not prove unchanged edit history: **A→B→A produces the same fingerprint**.
It does not establish source existence now, ownership, approved classification,
freshness, successful CAS or transactional consistency. Editing fuel in category
`Транспорт` changes its hash while fuel/everyday and repair/irregular manual
decisions remain untouched. Nothing auto-approves an unreviewed operation.

Current expense/income PATCH uses owner-filtered findOneAndUpdate without a shared
source revision; DELETE similarly has no classification protocol. Mongoose `__v`
does not count every such PATCH, and updatedAt is neither a collision-free revision
nor an atomic CAS protocol. Neither is included in the canonical facts.
PATCH/DELETE can race after any source read and before a classification write or
response. This pure module cannot close that window. RFC Option A's conservative
stale detection and tolerated race remain awaiting approval. Option B requires
separate writer/fence/transaction changes and verified topology; none is implemented.

A future owner-scoped adapter must be separately reviewed: derive owner from the
authenticated server principal; query source by `{_id,owner}` in the explicit
dataset; verify existence/ownership and source shape; inspect unsupported BSON
numeric types **before lossy conversion**; preserve stored strings, signed-zero
bits where available, comment presence and Date milliseconds; explicitly project
the supported facts and reject unhandled review-relevant fields. Never pass a
hydrated document or arbitrary user-supplied projection to this module. Convert
ObjectId explicitly only after verification. Recheck source according to an
approved freshness protocol; unavailable/invalid/version-unsupported facts fail
closed and cannot silently remain confirmed. Test deletion/ownership/restore races
and privacy independently; no future adapter is added here.

D1–D10 remain pending: storage/indexes, role matrix/stable taxonomy, consistency,
fingerprint/idempotency, audit/retention/erasure and migration/rollout. C2.1/C2.3
behavior, money logic, recurrence, HTTP, authentication and frontend are unchanged.

## Verification

```sh
npm ci
npm run typecheck
npm run build
node --test tests/source-fingerprint.test.cjs
npm run test
git diff --check
```

The new suite is appended to the existing test:smoke list and existing Node.js 22
CI without changing dependencies, existing tests or CI configuration.
