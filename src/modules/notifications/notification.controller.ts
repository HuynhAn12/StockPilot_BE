import { Request, Response, NextFunction } from 'express';
import { NotificationService } from './notification.service';
import { prisma } from '../../config/db';

const notificationService = new NotificationService();

export class NotificationController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user?.storeId || 1;
      const result = await notificationService.list(
        storeId,
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
      const storeId = req.user?.storeId || 1;
      const result = await notificationService.markRead(storeId, req.user!.userId, Number(req.params.id));
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async markAllRead(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user?.storeId || 1;
      const result = await notificationService.markAllRead(storeId, req.user!.userId);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const key = `notifications_store_${storeId}`;
      const record = await prisma.systemSetting.findUnique({ where: { key } });
      const defaultSettings = {
        criticalStockout: true,
        aiPriceSuggestion: true,
        slowMoving: false,
        dailySalesReport: true,
        overstockAlert: true,
      };
      const settings = record ? { ...defaultSettings, ...(record.valueJson as any) } : defaultSettings;
      return res.status(200).json({ success: true, data: settings });
    } catch (error) {
      next(error);
    }
  }

  async updateSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const key = `notifications_store_${storeId}`;
      const saved = await prisma.systemSetting.upsert({
        where: { key },
        create: {
          key,
          valueJson: req.body,
          description: `Notification settings for store ${storeId}`,
          updatedById: userId,
        },
        update: {
          valueJson: req.body,
          updatedById: userId,
        },
      });
      return res.status(200).json({
        success: true,
        message: 'Cập nhật cài đặt thông báo thành công',
        data: saved.valueJson,
      });
    } catch (error) {
      next(error);
    }
  }
}

