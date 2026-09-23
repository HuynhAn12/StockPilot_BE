import { Router } from 'express';
import { UserController } from './user.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { createStaffSchema } from './user.schema';

export const userRouter = Router();
const controller = new UserController();

userRouter.use(authMiddleware);
userRouter.use(requireRole('SHOP_OWNER', 'ADMIN'));

userRouter.post('/', validate({ body: createStaffSchema }), (req, res, next) => controller.createStaff(req, res, next));
userRouter.get('/', (req, res, next) => controller.listStaff(req, res, next));
