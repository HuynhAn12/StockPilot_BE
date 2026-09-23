import { Router } from 'express';
import { ReturnController } from './return.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { createReturnSchema } from './return.schema';

export const returnRouter = Router();
const controller = new ReturnController();

returnRouter.use(authMiddleware);
returnRouter.use(requireStoreScope);

returnRouter.get('/', (req, res, next) => controller.list(req, res, next));
returnRouter.post('/', validate({ body: createReturnSchema }), (req, res, next) => controller.create(req, res, next));
