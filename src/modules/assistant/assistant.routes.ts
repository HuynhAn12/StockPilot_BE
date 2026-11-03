import { Router } from 'express';
import { AssistantController } from './assistant.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope, requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { assistantChatBodySchema, explainSkuQuerySchema } from './assistant.schema';

export const assistantRouter = Router();
const controller = new AssistantController();

assistantRouter.use(authMiddleware);
assistantRouter.use(requireStoreScope);

// AI Pilot is an owner tool (decided 2026-11-03): warehouse staff work from Alerts and Inventory instead.

// Explain single SKU
assistantRouter.get(
  '/sku/:stockItemId',
  requireRole('SHOP_OWNER'),
  validate({ params: explainSkuQuerySchema }),
  controller.explainSku
);

// Explain store overview
assistantRouter.get(
  '/overview',
  requireRole('SHOP_OWNER'),
  controller.explainStoreOverview
);

// Prioritized next actions (executed through the existing pricing/alert endpoints, never here)
assistantRouter.get(
  '/suggestions',
  requireRole('SHOP_OWNER'),
  controller.suggestions
);

// Chat with assistant
assistantRouter.post(
  '/chat',
  requireRole('SHOP_OWNER'),
  validate({ body: assistantChatBodySchema }),
  controller.chat
);

// Chat history
assistantRouter.get(
  '/history',
  requireRole('SHOP_OWNER'),
  controller.getHistory
);
