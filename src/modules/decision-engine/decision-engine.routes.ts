import { Router } from 'express';
import { DecisionEngineController } from './decision-engine.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope, requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import {
  decisionSkuParamsSchema,
  decisionOverviewQuerySchema,
  updatePolicySchema,
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

// Inventory Policy
decisionEngineRouter.get(
  '/policy/:stockItemId',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ params: decisionSkuParamsSchema }),
  controller.getPolicy
);

decisionEngineRouter.put(
  '/policy/:stockItemId',
  requireRole('SHOP_OWNER'),
  validate({ params: decisionSkuParamsSchema, body: updatePolicySchema }),
  controller.updatePolicy
);
