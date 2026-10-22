# P11.1 single-host Ubuntu operations — procedure only, NOT deployment approval

Read [ledger design](classification-ubuntu-ledger.md), [security providers](classification-ubuntu-security-providers.md),
[P11 runbook](classification-operational-runbook.md), [persistence readiness](classification-persistence-readiness.md)
and [HTTP protocol](classification-http-protocol.md). H1–H10, OptionA/source races,
manual confirmation and unknown-outcome semantics are unchanged. Owner host was
unavailable; no SSH, services, packages, real keys, databases, flags or backups touched.

## Read-only operator preflight (later, explicit host access authorization required)

Run locally; inspect results privately. Do not paste environment values, URIs,
credential contents, application logs, proofs or financial documents into an issue.
Replace placeholders only after identifying actual installed names/paths. Do not
run systemctl cat/show Environment, cat .env, printenv or journalctl as inventory.

| Fact | Read-only command/procedure |
|---|---|
| Ubuntu | `cat /etc/os-release` |
| systemd | `systemd --version` |
| Node binary/release | `command -v node`; `node --version`; inspect root-owned absolute executable/parents with `stat`/`namei -l` |
| Mongo installed/service | `mongod --version`; `systemctl list-unit-files --type=service --no-pager` and privately identify the Mongo unit; `systemctl show <MONGO_UNIT> -p ActiveState -p SubState -p User -p Group -p FragmentPath` |
| Backend unit/account | `systemctl show <BACKEND_UNIT> -p ActiveState -p SubState -p User -p Group -p FragmentPath -p WorkingDirectory`; review startup method privately, excluding credential-valued arguments/environment from collected output |
| Bind addresses | `ss -ltn` (numeric listeners only, no process command lines); privately map approved backend/Mongo ports |
| Mount/flush semantics | `findmnt -T <APPROVED_STATE_DIRECTORY> -o TARGET,FSTYPE,OPTIONS`; `stat -c '%a %u %g %F' <STATE_DIR> <LEDGER_FILE>`; `namei -l <STATE_DIR>`; inspect ACLs with `getfacl -p <STATE_DIR>`; check free bytes/inodes with `df -h <STATE_DIR>` and `df -i <STATE_DIR>` |
| Time service | `systemctl is-active chrony.service systemd-timesyncd.service`; `command -v chronyc`; `chronyc -v`; `timedatectl show -p NTPSynchronized -p NTP -p Timezone` for inventory ONLY |
| Chrony health | `chronyc -n -c -h 127.0.0.1 -p 323 -t 1 tracking`; privately review source authentication/NTS, daemon permissions, poll policy and localhost monitoring; do not dump auth-key files |
| Account isolation | `id <SERVICE_USER>`; verify no unrelated service uses this UID, no source-code/credential/ledger parent paths writable by other users |
| DB identity/configuration | Operator privately identifies actual namespace and approved connection mechanism; report only namespace match/mismatch, bind policy and privilege checklist. Never dump config/connection values |
| Environment NAMES ONLY | Locally parse approved env/config sources without printing RHS. Do not dump `/proc/*/environ`, process args or raw .env. See bounded procedure below |
| Backups | Privately inventory existing mechanism, encryption, independent media, retention/erasure handling, last successful disposable restore, approved RPO/RTO; no schedule changes |

Optional env-file NAME-only inventory (explicit reviewed file, not secret discovery):

```python
from pathlib import Path
import re
for line in Path('<APPROVED_ENV_FILE>').read_text().splitlines():
    match = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=', line)
    if match:
        print(match.group(1))
```

Do not send file contents on parse errors. This lists names only, does not prove
that values or runtime configuration are safe. Permission/unknown format => UNVERIFIED.

Mongo checks use an already approved explicit connection with interactive password
prompt/approved credential mechanism; no credentials in URI/argv/logging. Metadata
only: `ping`, `buildInfo`, `hello`, current connection namespace, targeted
listCollections/listIndexes. A separate authorized operator (NOT newly privileged
Node service) checks `getParameter:{featureCompatibilityVersion:1}`, actual roles,
standalone/replica/sharding/write concern/durability, catalog and backup constraints.
Do not query financial/users collections or print raw role/config objects; return
only closed pass/fail/version facts. `inspectUbuntuMongo(connection, config,
reviewedEvidence)` reuses exact manifest inspection. FCV/evidence booleans must come
from actual current operator verification; the adapter cannot establish them itself.
Absent namespace returns exactly **MIGRATION REQUIRED — NOT EXECUTED**. Metadata
readiness is not operational readiness or authority to migrate/activate.

## Disabled systemd templates and composition

`ops/ubuntu/*.example` are intentionally noninstallable until placeholders and
unknown host facts are reviewed. No [Install] target, no production secrets/flags,
no default database, account, port, path or Mongo service name. Prefer systemd>=250
with reviewed encrypted credentials; systemd247–249 needs separately approved custody.
Do not install, enable, daemon-reload or start these artifacts as part of this task.

`openUbuntuProviders(config, options)` is a concrete optional composition helper:
existing SQLite state + independent ledger/time ports + chronyc executable + credential
directory + current operator evidence + private telemetry. It performs no genesis,
writer claim, gate enablement, HTTP installation or Mongo connection. Missing evidence
fails closed. Its operator-verified assurance label means trusted external ports
were explicitly supplied, not that this repository proves their real deployment.

Future separately reviewed entrypoint must open the approved connection, obtain
fresh externally approved policy, exact metadata, existing durable state, credentials,
independent anchors and actual time evidence; claim one fresh writer incarnation;
installSecureClassificationRuntime only after operational approval with current
explicit gates. No existing app/server import activates it. A PID file/systemd unit
name is not fencing: use a dedicated UID, protect binaries/paths, inventory all
systemd/manual/PM2/cron/container writers and privileged administrators. No app UID
should be able to alter its unit, executable, time daemon or long-term credential source.

Templates use NoNewPrivileges, strict root/home protections, private tmp, private state
and logs, explicit write paths, restrictive umask and core dumps disabled. Review exact
filesystem/systemd support before use. Winston paths are relative to cwd, so the template
selects a private log working directory with absolute code entrypoint. Existing dotenv
resolution must be reviewed privately; do not move secrets to log cwd. ProtectSystem
must leave ledger rollback journal and application log writes available. Network namespace
is shared intentionally for local Mongo/chrony. Bind loopback; review frontend origin,
TLS/remote exposure/firewall separately. No public operational metrics/health endpoint.

SIGTERM entrypoint closes shared gates, disables all local admissions and awaits
`shutdownUbuntuRuntime(runtime, ledger, timeout)`: successful local drain, zero durable
leases, maintenance entry, writer release, connection close. Failure => STOP/unknown,
never success/rollback. Handler must not exit successfully on false. SendSIGKILL=no
prevents stop timeout from being mistaken for successful drain; operator must independently
fence a stuck process and DB sessions. SIGKILL/power loss retains orphan writer/leases;
Restart=on-failure cannot steal them. There is deliberately no automatic expiry or force
release. If an admitted DB write may be in progress, killing Node does not prove it
cannot commit; retain uncertainty and reconcile read-only later.

## Exact migration proposal — NOT executed on a real database

Preconditions: explicit namespace/release/operator approval, all financial/classification
writers and privileged maintenance actors fenced, global gates closed, local/durable leases
accounted for (unknown leases block), actual version7/FCV7/unsharded topology/privileges,
consistent encrypted backup and independent disposable restore/erasure checks. Review
standalone fsync/write-pause/write concern and disk/device behavior. No schema auto-repair.

The ONLY proposed DDL is the existing compiled immutable manifest:

```js
// PROPOSAL ONLY — execution requires separate authorization and explicit target.
const { CLASSIFICATION_MANIFEST: m } = require('<REVIEWED_RELEASE>/dist/persistence/classificationManifest');
// approvedDb.createCollection(m.collectionName, m.options)
// approvedDb.collection(m.collectionName).createIndex(m.index.key, m.index.options)
```

Namespace `operation_classifications`, exact validator/options and unique
`ux_owner_dataset_operation` on ordered owner/dataset/operationId. Keep ordinary _id
index. No source backfill, app model/schema/index changes, autoCreate/autoIndex, source
updates or destructive rollback. Existing/nonempty/mismatching namespace STOP: do not
drop, dedupe, collMod or recreate. After separately approved empty creation/index build,
repeat exact metadata preflight, confirm no extra options/indexes/build and record only
safe pass/fail. Partial interruption stays disabled; inspect approved missing steps before
continuing. Application identity gets only approved scoped source/account reads and
classification find/insert/update, not DDL, drop, bypassDocumentValidation, broad admin
or operational-store access in Mongo. Migration/FCV/backup operators are separate identities.
Rollback code/UI/gates only; preserve classification documents/catalog and financial data.

## Backup, restore, erasure and independent security state

Financial backup covers actual existing users/expenses/incomes/reference data and
classifications/catalog. This backend has **no dedicated loan collection/model**;
loan labels in frontend analytics do not prove a separate backend domain. Inventory
actual namespaces privately; never invent/export financial data for this task.
Operational state covers approved key identities/material custody/lifecycle/tombstones,
policy revisions/era, <=2^20 spent budget, request IDs, unresolved admissions/writer,
UTC/boot high-water and independent checkpoints. These have different restore rules.

1. Close new prepare/apply, then reconcile admissions as required for full backup.
   Drain every writer; independently fence manual/old processes and maintenance actors.
   A true local drain is NOT permission for Mongo DDL. Unknown lease/outcome => STOP.
2. Verify consistent Mongo backup procedure for actual standalone/replica topology;
   write-pause/cold backup or approved snapshot strategy, catalog and erasure retention.
   Do not assume copying live WiredTiger files is a consistent backup.
3. Preserve current operational security state separately; SQLite backup only while
   quiescent or via reviewed SQLite online-backup facility. Never copy a live journal
   casually. Independent anchor is NOT backed up/restored with the same host disk.
4. Restore Mongo first into a SEPARATE disposable instance, with production credentials,
   network/keys/feature gates unavailable. Verify metadata, owner isolation, counts and
   BSON/checksum integrity privately, erasure replay and account-ID nonreuse.
   No financial values or key material in reports/artifacts.
5. Compare current external revision/material checkpoints and time high-water against
   surviving ledger. Old/missing/inconsistent ledger or whole-machine recovery =>
   block issuance. Never rewind anchor, decrease counter, delete DB or create a fresh
   ledger for old material. Preserve old state for investigation.
6. If independent authority cannot establish complete history, permanently retire old
   materials, fence ALL old issuers and recover with independently approved never-used
   random keys, strictly newer policy/new deployment era and retained revocation
   tombstones. Existing approvals/proofs may become unrecoverable; disclose that cost.
   This is an operator-approved recovery design, not an implemented reset button.
7. An uncertain prior write remains unknown. Reconcile only with supported current
   account/key/era/proof and existing read-only endpoint; no fresh automatic command.
   Incompatible restore/new era can preclude reconciliation. Current-record receipts
   are not full history; source ABA/PATCH/DELETE/erasure races remain.
8. Re-run all preflight, independent anchors, credential rotation/clock/roster/manifest,
   backup integrity and external privacy checks. Re-enable only after separate reviewed
   operational verification, migration approval (if required) and activation approval.

Affordable encrypted offline backups: reviewed restic/borg repositories on detachable
media, or approved encrypted export/archive to offline LUKS media, with separately held
recovery credentials and restore rehearsals. Evaluate tool availability/cost/retention;
no new package, cron/timer, cloud purchase or schedule is installed. Two encrypted copies
on one rollbackable disk are not independent security evidence. TPM host-bound credentials
may not decrypt on replacement hardware; plan custody/recovery before provisioning.
Synthetic BSON/SQLite restore tests prove code paths only, never home-host RPO/RTO.

## Concrete owner decisions still needed

- Supply read-only host facts above; choose actual service UID/paths/loopback ports and
  verify storage/fsync/ACL/mount/core/swap behavior and systemd compatibility.
- Approve installation of NEW local SQLite datastore separately from code review.
- Select a credible independent monotonic ledger/time trust anchor or approve a reviewed
  alternative recovery architecture; no all-local file can prove whole-disk anti-rollback.
  Without it secure runtime activation remains blocked, even on a single-user machine.
- Approve real key custody/provisioning/rotation and chrony source authentication/boot
  policy after version/hardware review; no automatic plaintext/timesyncd downgrade.
- Verify Mongo version/FCV/namespace/least privileges, all writers/admin exclusion,
  account erasure/nonreuse and encrypted offline backup/disposable restore/RPO/RTO.
- Separately approve any real migration, deployment and feature activation. No PR merge
  or successful CI authorizes any of those actions.
