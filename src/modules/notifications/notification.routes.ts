import { Role } from '@prisma/client';
import { Router } from 'express';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { NotificationController } from './notification.controller';
import { notificationIdParamSchema, notificationListQuerySchema } from './notification.schema';

export const notificationRouter = Router();
const controller = new NotificationController();
const storeOperatorRoles = [Role.SHOP_OWNER, Role.WAREHOUSE_STAFF];

notificationRouter.use(authMiddleware);
notificationRouter.use(requireStoreScope);
notificationRouter.use(requireRole(...storeOperatorRoles));

notificationRouter.get('/', validate({ query: notificationListQuerySchema }), (req, res, next) =>
  controller.list(req, res, next)
);
notificationRouter.post('/read-all', (req, res, next) => controller.markAllRead(req, res, next));
notificationRouter.post('/:id/read', validate({ params: notificationIdParamSchema }), (req, res, next) =>
  controller.markRead(req, res, next)
);
