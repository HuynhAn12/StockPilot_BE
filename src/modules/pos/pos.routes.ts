import { Router } from 'express';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { idempotency } from '../../common/middleware/idempotency';
import { PosController } from './pos.controller';
import { createPosSaleSchema } from './pos.schema';

export const posRouter = Router();
const controller = new PosController();

posRouter.use(authMiddleware);
posRouter.use(requireStoreScope);

posRouter.post(
  '/sales',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ body: createPosSaleSchema }),
  idempotency({ operation: 'POS_SALE_CREATE' }),
  (req, res, next) => controller.createSale(req, res, next)
);
