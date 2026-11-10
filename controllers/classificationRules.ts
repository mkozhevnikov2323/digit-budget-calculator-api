import type { RequestHandler } from 'express';
import { Error as MongooseError, mongo, Types, type Connection } from 'mongoose';
import { createClassificationRuleModel } from '../models/classificationRule';
import { classificationRuleReadiness } from '../persistence/classificationRuleReadiness';

const fields = ['dataset', 'enabled', 'category', 'title', 'source', 'economicRole', 'layer'];
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 24 && /^[a-fA-F0-9]{24}$/.test(value);
const inputFields = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
};
export const createClassificationRulesController = (connection: Connection) => {
  const Model = createClassificationRuleModel(connection);
  const handler = (action: 'list' | 'create' | 'update' | 'delete'): RequestHandler => async (req, res) => {
    res.set('Cache-Control', 'no-store'); res.vary('Authorization');
    let attempted = false;
    try {
      const principal = req.user;
      const ownerId: unknown = principal && typeof principal === 'object'
        ? Object.getOwnPropertyDescriptor(principal, '_id')?.value : undefined;
      if (!id(ownerId)) { res.status(401).json({ message: 'Необходима авторизация.' }); return; }
      const owner = new Types.ObjectId(ownerId);
      if (Object.keys(req.query).length || ((action === 'update' || action === 'delete') && !id(req.params.id))) {
        res.status(400).json({ message: 'Некорректный запрос правила.' }); return;
      }
      const body = action === 'create' || action === 'update' ? inputFields(req.body) : null;
      if ((action === 'create' || action === 'update') && (!body || !Object.keys(body).length)
        || ((action === 'list' || action === 'delete') && req.body !== undefined)) {
        res.status(400).json({ message: 'Некорректные поля правила.' }); return;
      }
      const db = connection.readyState === 1 ? connection.db : undefined;
      const unavailable = () => res.status(503).json({ message: 'Хранилище правил недоступно.', persistence: attempted ? 'unknown' : 'not_applied' });
      if (!db) { unavailable(); return; }
      if (action === 'list') {
        res.json({ rules: await Model.find({ owner, groupId: { $exists: false } }).setOptions({ strictQuery: false }).sort({ _id: 1 }).maxTimeMS(3000).lean().exec() }); return;
      }
      if (!await classificationRuleReadiness(db, Model.schema.indexes())) { unavailable(); return; }
      const filter = { _id: new Types.ObjectId(req.params.id as string), owner, groupId: { $exists: false } };
      if (action === 'delete') {
        attempted = true;
        const result = await Model.deleteOne(filter).setOptions({ strictQuery: false }).maxTimeMS(3000).exec();
        if (!result.acknowledged) { unavailable(); return; }
        if (!result.deletedCount) { res.status(404).json({ message: 'Правило не найдено.' }); return; }
        res.status(204).end(); return;
      }
      const doc = action === 'create' ? new Model({ ...body, owner }) : await Model.findOne(filter).setOptions({ strictQuery: false }).maxTimeMS(3000).exec();
      if (!doc) { res.status(404).json({ message: 'Правило не найдено.' }); return; }
      if (action === 'update') {
        if (body && Object.hasOwn(body, 'dataset') && body.dataset !== doc.dataset) {
          res.status(400).json({ message: 'Нельзя изменить dataset правила.' }); return;
        }
        for (const [key, value] of Object.entries(body ?? {})) {
          doc.set(key, key === 'title' && value === null && doc.dataset === 'expenses' ? undefined : value);
        }
        // Mongoose save otherwise filters only by _id. Retain owner at the write boundary.
        doc.$where = { owner, groupId: { $exists: false } };
      }
      await doc.validate();
      if (connection.readyState !== 1 || !await classificationRuleReadiness(db, Model.schema.indexes())) { unavailable(); return; }
      attempted = true;
      await doc.save({ w: 'majority', wtimeout: 3000 });
      res.status(action === 'create' ? 201 : 200).json(doc.toObject());
    } catch (error) {
      if (error instanceof mongo.MongoServerError && error.code === 11000) {
        res.status(409).json({ message: 'Такое правило уже существует.' }); return;
      }
      if (error instanceof MongooseError.ValidationError || error instanceof MongooseError.CastError || error instanceof MongooseError.StrictModeError) {
        res.status(400).json({ message: 'Некорректные данные правила.' }); return;
      }
      if (error instanceof MongooseError.DocumentNotFoundError) {
        res.status(404).json({ message: 'Правило не найдено.' }); return;
      }
      res.status(503).json({ message: 'Хранилище правил недоступно.', persistence: attempted ? 'unknown' : 'not_applied' });
    }
  };
  return { list: handler('list'), create: handler('create'), update: handler('update'), delete: handler('delete') };
};
