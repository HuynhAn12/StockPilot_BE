import { Router } from 'express';
import { ImportExportController } from './import-export.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { idempotency } from '../../common/middleware/idempotency';
import { importPreviewSchema, importCommitSchema } from './import-export.schema';

export const importRouter = Router();
const controller = new ImportExportController();

importRouter.use(authMiddleware);
importRouter.use(requireStoreScope);
importRouter.use(requireRole('SHOP_OWNER'));

importRouter.post('/preview', validate({ body: importPreviewSchema }), (req, res, next) =>
  controller.preview(req, res, next)
);

importRouter.post('/commit', validate({ body: importCommitSchema }), idempotency({ operation: 'IMPORT_COMMIT' }), (req, res, next) =>
  controller.commit(req, res, next)
);

