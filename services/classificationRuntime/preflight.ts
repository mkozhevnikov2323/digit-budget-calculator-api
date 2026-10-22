import type { Connection } from 'mongoose';
import { classificationReadiness } from '../../persistence/classificationReadiness';
import { CLASSIFICATION_MANIFEST as manifest } from '../../persistence/classificationManifest';
import type { RuntimeConfiguration } from '../../domain/classification/runtimeConfiguration';
import { deploymentEvidence, type DeploymentEvidence } from './contracts';
export type PreflightResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: 'namespace_unavailable' | 'manifest_mismatch' | 'incompatible_server' | 'operator_evidence_missing' }>;

/** Metadata reads ONLY. No init/DDL/DML/repair, source/user reads or privilege
 * probing by mutation. FCV/privileges/backup/erasure/maintenance must be independently
 * reviewed by a real operator provider; this module cannot invent that evidence. */
export const classificationOperationalPreflight = async (connection: Connection, config: RuntimeConfiguration,
  evidence: DeploymentEvidence): Promise<PreflightResult> => {
  try {
    if (!deploymentEvidence(evidence)) return { ok: false, code: 'operator_evidence_missing' };
    const db = connection.readyState === 1 ? connection.db : undefined;
    if (!db || connection.name !== config.databaseName || db.databaseName !== config.databaseName) return { ok: false, code: 'namespace_unavailable' };
    if (!await classificationReadiness(db)) return { ok: false, code: 'manifest_mismatch' };
    const collections = await db.listCollections({ name: manifest.collectionName }, { nameOnly: false, maxTimeMS: 3000 }).toArray();
    if (collections.length !== 1 || Object.keys(collections[0].options ?? {}).some(k => !Object.hasOwn(manifest.options, k)))
      return { ok: false, code: 'manifest_mismatch' };
    const indexes = await db.collection(manifest.collectionName).listIndexes({ maxTimeMS: 3000 }).toArray();
    const id = indexes.find(i => i.name === '_id_');
    if (indexes.length !== 2 || !id || Object.keys(id.key).length !== 1 || id.key._id !== 1
      || id.sparse || id.partialFilterExpression || id.expireAfterSeconds !== undefined || id.hidden
      || indexes.some(i => i.buildUUID !== undefined || i.ready === false)) return { ok: false, code: 'manifest_mismatch' };
    const build: unknown = await db.admin().command({ buildInfo: 1, maxTimeMS: 3000 });
    const hello: unknown = await db.admin().command({ hello: 1, maxTimeMS: 3000 });
    const version = build && typeof build === 'object' ? (build as { versionArray?: unknown }).versionArray : undefined;
    if (!Array.isArray(version) || version[0] !== 7 || evidence.mongoMajor !== 7 || evidence.fcvMajor !== 7
      || !hello || typeof hello !== 'object' || (hello as { msg?: unknown }).msg === 'isdbgrid') return { ok: false, code: 'incompatible_server' };
    return { ok: true };
  } catch { return { ok: false, code: 'namespace_unavailable' }; }
};
