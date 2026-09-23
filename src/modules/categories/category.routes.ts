import { Router } from 'express';
import { CategoryController } from './category.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { createCategorySchema, updateCategorySchema } from './category.schema';

export const categoryRouter = Router();
const controller = new CategoryController();

categoryRouter.use(authMiddleware);
categoryRouter.use(requireStoreScope);

categoryRouter.get('/', (req, res, next) => controller.list(req, res, next));
categoryRouter.get('/:id', (req, res, next) => controller.getById(req, res, next));

// Mutating endpoints require SHOP_OWNER or ADMIN
categoryRouter.post('/', requireRole('SHOP_OWNER', 'ADMIN'), validate({ body: createCategorySchema }), (req, res, next) => controller.create(req, res, next));
categoryRouter.put('/:id', requireRole('SHOP_OWNER', 'ADMIN'), validate({ body: updateCategorySchema }), (req, res, next) => controller.update(req, res, next));
categoryRouter.delete('/:id', requireRole('SHOP_OWNER', 'ADMIN'), (req, res, next) => controller.delete(req, res, next));
