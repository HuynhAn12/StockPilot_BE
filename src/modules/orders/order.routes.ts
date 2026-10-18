import { Router } from 'express';
import { OrderController } from './order.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { idempotency } from '../../common/middleware/idempotency';
import { createOrderSchema, cancelOrderSchema } from './order.schema';
import { orderListQuerySchema, idParamSchema } from '../../common/utils/pagination';

export const orderRouter = Router();
const controller = new OrderController();

orderRouter.use(authMiddleware);
orderRouter.use(requireStoreScope);

orderRouter.get('/', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ query: orderListQuerySchema }), (req, res, next) => controller.list(req, res, next));
orderRouter.get('/:id', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ params: idParamSchema }), (req, res, next) => controller.getById(req, res, next));
orderRouter.post('/', requireRole('SHOP_OWNER'), validate({ body: createOrderSchema }), idempotency({ operation: 'ORDER_CREATE' }), (req, res, next) => controller.create(req, res, next));
orderRouter.post('/:id/confirm', requireRole('SHOP_OWNER'), validate({ params: idParamSchema }), idempotency({ operation: 'ORDER_CONFIRM' }), (req, res, next) => controller.confirm(req, res, next));
orderRouter.post('/:id/fulfill', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ params: idParamSchema }), (req, res, next) => controller.fulfill(req, res, next));
orderRouter.post('/:id/cancel', requireRole('SHOP_OWNER'), validate({ params: idParamSchema, body: cancelOrderSchema }), idempotency({ operation: 'ORDER_CANCEL' }), (req, res, next) => controller.cancel(req, res, next));

