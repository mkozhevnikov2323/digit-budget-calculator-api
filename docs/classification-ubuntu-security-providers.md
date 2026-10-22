# P11.1 Ubuntu credential and time adapters

These standalone providers reuse P11 without changing AES-GCM, AAD, 300s proof TTL,
30s future skew, 24h recovery, material identity, auth or financial behavior.
No application bootstrap invokes them. No host packages/services/config are changed.

## systemd credentials

`createSystemdCredentialProvider(unknownConfig, explicitDirectory)` reads only a
purpose-specific credential manifest and declared raw 32-byte keys. A future trusted
composition root may pass systemd's CREDENTIALS_DIRECTORY path; it is a path selector,
not key bytes. There is no environment secret, JWT fallback or key-generation path.
Directory must be canonical, root/service-owned, mode0500/0700. Files regular,
single-link, no symlinks, root/service-owned, mode0400/0600; bounded descriptor reads
check size and concurrent modification. Parent directories/ACLs/mount namespaces
must be protected by the operator. A hostile service UID or root can read memory;
this design does not make AES keys nonexportable or guarantee heap zeroization.

Manifest credential `classification-aead.json` has exactly:

```json
{"version":"classification-credential-manifest-v1","purpose":"classification-review-aead-v1","kids":["<approved-kid>"]}
```

Replace placeholder with approved valid kid; **no key bytes** in JSON. For each
nonrevoked kid, systemd supplies `classification-key-<kid>` containing exactly32raw
bytes, NOT hex/base64/newline-terminated text. Exact SHA256 material identity is
verified through existing loadRuntimeKeyring; duplicate/extra/revoked manifest kids
fail. Old verify-only keys remain available only under their current approved policy.
Credential health reloads/revalidates files on each check; service-immutable mounts
make rotation an explicit drain/new-policy/restart operation, not an in-place edit.
Revoked keys must be removed from the manifest/mount; undeclared files are never read.

Compatibility checked against upstream NEWS:
[systemd247](https://github.com/systemd/systemd/blob/v247/NEWS) introduced
LoadCredential and CREDENTIALS_DIRECTORY;
[systemd250](https://github.com/systemd/systemd/blob/v250/NEWS) introduced
LoadCredentialEncrypted/systemd-creds. TPM2 is optional and MUST be inspected.
No assumption is made about the owner's Ubuntu/systemd version or availability
of encrypted credentials, locked memory, TPM, disk encryption or swap/core controls.

Prefer LoadCredentialEncrypted after verifying host-key/TPM mode and recovery.
Host-key-only encryption does not resist whole-disk theft of both ciphertext and
host key, nor provide independent quota anti-rollback. TPM binding needs a reviewed
backup/recovery strategy. Never silently switch to plaintext when decryption fails.
On systemd247–249, root-owned0400 sources via LoadCredential may be considered only
with explicit custody approval, encrypted-at-rest media/backups, dedicated UID,
protected parent paths and no application read access to long-term source files.
Older systemd: stop and propose an approved credential-delivery alternative/upgrade;
no unsafe automatic fallback. No production keys or provisioning commands included.

## chrony health

`createUbuntuChronyClock(config, absoluteRootOwnedChronyc, independentCheckpoint)`
uses execFile, fixed arguments, no shell, no inherited environment/credentials,
LC_ALL=C, 4096byte output, 800ms deadline and SIGKILL on timeout. It contacts only
127.0.0.1:323 with `-n -c ... tracking`. This is a read-only chrony monitoring
command, not an NTP/HTTP call to an external source. Chrony must already be installed,
its loopback monitoring enabled and its daemon/source configuration reviewed.
The selected executable and writable parent directories must be operator-protected.
No chrony package/service/config is installed or changed by this work.

Strict14-field CSV follows upstream chronyc tracking format (reviewed client.c).
Unknown format/version, extra line/field, NaN/Infinity/exponent, local-reference
mode, stratum0/16, leap/unsynchronized, stale/future reference, excessive offset,
delay/dispersion/skew or slow output fail closed. Reference age/update interval<=120s.
The conservative uncertainty around host wall time includes correction, last/RMS
offset, root delay/dispersion, skew growth, command/checkpoint latency and10ms margin;
<=1000ms. P11 still enforces <=2000ms local skew and <=5000ms evidence lifetime.
A long poll interval may intentionally deny readiness; review actual chrony settings
rather than relaxing cryptographic thresholds to match an unverified host.

Use fresh chrony evidence for every sensitive readiness check. Host measurements
compare Date.now, process.hrtime (Linux CLOCK_MONOTONIC) and /proc/uptime (includes
suspend), plus boot_id. Rollback, forward/monotonic discontinuity, boot change or
observable suspend>2s poisons the instance. Reboot requires fresh independently
approved evidence; local memory is never restart protection. Shorter discontinuities
remain within the documented uncertainty/skew envelope; this is not tamper-proof time.

`TimeCheckpoint.accept` is MANDATORY and must independently, durably enforce
current policy, boot approval and UTC high-water outside local restore scope.
Its receipt is fresh challenge/policy-bound. It must also verify approved chrony
source/trust/configuration. A forged `operator-verified` string or root-owned
chronyc executable alone cannot prove trustworthy NTP. Plain unauthenticated NTP
has spoofing risks; review NTS/authenticated sources and host administration before
approval. No external time authority is provisioned or simulated as production.
Missing checkpoint/source assurance blocks activation.

systemd-timesyncd/timedatectl NTPSynchronized alone lacks a portable sufficiently
precise uncertainty/source-authentication contract for this implementation. No
optimistic timesyncd fallback. If that is the actual host infrastructure, propose
an explicitly reviewed adapter or chrony installation separately. Kernel monotonic
is elapsed-time evidence only; SQLite high-water is useful but shares disk rollback.

## Evidence limitations

Tests use generated disposable key files and controlled CSV/boot/monotonic fixtures,
including invalid permissions/materials, rotation/revocation, desynchronization,
suspend, reboot, restart/high-water, provider failures and bounded timeout. They do
not verify actual systemd mounts/TPM, real chronyd source trust or the owner's clock.
Independent ledger and time anchors remain operational BLOCKERS; no paid service,
Redis, new Mongo schema, production key or activation has been introduced.
