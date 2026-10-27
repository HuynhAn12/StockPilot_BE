import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { AdminOpsController } from './admin-ops.controller';
import {
  accountKeyParamSchema,
  auditIdParamSchema,
  broadcastSchema,
  clearLockSchema,
  growthQuerySchema,
  loginFailureQuerySchema,
  opsSettingKeyParamSchema,
  paymentHealthQuerySchema,
  restoreSettingSchema,
  retentionQuerySchema,
  settingHistoryQuerySchema,
  storeIdParamSchema,
  supportSlaQuerySchema,
  transferOwnerSchema,
  twoFactorDisableSchema,
  twoFactorEnableSchema,
  twoFactorResetSchema,
  twoFactorSetupSchema,
  updateOpsSettingSchema,
  userIdParamSchema,
} from './admin-ops.schema';

/**
 * Platform operations for admins. Mounted at /api/v1/admin/ops (see app.ts).
 * Lives in its own module so it never edits the existing admin router/service.
 */
export const adminOpsRouter = Router();
const controller = new AdminOpsController();

// Write actions (recalculate, transfer owner, broadcast, restore) are rate limited per admin/IP.
const writeLimiter =
  env.NODE_ENV === 'test'
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit({
        windowMs: 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, error: { code: 'RATE_LIMITED', message: 'Thao tác quá nhanh, vui lòng thử lại sau 1 phút' } },
      });

adminOpsRouter.use(authMiddleware);
adminOpsRouter.use(requireRole('ADMIN'));

// A2 — background jobs
adminOpsRouter.get('/jobs', controller.getJobs);
adminOpsRouter.post(
  '/jobs/decision/stores/:storeId/run',
  writeLimiter,
  validate({ params: storeIdParamSchema }),
  controller.runDecisionForStore
);

// A1 — login security
adminOpsRouter.get('/security/login-failures', validate({ query: loginFailureQuerySchema }), controller.getLoginFailures);
adminOpsRouter.post(
  '/security/accounts/:accountKey/clear-lock',
  writeLimiter,
  validate({ params: accountKeyParamSchema, body: clearLockSchema }),
  controller.clearLoginLock
);

// A3 — payment health
adminOpsRouter.get('/payments/health', validate({ query: paymentHealthQuerySchema }), controller.getPaymentHealth);

// B4 — support SLA
adminOpsRouter.get('/support/sla', validate({ query: supportSlaQuerySchema }), controller.getSupportSla);

// B3 — growth
adminOpsRouter.get('/growth', validate({ query: growthQuerySchema }), controller.getGrowth);

// C4 — settings history / ops settings
adminOpsRouter.get('/settings/history', validate({ query: settingHistoryQuerySchema }), controller.listSettingHistory);
adminOpsRouter.post(
  '/settings/history/:auditId/restore',
  writeLimiter,
  validate({ params: auditIdParamSchema, body: restoreSettingSchema }),
  controller.restoreSetting
);
adminOpsRouter.get('/settings', controller.getOpsSettings);
adminOpsRouter.put(
  '/settings/:key',
  writeLimiter,
  validate({ params: opsSettingKeyParamSchema, body: updateOpsSettingSchema }),
  controller.updateOpsSetting
);

// B5 — transfer store ownership
adminOpsRouter.post(
  '/stores/:storeId/transfer-owner',
  writeLimiter,
  validate({ params: storeIdParamSchema, body: transferOwnerSchema }),
  controller.transferStoreOwner
);

// C1 — data retention report (dry run, read-only)
adminOpsRouter.get('/data/retention', validate({ query: retentionQuerySchema }), controller.getRetentionReport);

// C3 — two-factor authentication (off by default; each admin enables it for themselves)
adminOpsRouter.get('/2fa', controller.getTwoFactorStatus);
adminOpsRouter.post('/2fa/setup', writeLimiter, validate({ body: twoFactorSetupSchema }), controller.startTwoFactorSetup);
adminOpsRouter.post('/2fa/enable', writeLimiter, validate({ body: twoFactorEnableSchema }), controller.enableTwoFactor);
adminOpsRouter.post('/2fa/disable', writeLimiter, validate({ body: twoFactorDisableSchema }), controller.disableTwoFactor);
adminOpsRouter.post(
  '/2fa/users/:userId/reset',
  writeLimiter,
  validate({ params: userIdParamSchema, body: twoFactorResetSchema }),
  controller.resetTwoFactor
);

// B2 — announcements
adminOpsRouter.post('/announcements', writeLimiter, validate({ body: broadcastSchema }), controller.broadcastAnnouncement);
