import { Router } from 'express';
import { ReturnController } from './return.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { idempotency } from '../../common/middleware/idempotency';
import { createReturnSchema } from './return.schema';
import { paginationQuerySchema } from '../../common/utils/pagination';

export const returnRouter = Router();
const controller = new ReturnController();

returnRouter.use(authMiddleware);
returnRouter.use(requireStoreScope);

returnRouter.get('/', validate({ query: paginationQuerySchema }), (req, res, next) => controller.list(req, res, next));
returnRouter.post('/', validate({ body: createReturnSchema }), idempotency({ operation: 'RETURN_CREATE' }), (req, res, next) => controller.create(req, res, next));
