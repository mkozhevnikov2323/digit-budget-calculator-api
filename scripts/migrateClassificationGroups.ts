/** Explicit offline migration. No dotenv, application configuration, bootstrap,
 * financial backfill, automatic activation, drop, syncIndexes or implicit repair. */
import mongoose, { type mongo, type Connection } from 'mongoose';
import { parseArgs } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import {
  GROUPS_MANIFEST,
  GROUP_RULES_MANIFEST,
  GROUP_DECISION_MANIFEST,
  manifestReady,
  type GroupManifest,
} from '../persistence/classificationGroupsManifest';
import { CLASSIFICATION_MANIFEST } from '../persistence/classificationManifest';
import {
  groupDecisionFromBson,
  groupFromBson,
  ruleFromBson,
  reject,
} from '../persistence/classificationGroups';
import { systemGroup } from '../domain/classification/groups';
import { bsonId } from '../persistence/classification';
export type MigrationOptions = {
  dbName: string;
  environment: 'local' | 'test';
  mode: 'dry-run' | 'apply' | 'verify' | 'rollback';
  backupConfirmed: boolean;
};
const manifests = [
  GROUPS_MANIFEST,
  GROUP_DECISION_MANIFEST,
  GROUP_RULES_MANIFEST,
];
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const legalName = (name: string) =>
  /^[a-zA-Z0-9_-]{1,63}$/.test(name) &&
  !['admin', 'config', 'local'].includes(name);
const indexesCompatible = async (db: mongo.Db, m: GroupManifest) => {
  const indexes = await db
    .collection(m.collectionName)
    .listIndexes({ maxTimeMS: 3000 })
    .toArray();
  return (
    indexes.length === m.indexes.length + 1 &&
    m.indexes.every((e) =>
      indexes.some(
        (i) =>
          i.name === e.options.name &&
          same(Object.entries(i.key), Object.entries(e.key)) &&
          i.unique === true &&
          !i.hidden &&
          !i.sparse &&
          i.expireAfterSeconds === undefined &&
          same(
            i.partialFilterExpression,
            'partialFilterExpression' in e.options
              ? e.options.partialFilterExpression
              : undefined,
          ) &&
          same(i.collation ?? { locale: 'simple' }, e.options.collation),
      ),
    )
  );
};
export const migrateClassificationGroups = async (
  db: mongo.Db,
  o: MigrationOptions,
) => {
  if (
    db.databaseName !== o.dbName ||
    !legalName(o.dbName) ||
    !['local', 'test'].includes(o.environment) ||
    (o.environment === 'test' &&
      !/^budget_ownership_it_[a-f0-9]{32}$/.test(o.dbName)) ||
    !['dry-run', 'apply', 'verify', 'rollback'].includes(o.mode) ||
    ((o.mode === 'apply' || o.mode === 'rollback') && !o.backupConfirmed)
  )
    reject(400, 'unsafe_migration_configuration');
  const plan: { collection: string; action: 'create' | 'extend' | 'ready' }[] =
    [];
  for (const m of manifests) {
    const info = await db
      .listCollections(
        { name: m.collectionName },
        { nameOnly: false, maxTimeMS: 3000 },
      )
      .toArray();
    if (!info.length) {
      if (o.mode === 'verify' || o.mode === 'rollback')
        reject(409, 'collection_missing');
      plan.push({ collection: m.collectionName, action: 'create' });
      continue;
    }
    if (info.length !== 1 || info[0].type !== 'collection')
      reject(409, 'unsupported_collection');
    const opts = info[0].options ?? {};
    if (
      Object.keys(opts).some(
        (k) =>
          ![
            'validator',
            'validationLevel',
            'validationAction',
            'collation',
          ].includes(k),
      ) ||
      !same(opts.collation ?? { locale: 'simple' }, { locale: 'simple' }) ||
      !(await indexesCompatible(db, m))
    )
      reject(409, 'incompatible_indexes_or_options');
    if (await manifestReady(db, m)) {
      plan.push({ collection: m.collectionName, action: 'ready' });
      continue;
    }
    const oldDecision =
      m.collectionName === 'operation_classifications' &&
      opts.validationLevel === 'strict' &&
      opts.validationAction === 'error' &&
      same(opts.validator, CLASSIFICATION_MANIFEST.options.validator);
    const oldRules =
      m.collectionName === 'classification_rules' &&
      (opts.validator === undefined || same(opts.validator, {})) &&
      (opts.validationLevel === undefined ||
        opts.validationLevel === 'strict') &&
      (opts.validationAction === undefined ||
        opts.validationAction === 'error');
    if (!oldDecision && !oldRules) reject(409, 'unexpected_validator');
    plan.push({ collection: m.collectionName, action: 'extend' });
  }
  const counts = { groups: 0, decisions: 0, rules: 0 };
  let hasV3 = false;
  // Inspect classification metadata only; never read or modify expense/income/balance documents.
  const reference = async (owner: string, ds: string, target: string) => {
    const sys = systemGroup(target);
    if (sys) {
      if (sys.dataset !== ds) reject(409, 'invalid_group_reference');
      return;
    }
    const row = await db
      .collection('classification_groups')
      .findOne(
        {
          owner: new mongoose.Types.ObjectId(owner),
          dataset: ds,
          groupId: target,
        },
        { maxTimeMS: 3000, promoteLongs: false },
      );
    if (!groupFromBson(row)) reject(409, 'missing_group_reference');
  };
  for (const p of plan) {
    if (p.action === 'create') continue;
    for await (const raw of db
      .collection(p.collection)
      .find({}, { maxTimeMS: 30000, promoteLongs: false, batchSize: 100 })) {
      if (p.collection === 'classification_groups') {
        if (!groupFromBson(raw)) reject(409, 'invalid_group_record');
        counts.groups++;
      } else if (p.collection === 'operation_classifications') {
        const d = groupDecisionFromBson(raw);
        if (!d) reject(409, 'invalid_decision_record');
        if (d.taxonomyVersion === 'financial-classification-groups-v3')
          hasV3 = true;
        if (d.groupId) await reference(d.owner, d.dataset, d.groupId);
        counts.decisions++;
      } else {
        const r = ruleFromBson(raw);
        if (!r) reject(409, 'invalid_rule_record');
        if (r.revision > 0) hasV3 = true;
        await reference(bsonId(r.owner)!, r.dataset, r.groupId);
        counts.rules++;
      }
    }
  }
  if (o.mode === 'rollback') {
    if (hasV3) reject(409, 'rollback_would_hide_group_assignments');
    await db.command({
      collMod: 'operation_classifications',
      validator: CLASSIFICATION_MANIFEST.options.validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await db.command({
      collMod: 'classification_rules',
      validator: {},
      validationLevel: 'strict',
      validationAction: 'error',
    });
    return {
      version: 'classification-groups-migration-v3',
      mode: o.mode,
      counts,
      catalogPreserved: true,
    };
  }
  if (o.mode === 'verify') {
    if (plan.some((p) => p.action !== 'ready'))
      reject(409, 'migration_incomplete');
    return {
      version: 'classification-groups-migration-v3',
      mode: o.mode,
      counts,
      verified: true,
    };
  }
  if (o.mode === 'apply') {
    for (const p of plan) {
      const m = manifests.find((m) => m.collectionName === p.collection)!;
      if (p.action === 'create') {
        await db.createCollection(m.collectionName, m.options);
        for (const e of m.indexes)
          await db
            .collection(m.collectionName)
            .createIndex(e.key as mongo.IndexSpecification, e.options);
      } else if (p.action === 'extend')
        await db.command({
          collMod: m.collectionName,
          validator: m.options.validator,
          validationLevel: 'strict',
          validationAction: 'error',
        });
    }
    for (const m of manifests)
      if (!(await manifestReady(db, m)))
        reject(503, 'post_migration_verification_failed');
  }
  return {
    version: 'classification-groups-migration-v3',
    mode: o.mode,
    counts,
    plan,
  };
};
export const parseGroupMigrationArguments = (
  args: string[],
): MigrationOptions => {
  const { values, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      db: { type: 'string' },
      environment: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'confirm-write': { type: 'boolean' },
      'backup-confirmed': { type: 'boolean' },
      verify: { type: 'boolean' },
      rollback: { type: 'boolean' },
    },
  });
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.kind !== 'option' || seen.has(t.name))
      reject(400, 'invalid_arguments');
    seen.add(t.name);
  }
  if (
    typeof values.db !== 'string' ||
    !legalName(values.db) ||
    !['local', 'test'].includes(values.environment ?? '') ||
    [
      values['dry-run'],
      values['confirm-write'],
      values.verify,
      values.rollback,
    ].filter(Boolean).length > 1
  )
    reject(400, 'invalid_arguments');
  return {
    dbName: values.db,
    environment: values.environment as 'local' | 'test',
    mode: values['confirm-write']
      ? 'apply'
      : values.rollback
        ? 'rollback'
        : values.verify
          ? 'verify'
          : 'dry-run',
    backupConfirmed: values['backup-confirmed'] === true,
  };
};
const main = async () => {
  let connection: Connection | undefined;
  try {
    const options = parseGroupMigrationArguments(process.argv.slice(2)),
      uri = process.env.CLASSIFICATION_GROUP_MIGRATION_URI;
    if (!uri) reject(400, 'missing_migration_uri');
    const parsed = new URL(uri!);
    if (
      parsed.protocol !== 'mongodb:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !['', '/'].includes(parsed.pathname) ||
      parsed.search ||
      parsed.hash
    )
      reject(400, 'unsafe_migration_uri');
    connection = mongoose.createConnection(uri!, {
      dbName: options.dbName,
      autoCreate: false,
      autoIndex: false,
      bufferCommands: false,
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
      socketTimeoutMS: 35000,
    });
    await connection.asPromise();
    const report = await migrateClassificationGroups(connection.db!, options);
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch {
    process.stderr.write(
      'classification_groups_migration_failed; details suppressed\n',
    );
    process.exitCode = 1;
  } finally {
    await connection?.close();
  }
};
if (require.main === module) void main();
