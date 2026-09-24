import { Router } from 'express';
import { ImportExportController } from './import-export.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope } from '../../common/middleware/rbac';

export const exportRouter = Router();
const controller = new ImportExportController();

exportRouter.use(authMiddleware);
exportRouter.use(requireStoreScope);

exportRouter.get('/products', (req, res, next) => controller.exportProducts(req, res, next));
exportRouter.get('/inventory', (req, res, next) => controller.exportInventory(req, res, next));
exportRouter.get('/orders', (req, res, next) => controller.exportOrders(req, res, next));
exportRouter.get('/sales', (req, res, next) => controller.exportSales(req, res, next));
exportRouter.get('/returns', (req, res, next) => controller.exportReturns(req, res, next));
