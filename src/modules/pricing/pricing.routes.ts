import { Router } from 'express';
import { PricingController } from './pricing.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope, requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import {
  pricingListQuerySchema,
  pricingActionParamsSchema,
  modifyRecommendationSchema,
  acceptRecommendationSchema,
} from './pricing.schema';

export const pricingRouter = Router();
const controller = new PricingController();

pricingRouter.use(authMiddleware);
pricingRouter.use(requireStoreScope);

// List pricing recommendations
pricingRouter.get(
  '/',
  requireRole('SHOP_OWNER'),
  validate({ query: pricingListQuerySchema }),
  controller.list
);

// Get price change history (owner-only: rows reference accepted/modified pricing recommendations)
pricingRouter.get(
  '/history',
  requireRole('SHOP_OWNER'),
  controller.getHistory
);

// Accept recommendation (SHOP_OWNER only)
pricingRouter.post(
  '/:id/accept',
  requireRole('SHOP_OWNER'),
  validate({ params: pricingActionParamsSchema, body: acceptRecommendationSchema }),
  controller.accept
);
pricingRouter.patch(
  '/:id/accept',
  requireRole('SHOP_OWNER'),
  validate({ params: pricingActionParamsSchema, body: acceptRecommendationSchema }),
  controller.accept
);

// Reject recommendation (SHOP_OWNER only)
pricingRouter.post(
  '/:id/reject',
  requireRole('SHOP_OWNER'),
  validate({ params: pricingActionParamsSchema }),
  controller.reject
);
pricingRouter.patch(
  '/:id/reject',
  requireRole('SHOP_OWNER'),
  validate({ params: pricingActionParamsSchema }),
  controller.reject
);

// Modify recommendation (SHOP_OWNER only)
pricingRouter.post(
  '/:id/modify',
  requireRole('SHOP_OWNER'),
  validate({ params: pricingActionParamsSchema, body: modifyRecommendationSchema }),
  controller.modify
);
pricingRouter.patch(
  '/:id/modify',
  requireRole('SHOP_OWNER'),
  validate({ params: pricingActionParamsSchema, body: modifyRecommendationSchema }),
  controller.modify
);
