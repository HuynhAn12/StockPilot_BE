import { Router } from 'express';
import { DecisionEngineController } from './decision-engine.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope, requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import {
  decisionSkuParamsSchema,
  decisionOverviewQuerySchema,
  updateEngineConfigSchema,
} from './decision-engine.schema';

export const decisionEngineRouter = Router();
const controller = new DecisionEngineController();

decisionEngineRouter.use(authMiddleware);
decisionEngineRouter.use(requireStoreScope);

// SKU Analysis
decisionEngineRouter.get(
  '/sku/:stockItemId',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ params: decisionSkuParamsSchema }),
  controller.analyzeSku
);

// High-level Overview
decisionEngineRouter.get(
  '/overview',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ query: decisionOverviewQuerySchema }),
  controller.getOverview
);

// Batch recalculation (SHOP_OWNER only)
decisionEngineRouter.post(
  '/recalculate',
  requireRole('SHOP_OWNER'),
  controller.recalculate
);

// Engine Config
decisionEngineRouter.get(
  '/config',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  controller.getConfig
);

decisionEngineRouter.put(
  '/config',
  requireRole('SHOP_OWNER'),
  validate({ body: updateEngineConfigSchema }),
  controller.updateConfig
);

// Backward compatibility alias for /policy
decisionEngineRouter.get(
  '/policy/:stockItemId?',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  controller.getConfig
);

decisionEngineRouter.put(
  '/policy/:stockItemId?',
  requireRole('SHOP_OWNER'),
  validate({ body: updateEngineConfigSchema }),
  controller.updateConfig
);
