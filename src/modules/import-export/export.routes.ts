import { Router } from 'express';
import { ImportExportController } from './import-export.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';

export const exportRouter = Router();
const controller = new ImportExportController();

exportRouter.use(authMiddleware);
exportRouter.use(requireStoreScope);

exportRouter.get('/products', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), (req, res, next) => controller.exportProducts(req, res, next));
exportRouter.get('/inventory', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), (req, res, next) => controller.exportInventory(req, res, next));
exportRouter.get('/orders', requireRole('SHOP_OWNER'), (req, res, next) => controller.exportOrders(req, res, next));
exportRouter.get('/sales', requireRole('SHOP_OWNER'), (req, res, next) => controller.exportSales(req, res, next));
exportRouter.get('/returns', requireRole('SHOP_OWNER'), (req, res, next) => controller.exportReturns(req, res, next));
exportRouter.get('/decision-report', requireRole('SHOP_OWNER'), (req, res, next) => controller.exportDecisionReport(req, res, next));
exportRouter.get('/alerts', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), (req, res, next) => controller.exportAlerts(req, res, next));
exportRouter.get('/recommendations', requireRole('SHOP_OWNER'), (req, res, next) => controller.exportPricingRecommendations(req, res, next));
