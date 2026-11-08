/** Read-only catalog check. Never creates a collection/index or caches readiness. */
import { isDeepStrictEqual } from 'node:util';
import type { Schema, mongo } from 'mongoose';
import { CLASSIFICATION_RULE_COLLECTION } from '../models/classificationRule';

export const classificationRuleReadiness = async (
  db: mongo.Db, expectedIndexes: ReturnType<Schema['indexes']>,
): Promise<boolean> => {
  const collections = await db.listCollections({ name: CLASSIFICATION_RULE_COLLECTION },
    { nameOnly: false, maxTimeMS: 3000 }).toArray();
  if (collections.length !== 1 || collections[0].type !== 'collection'
    || collections[0].options?.capped || collections[0].options?.timeseries
    || !isDeepStrictEqual(collections[0].options?.collation ?? { locale: 'simple' }, { locale: 'simple' })) return false;
  const indexes = await db.collection(CLASSIFICATION_RULE_COLLECTION).listIndexes({ maxTimeMS: 3000 }).toArray();
  return expectedIndexes.every(([key, options]) => indexes.some(index =>
    index.name === options.name && isDeepStrictEqual(Object.entries(index.key), Object.entries(key))
    && index.unique === true && !index.sparse && !index.hidden && index.expireAfterSeconds === undefined
    && isDeepStrictEqual(index.partialFilterExpression, options.partialFilterExpression)
    && isDeepStrictEqual(index.collation ?? { locale: 'simple' }, options.collation)));
};
