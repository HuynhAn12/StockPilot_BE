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
