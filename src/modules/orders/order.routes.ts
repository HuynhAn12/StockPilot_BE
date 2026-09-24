import { Router } from 'express';
import { OrderController } from './order.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { createOrderSchema, cancelOrderSchema } from './order.schema';
import { orderListQuerySchema, idParamSchema } from '../../common/utils/pagination';

export const orderRouter = Router();
const controller = new OrderController();

orderRouter.use(authMiddleware);
orderRouter.use(requireStoreScope);

orderRouter.get('/', validate({ query: orderListQuerySchema }), (req, res, next) => controller.list(req, res, next));
orderRouter.get('/:id', validate({ params: idParamSchema }), (req, res, next) => controller.getById(req, res, next));
orderRouter.post('/', validate({ body: createOrderSchema }), (req, res, next) => controller.create(req, res, next));
orderRouter.post('/:id/confirm', validate({ params: idParamSchema }), (req, res, next) => controller.confirm(req, res, next));
orderRouter.post('/:id/fulfill', validate({ params: idParamSchema }), (req, res, next) => controller.fulfill(req, res, next));
orderRouter.post('/:id/cancel', validate({ params: idParamSchema, body: cancelOrderSchema }), (req, res, next) => controller.cancel(req, res, next));
