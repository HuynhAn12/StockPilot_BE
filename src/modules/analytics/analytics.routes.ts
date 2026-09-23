import { Router } from 'express';
import { AnalyticsController } from './analytics.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';

export const analyticsRouter = Router();
const controller = new AnalyticsController();

analyticsRouter.use(authMiddleware);
analyticsRouter.use(requireStoreScope);
analyticsRouter.use(requireRole('SHOP_OWNER', 'ADMIN'));

analyticsRouter.get('/dashboard', (req, res, next) => controller.getDashboard(req, res, next));
