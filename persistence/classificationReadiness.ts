/** Read-only inspection. No model init, DDL, repair, cache or write fallback. */
import { isDeepStrictEqual } from 'node:util';
import type { mongo } from 'mongoose';
import { CLASSIFICATION_MANIFEST as manifest } from './classificationManifest';

export const classificationReadiness = async (db: mongo.Db): Promise<boolean> => {
  const collections = await db.listCollections({ name: manifest.collectionName },
    { nameOnly: false, maxTimeMS: 3000 }).toArray();
  if (collections.length !== 1) return false;
  const collection = collections[0], options = collection.options;
  if (collection.type !== 'collection' || !options || options.capped || options.timeseries
    || options.validationLevel !== manifest.options.validationLevel
    || options.validationAction !== manifest.options.validationAction
    || !isDeepStrictEqual(options.validator, manifest.options.validator)
    // MongoDB omits the default simple collation from collection/index metadata.
    || !isDeepStrictEqual(options.collation ?? { locale: 'simple' }, manifest.options.collation)) return false;
  const indexes = await db.collection(manifest.collectionName).listIndexes({ maxTimeMS: 3000 }).toArray();
  return indexes.some(index => index.name === manifest.index.options.name
    && isDeepStrictEqual(Object.entries(index.key), Object.entries(manifest.index.key))
    && index.unique === true && (index.sparse === undefined || index.sparse === false)
    && (index.hidden === undefined || index.hidden === false)
    && index.partialFilterExpression === undefined && index.expireAfterSeconds === undefined
    && isDeepStrictEqual(index.collation ?? { locale: 'simple' }, manifest.index.options.collation));
};
