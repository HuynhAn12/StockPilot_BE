import { Request, Response, NextFunction } from 'express';
import { maskSensitiveFields } from '../../common/middleware/sensitive-fields';
import { StockTakeService } from './stock-take.service';

const stockTakeService = new StockTakeService();

export class StockTakeController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await stockTakeService.create(req.user!.storeId!, req.user!.userId, req.body);
      return res.status(201).json({ success: true, data: maskSensitiveFields(result, req.user?.role) });
    } catch (error) {
      next(error);
    }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await stockTakeService.list(req.user!.storeId!, (req as any).validatedQuery || req.query);
      return res.status(200).json({
        success: true,
        items: maskSensitiveFields(result.items, req.user?.role),
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  }

  async detail(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await stockTakeService.detail(req.user!.storeId!, Number(req.params.id));
      return res.status(200).json({ success: true, data: maskSensitiveFields(result, req.user?.role) });
    } catch (error) {
      next(error);
    }
  }

  async start(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await stockTakeService.start(req.user!.storeId!, Number(req.params.id));
      return res.status(200).json({ success: true, data: maskSensitiveFields(result, req.user?.role) });
    } catch (error) {
      next(error);
    }
  }

  async updateCounts(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await stockTakeService.updateCounts(req.user!.storeId!, Number(req.params.id), req.body);
      return res.status(200).json({ success: true, data: maskSensitiveFields(result, req.user?.role) });
    } catch (error) {
      next(error);
    }
  }

  async complete(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await stockTakeService.complete(
        req.user!.storeId!,
        req.user!.userId,
        Number(req.params.id),
        (req as any).idempotencyContext?.effectKey
      );
      return res.status(200).json({ success: true, data: maskSensitiveFields(result, req.user?.role) });
    } catch (error) {
      next(error);
    }
  }

  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await stockTakeService.cancel(req.user!.storeId!, req.user!.userId, Number(req.params.id));
      return res.status(200).json({ success: true, data: maskSensitiveFields(result, req.user?.role) });
    } catch (error) {
      next(error);
    }
  }
}
