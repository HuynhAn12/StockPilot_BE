import { Router } from 'express';
import { ProductController } from './product.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { createProductSchema, updateProductSchema } from './product.schema';
import { productListQuerySchema, idParamSchema } from '../../common/utils/pagination';

export const productRouter = Router();
const controller = new ProductController();

productRouter.use(authMiddleware);
productRouter.use(requireStoreScope);

productRouter.get('/', validate({ query: productListQuerySchema }), (req, res, next) => controller.list(req, res, next));
productRouter.get('/:id', validate({ params: idParamSchema }), (req, res, next) => controller.getById(req, res, next));

// Mutating endpoints: SHOP_OWNER and WAREHOUSE_STAFF can create and update products; only SHOP_OWNER can delete
productRouter.post('/', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ body: createProductSchema }), (req, res, next) => controller.create(req, res, next));
productRouter.put('/:id', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ params: idParamSchema, body: updateProductSchema }), (req, res, next) => controller.update(req, res, next));
productRouter.delete('/:id', requireRole('SHOP_OWNER'), validate({ params: idParamSchema }), (req, res, next) => controller.delete(req, res, next));
