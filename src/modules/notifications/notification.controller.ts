import { Request, Response, NextFunction } from 'express';
import { NotificationService } from './notification.service';

const notificationService = new NotificationService();

export class NotificationController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await notificationService.list(
        req.user!.storeId!,
        req.user!.userId,
        (req as any).validatedQuery || req.query
      );
      return res.status(200).json({
        success: true,
        data: result.items,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  }

  async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await notificationService.markRead(req.user!.storeId!, req.user!.userId, Number(req.params.id));
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async markAllRead(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await notificationService.markAllRead(req.user!.storeId!, req.user!.userId);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}
