import { Role } from '@prisma/client';
import { Router } from 'express';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { NotificationController } from './notification.controller';
import { notificationIdParamSchema, notificationListQuerySchema } from './notification.schema';

export const notificationRouter = Router();
const controller = new NotificationController();
const storeOperatorRoles = [Role.SHOP_OWNER, Role.WAREHOUSE_STAFF, Role.ADMIN];

notificationRouter.use(authMiddleware);
notificationRouter.use((req, res, next) => {
  if (req.user?.role === Role.ADMIN) {
    if (!req.user.storeId) req.user.storeId = 1;
    return next();
  }
  return requireStoreScope(req, res, next);
});
notificationRouter.use(requireRole(...storeOperatorRoles));

notificationRouter.get('/settings', (req, res, next) => controller.getSettings(req, res, next));
notificationRouter.put('/settings', (req, res, next) => controller.updateSettings(req, res, next));
notificationRouter.get('/', validate({ query: notificationListQuerySchema }), (req, res, next) =>
  controller.list(req, res, next)
);
notificationRouter.post('/read-all', (req, res, next) => controller.markAllRead(req, res, next));
notificationRouter.post('/:id/read', validate({ params: notificationIdParamSchema }), (req, res, next) =>
  controller.markRead(req, res, next)
);

