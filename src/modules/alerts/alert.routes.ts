import { Router } from 'express';
import { AlertController } from './alert.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope, requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { alertListQuerySchema, alertActionParamsSchema, acknowledgeAlertBodySchema } from './alert.schema';

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

// Get summary stats
alertRouter.get(
  '/stats',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  controller.stats
);

// Acknowledge alert: staff report "seen / escalated to owner"; owners may acknowledge too.
alertRouter.post(
  '/:id/acknowledge',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ params: alertActionParamsSchema, body: acknowledgeAlertBodySchema }),
  controller.acknowledge
);

// Resolve alert: owner-only so the person who reports a problem cannot also close it.
// Alerts whose condition clears are resolved automatically by the Decision Engine.
alertRouter.post(
  '/:id/resolve',
  requireRole('SHOP_OWNER'),
  validate({ params: alertActionParamsSchema }),
  controller.resolve
);
