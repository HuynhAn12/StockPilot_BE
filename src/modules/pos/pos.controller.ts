import { Request, Response, NextFunction } from 'express';
import { PosService } from './pos.service';

const service = new PosService();

export class PosController {
  async createSale(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await service.createCashSale(
        req.user!.storeId!,
        req.user!.userId,
        req.body,
        (req as any).idempotencyContext?.effectKey
      );

      return res.status(201).json({
        success: true,
        message: 'POS sale created',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}
