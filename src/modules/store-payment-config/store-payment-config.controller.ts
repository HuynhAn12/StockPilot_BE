import { NextFunction, Request, Response } from 'express';
import { StorePaymentConfigService } from './store-payment-config.service';

const service = new StorePaymentConfigService();

export class StorePaymentConfigController {
  async getPayosStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await service.getPayosStatus(req.user!.storeId!);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }

  async upsertPayosConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await service.upsertPayosConfig(req.user!.storeId!, req.user!.userId, req.body);
      return res.status(200).json({
        success: true,
        message: 'PayOS configuration saved',
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
}
