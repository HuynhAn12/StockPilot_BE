import { Router } from 'express';
import { ImportExportController } from './import-export.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { importPreviewSchema, importCommitSchema } from './import-export.schema';

export const importExportRouter = Router();
const controller = new ImportExportController();

importExportRouter.use(authMiddleware);
importExportRouter.use(requireStoreScope);

// Exports
importExportRouter.get('/products', (req, res, next) => controller.exportProducts(req, res, next));
importExportRouter.get('/inventory', (req, res, next) => controller.exportInventory(req, res, next));

// Imports (Shop Owner only)
importExportRouter.post(
  '/preview',
  requireRole('SHOP_OWNER'),
  validate({ body: importPreviewSchema }),
  (req, res, next) => controller.preview(req, res, next)
);

importExportRouter.post(
  '/commit',
  requireRole('SHOP_OWNER'),
  validate({ body: importCommitSchema }),
  (req, res, next) => controller.commit(req, res, next)
);
