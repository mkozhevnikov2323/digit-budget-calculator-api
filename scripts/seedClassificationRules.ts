/** Operator-only seed. Importing this file never connects or writes. */
import mongoose, { Types, mongo, type Connection } from 'mongoose';
import { parseArgs } from 'node:util';
import { createClassificationRuleModel } from '../models/classificationRule';
import { classificationRuleReadiness } from '../persistence/classificationRuleReadiness';

const initialRules = [
  ['Продукты', 'everyday'], ['Аптеки', 'irregular'], ['Фастфуд', 'irregular'],
  ['Чаевые', 'irregular'], ['Подарки', 'irregular'], ['Бар', 'irregular'],
  ['Подписки', 'everyday'], ['Такси', 'everyday'],
] as const;
const validOwner = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 24 && /^[a-fA-F0-9]{24}$/.test(value);
export type SeedReport = {
  mode: 'dry-run' | 'write'; total: number; created: number; skipped: number;
  wouldCreate: number; errors: number; errorCode?: string;
};
/** errors includes rules blocked/unverified after a failure; never retries a write. */
export const seedInitialClassificationRules = async (
  connection: Connection, ownerInput: string, confirmWrite = false,
): Promise<SeedReport> => {
  const write = confirmWrite === true;
  const report: SeedReport = { mode: write ? 'write' : 'dry-run', total: initialRules.length,
    created: 0, skipped: 0, wouldCreate: 0, errors: 0 };
  const blocked = (errorCode: string): SeedReport => ({ ...report,
    errors: report.total - report.created - report.skipped - report.wouldCreate, errorCode });
  if (!validOwner(ownerInput)) return blocked('invalid_owner');
  const owner = new Types.ObjectId(ownerInput);
  try {
    const db = connection.readyState === 1 ? connection.db : undefined;
    if (!db) return blocked('database_unavailable');
    const Model = createClassificationRuleModel(connection);
    const ready = async () => connection.readyState === 1 && connection.db === db
      && await classificationRuleReadiness(db, Model.schema.indexes());
    if (!await ready()) return blocked('indexes_not_ready');
    if (!await db.collection('users').findOne({ _id: owner }, { projection: { _id: 1 }, maxTimeMS: 3000 }))
      return blocked('owner_not_found');
    for (const [category, layer] of initialRules) {
      const doc = new Model({ owner, dataset: 'expenses', category, layer,
        economicRole: 'ordinary_expense', enabled: true });
      await doc.validate();
      if (!await ready()) return blocked('indexes_not_ready');
      // null matches both missing title and an existing null index key. Never overwrite.
      const filter = { owner, dataset: 'expenses', category: doc.category, title: null };
      const exists = () => Model.exists(filter).maxTimeMS(3000).exec();
      if (await exists()) { report.skipped++; continue; }
      if (!write) { report.wouldCreate++; continue; }
      if (!await ready()) return blocked('indexes_not_ready');
      try {
        await doc.save({ w: 'majority', wtimeout: 3000 });
        report.created++;
      } catch (error) {
        // A concurrent creator may win this exact unique key. No update/upsert fallback.
        if (error instanceof mongo.MongoServerError && error.code === 11000 && await exists()) {
          report.skipped++; continue;
        }
        return blocked('write_failed_outcome_may_be_unknown');
      }
    }
    return report;
  } catch { return blocked('seed_failed'); }
};

export const parseSeedArguments = (args: string[]) => {
  const { values, tokens } = parseArgs({ args, strict: true, allowPositionals: false, tokens: true,
    options: { owner: { type: 'string' }, db: { type: 'string' },
      'dry-run': { type: 'boolean' }, 'confirm-write': { type: 'boolean' } } });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option' || seen.has(token.name)) throw new Error('invalid_arguments');
    seen.add(token.name);
  }
  if (!validOwner(values.owner) || typeof values.db !== 'string'
    || !/^[a-zA-Z0-9_-]{1,63}$/.test(values.db) || ['admin', 'config', 'local'].includes(values.db)
    || values['dry-run'] && values['confirm-write']) throw new Error('invalid_arguments');
  return { owner: values.owner, dbName: values.db, confirmWrite: values['confirm-write'] === true };
};

const main = async () => {
  let connection: Connection | undefined;
  let confirmWrite = false;
  try {
    const options = parseSeedArguments(process.argv.slice(2));
    confirmWrite = options.confirmWrite;
    const uri = process.env.CLASSIFICATION_RULES_MONGODB_URI;
    if (!uri) throw new Error('missing_connection_configuration');
    // Dedicated explicit configuration; never falls back to an application URI or dotenv.
    connection = mongoose.createConnection(uri, { dbName: options.dbName, autoCreate: false,
      autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000, socketTimeoutMS: 5000 });
    await connection.asPromise();
    const report = await seedInitialClassificationRules(connection, options.owner, options.confirmWrite);
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.errors) process.exitCode = 1;
  } catch {
    // Never print an exception/URI, owner, credentials, financial facts or existing rules.
    process.stdout.write(JSON.stringify({ mode: confirmWrite ? 'write' : 'dry-run',
      total: initialRules.length, created: 0, skipped: 0, wouldCreate: 0, errors: initialRules.length,
      errorCode: 'invalid_configuration_or_connection' }) + '\n');
    process.stderr.write('Seed blocked: check explicit owner/db arguments, connection configuration and database availability.\n');
    process.exitCode = 1;
  } finally {
    if (connection) try { await connection.close(); }
    catch { process.stderr.write('Seed connection cleanup failed.\n'); process.exitCode = 1; }
  }
};
if (require.main === module) void main();
