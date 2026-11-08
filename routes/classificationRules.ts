import { Router } from 'express';
import mongoose, { type Connection } from 'mongoose';
import { createClassificationRulesController } from '../controllers/classificationRules';

/** The parent router supplies the existing JWT middleware. No connection/DDL here. */
export const createClassificationRulesRouter = (connection: Connection) => {
  const handlers = createClassificationRulesController(connection), router = Router();
  router.get('/', handlers.list);
  router.post('/', handlers.create);
  router.patch('/:id', handlers.update);
  router.delete('/:id', handlers.delete);
  return router;
};
export const classificationRulesRouter = createClassificationRulesRouter(mongoose.connection);
