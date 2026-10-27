import { NextFunction, Request, Response } from 'express';
import { OpsSettingKey } from '../../common/services/ops-settings.service';
import { TwoFactorService } from '../../common/services/two-factor.service';
import { AdminOpsService, RequestMeta } from './admin-ops.service';

function requestMeta(req: Request): RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.headers['user-agent']?.slice(0, 255) ?? null,
  };
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Wraps a handler: success → `{ success: true, data }`, errors → central error handler. */
function respond(handler: Handler, message?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await handler(req, res);
      return res.status(200).json({ success: true, ...(message ? { message } : {}), data });
    } catch (error) {
      return next(error);
    }
  };
}

export class AdminOpsController {
  constructor(
    private readonly service: AdminOpsService = new AdminOpsService(),
    private readonly twoFactor: TwoFactorService = new TwoFactorService()
  ) {}

  // Jobs
  getJobs = respond(() => this.service.getJobs());
  runDecisionForStore = respond(
    (req) => this.service.runDecisionForStore(Number(req.params.storeId), req.user!.userId, requestMeta(req)),
    'Đã tính lại Decision Engine cho cửa hàng'
  );

  // Security
  getLoginFailures = respond((req) => this.service.getLoginFailures(req.query as any));
  clearLoginLock = respond(
    (req) => this.service.clearLoginLock(String(req.params.accountKey), req.body.reason, req.user!.userId, requestMeta(req)),
    'Đã gỡ khóa đăng nhập tạm thời'
  );

  // Payments
  getPaymentHealth = respond((req) => this.service.getPaymentHealth(req.query as any));

  // Support
  getSupportSla = respond((req) => this.service.getSupportSla(req.query as any));

  // Growth
  getGrowth = respond((req) => this.service.getGrowth(req.query as any));

  // Settings
  listSettingHistory = respond((req) => this.service.listSettingHistory(req.query as any));
  restoreSetting = respond(
    (req) => this.service.restoreSetting(String(req.params.auditId), req.body.reason, req.user!.userId, requestMeta(req)),
    'Đã khôi phục giá trị cài đặt'
  );
  getOpsSettings = respond(() => this.service.getOpsSettings());
  updateOpsSetting = respond(
    (req) => this.service.updateOpsSetting(req.params.key as OpsSettingKey, req.body.value, req.user!.userId, requestMeta(req)),
    'Đã cập nhật cài đặt vận hành'
  );

  // Stores
  transferStoreOwner = respond(
    (req) => this.service.transferStoreOwner(Number(req.params.storeId), req.body, req.user!.userId, requestMeta(req)),
    'Đã chuyển quyền chủ cửa hàng và thu hồi phiên đăng nhập liên quan'
  );

  // Data retention (dry run)
  getRetentionReport = respond((req) => this.service.getRetentionReport(req.query as any));

  // Two-factor authentication (current admin)
  getTwoFactorStatus = respond((req) => this.twoFactor.getStatus(req.user!.userId));
  startTwoFactorSetup = respond((req) => this.twoFactor.startSetup(req.user!.userId, req.user!.email, req.body.actorPassword));
  enableTwoFactor = respond(
    (req) => this.twoFactor.enable(req.user!.userId, req.body.code, requestMeta(req)),
    'Đã bật xác thực 2 lớp. Hãy lưu các mã khôi phục ở nơi an toàn — chúng chỉ hiển thị một lần'
  );
  disableTwoFactor = respond(
    (req) => this.twoFactor.disable(req.user!.userId, req.body.actorPassword, req.body.code, requestMeta(req)),
    'Đã tắt xác thực 2 lớp'
  );
  resetTwoFactor = respond(
    (req) => this.twoFactor.resetForUser(Number(req.params.userId), req.user!.userId, req.body.actorPassword, req.body.reason, requestMeta(req)),
    'Đã đặt lại xác thực 2 lớp cho quản trị viên'
  );

  // Announcements
  broadcastAnnouncement = respond(
    (req) => this.service.broadcastAnnouncement(req.body, req.user!.userId, requestMeta(req)),
    'Đã gửi thông báo'
  );
}
