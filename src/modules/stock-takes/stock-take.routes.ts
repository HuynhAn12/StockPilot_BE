import { Role } from '@prisma/client';
import { Router } from 'express';
import { authMiddleware } from '../../common/middleware/auth';
import { idempotency } from '../../common/middleware/idempotency';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { StockTakeController } from './stock-take.controller';
import {
  createStockTakeSchema,
  stockTakeIdParamSchema,
  stockTakeListQuerySchema,
  updateStockTakeCountsSchema,
} from './stock-take.schema';

export const stockTakeRouter = Router();
const controller = new StockTakeController();
const storeOperatorRoles = [Role.SHOP_OWNER, Role.WAREHOUSE_STAFF];

stockTakeRouter.use(authMiddleware);
stockTakeRouter.use(requireStoreScope);
stockTakeRouter.use(requireRole(...storeOperatorRoles));

stockTakeRouter.post(
  '/',
  validate({ body: createStockTakeSchema }),
  idempotency({ operation: 'STOCK_TAKE_CREATE' }),
  (req, res, next) => controller.create(req, res, next)
);
stockTakeRouter.get('/', validate({ query: stockTakeListQuerySchema }), (req, res, next) => controller.list(req, res, next));
stockTakeRouter.get('/:id', validate({ params: stockTakeIdParamSchema }), (req, res, next) => controller.detail(req, res, next));
stockTakeRouter.post(
  '/:id/start',
  validate({ params: stockTakeIdParamSchema }),
  idempotency({ operation: 'STOCK_TAKE_START' }),
  (req, res, next) => controller.start(req, res, next)
);
stockTakeRouter.put(
  '/:id/counts',
  validate({ params: stockTakeIdParamSchema, body: updateStockTakeCountsSchema }),
  idempotency({ operation: 'STOCK_TAKE_COUNTS' }),
  (req, res, next) => controller.updateCounts(req, res, next)
);
stockTakeRouter.post(
  '/:id/complete',
  validate({ params: stockTakeIdParamSchema }),
  idempotency({ operation: 'STOCK_TAKE_COMPLETE' }),
  (req, res, next) => controller.complete(req, res, next)
);
stockTakeRouter.post(
  '/:id/cancel',
  validate({ params: stockTakeIdParamSchema }),
  idempotency({ operation: 'STOCK_TAKE_CANCEL' }),
  (req, res, next) => controller.cancel(req, res, next)
);
