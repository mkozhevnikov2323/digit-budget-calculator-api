/** Explicit existing connection only. Metadata reads, no bootstrap/credentials/
 * source records, schema installation, role changes or automatic repair. */
import type { Connection } from 'mongoose';
import { validateRuntimeConfiguration } from '../../../domain/classification/runtimeConfiguration';
import { CLASSIFICATION_MANIFEST as manifest } from '../../../persistence/classificationManifest';
import { classificationOperationalPreflight } from '../preflight';
import { deploymentEvidence } from '../contracts';
export type UbuntuMongoReport = Readonly<{ code: 'metadata_ready' | 'migration_required' | 'configuration_unavailable'
  | 'connection_unavailable' | 'namespace_mismatch' | 'operator_evidence_missing' | 'metadata_mismatch'; message?: 'MIGRATION REQUIRED — NOT EXECUTED' }>;
export const inspectUbuntuMongo = async (connection: Connection, configuration: unknown, operatorEvidence: unknown): Promise<UbuntuMongoReport> => {
  const c = validateRuntimeConfiguration(configuration);
  if (!c.ok) return { code: 'configuration_unavailable' };
  try {
    const db = connection.readyState === 1 ? connection.db : undefined;
    if (!db) return { code: 'connection_unavailable' };
    if (connection.name !== c.value.databaseName || db.databaseName !== c.value.databaseName) return { code: 'namespace_mismatch' };
    const collections = await db.listCollections({ name: manifest.collectionName }, { nameOnly: false, maxTimeMS: 3000 }).toArray();
    if (!collections.length) return { code: 'migration_required', message: 'MIGRATION REQUIRED — NOT EXECUTED' };
    const evidence = deploymentEvidence(operatorEvidence);
    if (!evidence) return { code: 'operator_evidence_missing' };
    return { code: (await classificationOperationalPreflight(connection, c.value, evidence)).ok ? 'metadata_ready' : 'metadata_mismatch' };
  } catch { return { code: 'connection_unavailable' }; }
};
