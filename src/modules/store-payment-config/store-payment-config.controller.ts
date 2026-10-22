import { NextFunction, Request, Response } from 'express';
import { StorePaymentConfigService } from './store-payment-config.service';

const service = new StorePaymentConfigService();

function getRequestOrigin(req: Request): string {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return '';
  return `${proto}://${host}`;
}

export class StorePaymentConfigController {
  async getPayosStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await service.getPayosStatus(req.user!.storeId!, getRequestOrigin(req));
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }

  async upsertPayosConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await service.upsertPayosConfig(
        req.user!.storeId!,
        req.user!.userId,
        req.body,
        getRequestOrigin(req)
      );
      return res.status(200).json({
        success: true,
        message: 'PayOS configuration saved',
        data: result,
      });
    } catch (error) {
      return next(error);
    }
  }

  async testPayosConnection(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await service.testPayosConnection(
        req.user!.storeId!,
        req.body,
        getRequestOrigin(req)
      );
      return res.status(200).json({
        success: result.success,
        message: result.message,
        data: result,
      });
    } catch (error) {
      return next(error);
    }
  }

  async deactivatePayosConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await service.deactivatePayosConfig(req.user!.storeId!, req.user!.userId);
      return res.status(200).json({
        success: true,
        message: 'PayOS configuration disabled',
        data: result,
      });
    } catch (error) {
      return next(error);
    }
  }

  async togglePayosConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const active = Boolean(req.body.active);
      const result = await service.togglePayosConfig(req.user!.storeId!, req.user!.userId, active);
      return res.status(200).json({
        success: true,
        message: active ? 'Đã kích hoạt PayOS' : 'Đã tạm dừng PayOS',
        data: result,
      });
    } catch (error) {
      return next(error);
    }
  }
}
