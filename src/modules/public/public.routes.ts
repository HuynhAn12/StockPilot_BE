import { Router } from 'express';
import { PublicController } from './public.controller';
import { validate } from '../../common/middleware/validate';
import { createLeadSchema } from './public.schema';

export const publicRouter = Router();
const controller = new PublicController();

publicRouter.post('/leads', validate({ body: createLeadSchema }), (req, res, next) =>
  controller.createLead(req, res, next)
);

publicRouter.get('/stats', (req, res, next) =>
  controller.getPlatformStats(req, res, next)
);

publicRouter.get('/platform-status', (req, res, next) =>
  controller.getPlatformStatus(req, res, next)
);

publicRouter.get('/pricing', (req, res, next) =>
  controller.getPricingPlans(req, res, next)
);
