import { Router } from 'express';
import { CategoryController } from './category.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { createCategorySchema, updateCategorySchema } from './category.schema';
import { paginationQuerySchema, idParamSchema } from '../../common/utils/pagination';

export const categoryRouter = Router();
const controller = new CategoryController();

categoryRouter.use(authMiddleware);
categoryRouter.use(requireStoreScope);

categoryRouter.get('/', validate({ query: paginationQuerySchema }), (req, res, next) => controller.list(req, res, next));
categoryRouter.get('/:id', validate({ params: idParamSchema }), (req, res, next) => controller.getById(req, res, next));

// Mutating endpoints: SHOP_OWNER and WAREHOUSE_STAFF can create and update categories; only SHOP_OWNER can delete
categoryRouter.post('/', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ body: createCategorySchema }), (req, res, next) => controller.create(req, res, next));
categoryRouter.put('/:id', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ params: idParamSchema, body: updateCategorySchema }), (req, res, next) => controller.update(req, res, next));
categoryRouter.delete('/:id', requireRole('SHOP_OWNER'), validate({ params: idParamSchema }), (req, res, next) => controller.delete(req, res, next));
