import { Router } from 'express';
import { AuthController } from './auth.controller';
import { validate } from '../../common/middleware/validate';
import { registerSchema, loginSchema, refreshSchema, logoutSchema } from './auth.schema';
import { authMiddleware } from '../../common/middleware/auth';

export const authRouter = Router();
const controller = new AuthController();

authRouter.post('/register', validate({ body: registerSchema }), (req, res, next) => controller.register(req, res, next));
authRouter.post('/login', validate({ body: loginSchema }), (req, res, next) => controller.login(req, res, next));
authRouter.post('/refresh', validate({ body: refreshSchema }), (req, res, next) => controller.refreshToken(req, res, next));
authRouter.post('/logout', authMiddleware, validate({ body: logoutSchema }), (req, res, next) => controller.logout(req, res, next));
authRouter.get('/me', authMiddleware, (req, res, next) => controller.getMe(req, res, next));
