import { Router } from 'express';
import { OrderController } from './order.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { createOrderSchema, cancelOrderSchema } from './order.schema';

export const orderRouter = Router();
const controller = new OrderController();

orderRouter.use(authMiddleware);
orderRouter.use(requireStoreScope);

orderRouter.get('/', (req, res, next) => controller.list(req, res, next));
orderRouter.get('/:id', (req, res, next) => controller.getById(req, res, next));
orderRouter.post('/', validate({ body: createOrderSchema }), (req, res, next) => controller.create(req, res, next));
orderRouter.post('/:id/confirm', (req, res, next) => controller.confirm(req, res, next));
orderRouter.post('/:id/fulfill', (req, res, next) => controller.fulfill(req, res, next));
orderRouter.post('/:id/cancel', validate({ body: cancelOrderSchema }), (req, res, next) => controller.cancel(req, res, next));
