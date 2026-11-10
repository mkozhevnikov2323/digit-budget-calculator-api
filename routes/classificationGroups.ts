import {
  Router,
  type Request,
  type Response,
  type RequestHandler,
} from 'express';
import mongoose, { mongo, type Connection } from 'mongoose';
import {
  GROUP_API,
  fields,
  dataset,
  id,
} from '../domain/classification/groups';
import { GroupError, reject } from '../persistence/classificationGroups';
import { groupsReady } from '../persistence/classificationGroupsManifest';
import { authenticatedClassificationOwner } from '../services/classificationPrincipal';
import {
  listGroups,
  initializeGroups,
  createGroup,
  updateGroup,
} from '../services/classificationGroups/catalog';
import {
  groupDecisionRead,
  writeGroupDecision,
  reconcileGroupDecision,
} from '../services/classificationGroups/decisions';
import { listRules, mutateRule } from '../services/classificationGroups/rules';
import {
  groupReport,
  groupPreview,
} from '../services/classificationGroups/report';
import { admitClassificationRead } from '../services/classificationAdmission';
export const createClassificationGroupsRouter = (connection: Connection) => {
  const router = Router();
  type Work = (
    req: Request,
    db: mongo.Db,
    owner: string,
    attempt: () => void,
  ) => Promise<unknown>;
  const handler =
    (
      work: Work,
      kind: 'catalog' | 'read' | 'history' | 'decision' = 'catalog',
      status = 200,
      query = false,
    ): RequestHandler =>
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.vary('Authorization');
      let attempted = false,
        release: (() => void) | null = null;
      const failure = (
        code: number,
        message: string,
        persistence = 'not_applied',
      ) =>
        res
          .status(code)
          .json({ version: GROUP_API, error: { code: message }, persistence });
      try {
        if (
          process.env.CLASSIFICATION_GROUPS_ENABLED !== '1' ||
          (kind === 'decision' &&
            process.env.CLASSIFICATION_C_WRITE_ENABLED !== '1') ||
          (kind === 'read' &&
            process.env.CLASSIFICATION_READ_ENABLED !== '1') ||
          (kind === 'history' &&
            process.env.CLASSIFICATION_HISTORY_READ_ENABLED !== '1')
        )
          reject(503, 'unavailable');
        if (!query && Object.keys(req.query).length)
          reject(400, 'unexpected_query');
        const db = connection.readyState === 1 ? connection.db : undefined;
        if (!db) reject(503, 'unavailable');
        const owner = await authenticatedClassificationOwner(req, db!);
        if (!owner) reject(401, 'reauth_required');
        if (!(await groupsReady(db!)))
          reject(503, 'infrastructure_unavailable');
        release = admitClassificationRead(owner!);
        if (!release) reject(429, 'rate_limited');
        const result = await work(req, db!, owner!, () => {
          attempted = true;
        });
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 3500000)
          reject(503, 'response_limit');
        res.status(status).json({ version: GROUP_API, result });
      } catch (error) {
        if (error instanceof mongo.MongoServerError && error.code === 11000) {
          failure(409, 'duplicate_or_revision_conflict');
          return;
        }
        if (error instanceof GroupError) {
          const knownNoWrite =
            error.status === 409 &&
            [
              'revision_conflict',
              'group_revision_conflict',
              'rule_revision_conflict',
            ].includes(error.code);
          failure(
            attempted && !knownNoWrite ? 503 : error.status,
            error.code,
            attempted && !knownNoWrite ? 'unknown' : 'not_applied',
          );
          return;
        }
        failure(503, 'unavailable', attempted ? 'unknown' : 'not_applied');
      } finally {
        release?.();
      }
    };
  const identity = (req: Request) => {
    if (!dataset(req.params.dataset) || !id(req.params.operationId))
      reject(400, 'invalid_identity');
    return {
      dataset: req.params.dataset as 'expenses' | 'incomes',
      operationId: req.params.operationId as string,
    };
  };
  const empty = (req: Request) => {
    if (req.body !== undefined) reject(400, 'unexpected_body');
  };
  router.get(
    '/',
    handler(
      async (req, db, owner) => {
        empty(req);
        return listGroups(db, owner, req.query);
      },
      'catalog',
      200,
      true,
    ),
  );
  router.post(
    '/initialize',
    handler(async (req, db, owner, attempt) => {
      const body = fields(req.body, []);
      if (!body) reject(400, 'invalid_initialize');
      return initializeGroups(db, owner, attempt);
    }),
  );
  router.post(
    '/',
    handler(
      async (req, db, owner, attempt) =>
        createGroup(db, owner, req.body, attempt),
      'catalog',
      201,
    ),
  );
  router.get(
    '/rules',
    handler(async (req, db, owner) => {
      empty(req);
      return { rules: await listRules(db, owner) };
    }),
  );
  router.post(
    '/rules',
    handler(
      async (req, db, owner, attempt) =>
        mutateRule(db, owner, req.body, undefined, false, attempt),
      'catalog',
      201,
    ),
  );
  router.patch(
    '/rules/:id',
    handler(async (req, db, owner, attempt) =>
      mutateRule(db, owner, req.body, req.params.id as string, false, attempt),
    ),
  );
  router.delete(
    '/rules/:id',
    handler(async (req, db, owner, attempt) =>
      mutateRule(db, owner, req.body, req.params.id as string, true, attempt),
    ),
  );
  router.get(
    '/operations/:dataset/:operationId',
    handler(async (req, db, owner) => {
      empty(req);
      const i = identity(req);
      return groupDecisionRead(db, owner, i.dataset, i.operationId);
    }, 'read'),
  );
  router.put(
    '/operations/:dataset/:operationId/decision',
    handler(async (req, db, owner, attempt) => {
      const i = identity(req);
      return writeGroupDecision(
        db,
        owner,
        i.dataset,
        i.operationId,
        req.body,
        attempt,
      );
    }, 'decision'),
  );
  router.post(
    '/operations/:dataset/:operationId/reconcile',
    handler(async (req, db, owner) => {
      const i = identity(req);
      return reconcileGroupDecision(
        db,
        owner,
        i.dataset,
        i.operationId,
        req.body,
      );
    }, 'read'),
  );
  router.post(
    '/report',
    handler(
      async (req, db, owner) => groupReport(db, owner, req.body),
      'history',
    ),
  );
  router.post(
    '/preview',
    handler(
      async (req, db, owner) => groupPreview(db, owner, req.body),
      'history',
    ),
  );
  router.patch(
    '/:groupId',
    handler(async (req, db, owner, attempt) =>
      updateGroup(
        db,
        owner,
        req.params.groupId as string,
        req.body,
        false,
        attempt,
      ),
    ),
  );
  router.delete(
    '/:groupId',
    handler(async (req, db, owner, attempt) =>
      updateGroup(
        db,
        owner,
        req.params.groupId as string,
        req.body,
        true,
        attempt,
      ),
    ),
  );
  return router;
};
export const classificationGroupsRouter = createClassificationGroupsRouter(
  mongoose.connection,
);
