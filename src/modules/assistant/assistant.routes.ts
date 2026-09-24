import { Router } from 'express';
import { AssistantController } from './assistant.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope, requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { explainSkuQuerySchema } from './assistant.schema';

export const assistantRouter = Router();
const controller = new AssistantController();

assistantRouter.use(authMiddleware);
assistantRouter.use(requireStoreScope);

// Explain single SKU
assistantRouter.get(
  '/sku/:stockItemId',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ params: explainSkuQuerySchema }),
  controller.explainSku
);

// Explain store overview
assistantRouter.get(
  '/overview',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  controller.explainStoreOverview
);
