import { Router } from 'express';
import { UserController } from './user.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { createStaffSchema, updateStaffSchema } from './user.schema';
import { paginationQuerySchema, idParamSchema } from '../../common/utils/pagination';

export const userRouter = Router();
const controller = new UserController();

userRouter.use(authMiddleware);
userRouter.use(requireStoreScope);
userRouter.use(requireRole('SHOP_OWNER'));

userRouter.post('/', validate({ body: createStaffSchema }), (req, res, next) => controller.createStaff(req, res, next));
userRouter.get('/', validate({ query: paginationQuerySchema }), (req, res, next) => controller.listStaff(req, res, next));
userRouter.patch('/:id', validate({ params: idParamSchema, body: updateStaffSchema }), (req, res, next) => controller.updateStaff(req, res, next));
