import { Router } from 'express';
import { ProductController } from './product.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { createProductSchema, updateProductSchema } from './product.schema';

export const productRouter = Router();
const controller = new ProductController();

productRouter.use(authMiddleware);
productRouter.use(requireStoreScope);

productRouter.get('/', (req, res, next) => controller.list(req, res, next));
productRouter.get('/:id', (req, res, next) => controller.getById(req, res, next));

// Mutating endpoints require SHOP_OWNER or ADMIN
productRouter.post('/', requireRole('SHOP_OWNER', 'ADMIN'), validate({ body: createProductSchema }), (req, res, next) => controller.create(req, res, next));
productRouter.put('/:id', requireRole('SHOP_OWNER', 'ADMIN'), validate({ body: updateProductSchema }), (req, res, next) => controller.update(req, res, next));
