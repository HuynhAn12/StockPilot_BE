import { Router } from 'express';
import { AlertController } from './alert.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope, requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { alertListQuerySchema, alertActionParamsSchema } from './alert.schema';

export const alertRouter = Router();
const controller = new AlertController();

alertRouter.use(authMiddleware);
alertRouter.use(requireStoreScope);

// List all smart alerts
alertRouter.get(
  '/',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ query: alertListQuerySchema }),
  controller.list
);

// Acknowledge alert
alertRouter.post(
  '/:id/acknowledge',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ params: alertActionParamsSchema }),
  controller.acknowledge
);

// Resolve alert
alertRouter.post(
  '/:id/resolve',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ params: alertActionParamsSchema }),
  controller.resolve
);
