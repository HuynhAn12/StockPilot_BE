import { Router } from 'express';
import { AuthController } from './auth.controller';
import { validate } from '../../common/middleware/validate';
import {
  sendRegisterOtpSchema,
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  updateProfileSchema,
  forgotPasswordSchema,
  verifyOtpSchema,
  resetPasswordSchema,
  updateStoreSchema,
  changePasswordSchema,
} from './auth.schema';
import { authMiddleware } from '../../common/middleware/auth';

export const authRouter = Router();
const controller = new AuthController();

authRouter.post('/send-register-otp', validate({ body: sendRegisterOtpSchema }), (req, res, next) => controller.sendRegisterOtp(req, res, next));
authRouter.post('/register', validate({ body: registerSchema }), (req, res, next) => controller.register(req, res, next));
authRouter.post('/login', validate({ body: loginSchema }), (req, res, next) => controller.login(req, res, next));
authRouter.post('/refresh', validate({ body: refreshSchema }), (req, res, next) => controller.refreshToken(req, res, next));
authRouter.post('/forgot-password', validate({ body: forgotPasswordSchema }), (req, res, next) => controller.forgotPassword(req, res, next));
authRouter.post('/verify-otp', validate({ body: verifyOtpSchema }), (req, res, next) => controller.verifyOtp(req, res, next));
authRouter.post('/reset-password', validate({ body: resetPasswordSchema }), (req, res, next) => controller.resetPassword(req, res, next));
authRouter.post('/logout', authMiddleware, validate({ body: logoutSchema }), (req, res, next) => controller.logout(req, res, next));
authRouter.get('/me', authMiddleware, (req, res, next) => controller.getMe(req, res, next));
authRouter.patch('/me', authMiddleware, validate({ body: updateProfileSchema }), (req, res, next) => controller.updateMe(req, res, next));
authRouter.patch('/me/store', authMiddleware, validate({ body: updateStoreSchema }), (req, res, next) => controller.updateStore(req, res, next));
authRouter.post('/change-password', authMiddleware, validate({ body: changePasswordSchema }), (req, res, next) => controller.changePassword(req, res, next));

