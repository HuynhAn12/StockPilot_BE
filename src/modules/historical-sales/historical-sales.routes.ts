import { Router } from 'express';
import { HistoricalSalesController } from './historical-sales.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope, requireRole } from '../../common/middleware/rbac';
import { idempotency } from '../../common/middleware/idempotency';
import { validate } from '../../common/middleware/validate';
import {
  historicalSalesPreviewSchema,
  historicalSalesCommitSchema,
  historicalSalesListQuerySchema,
} from './historical-sales.schema';

export const historicalSalesRouter = Router();
const controller = new HistoricalSalesController();

historicalSalesRouter.use(authMiddleware);
historicalSalesRouter.use(requireStoreScope);

// Preview and Commit routes
historicalSalesRouter.post(
  '/preview',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ body: historicalSalesPreviewSchema }),
  controller.preview
);

historicalSalesRouter.post(
  '/commit',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ body: historicalSalesCommitSchema }),
  idempotency({ operation: 'HISTORICAL_SALES_COMMIT' }),
  controller.commit
);

// List historical sales
historicalSalesRouter.get(
  '/',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ query: historicalSalesListQuerySchema }),
  controller.list
);
