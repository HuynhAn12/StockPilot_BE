import { Request, Response, NextFunction } from 'express';
import { ReturnService } from './return.service';

const returnService = new ReturnService();

export class ReturnController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const result = await returnService.createReturn(
        storeId,
        userId,
        req.body,
        (req as any).idempotencyContext?.effectKey
      );
      return res.status(201).json({ success: true, message: 'Tạo phiếu trả hàng thành công', data: result });
    } catch (error) {
      next(error);
    }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const query = (req as any).validatedQuery || req.query;
      const result = await returnService.listReturns(storeId, query);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }
}
