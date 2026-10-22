/** Additional eligibility for NEW routes; the global JWT contract is unchanged. */
import type { Request } from 'express';
import { Types, type mongo } from 'mongoose';
import { validateOperationIdentity } from '../domain/classification';

export const authenticatedClassificationOwner = async (req: Request, db: mongo.Db): Promise<string | null> => {
  const principal = req.user;
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) return null;
  const id = Object.getOwnPropertyDescriptor(principal, '_id'), exp = Object.getOwnPropertyDescriptor(principal, 'exp');
  const owner: unknown = id && Object.hasOwn(id, 'value') ? id.value : undefined;
  const expires: unknown = exp && Object.hasOwn(exp, 'value') ? exp.value : undefined;
  const checked = validateOperationIdentity({ owner, dataset: 'expenses', operationId: '000000000000000000000000' });
  if (!checked.ok || typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= Date.now() / 1000) return null;
  const canonical = checked.value.owner.toLowerCase();
  const account = await db.collection('users').findOne({ _id: new Types.ObjectId(canonical) }, { projection: { _id: 1 }, maxTimeMS: 3000 });
  return account ? canonical : null;
};
