import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { StoreDataService } from './store-data.service';

/** Mounted at /api/v1/store-data (see app.ts). Shop owner only. */
export const storeDataRouter = Router();
const service = new StoreDataService();

// A full export is heavy: a few per hour is plenty for a legitimate owner.
const exportLimiter =
  env.NODE_ENV === 'test'
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 5,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, error: { code: 'RATE_LIMITED', message: 'Đã xuất dữ liệu nhiều lần, vui lòng thử lại sau 1 giờ' } },
      });

storeDataRouter.use(authMiddleware);
storeDataRouter.use(requireStoreScope);

storeDataRouter.get('/export', requireRole('SHOP_OWNER'), exportLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = req.user!.storeId!;
    const data = await service.exportStore(storeId, req.user!.userId, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent']?.slice(0, 255) ?? null,
    });
    const fileName = `stockpilot-${data.store.code}-${data.exportedAt.slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.status(200).send(JSON.stringify(data, null, 2));
  } catch (error) {
    return next(error);
  }
});
