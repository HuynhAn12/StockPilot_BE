import { Request, Response, NextFunction } from 'express';
import { AnalyticsService } from './analytics.service';

const analyticsService = new AnalyticsService();

export class AnalyticsController {
  async getDashboard(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const metrics = await analyticsService.getDashboardMetrics(storeId);
      return res.status(200).json({ success: true, data: metrics });
    } catch (error) {
      next(error);
    }
  }
}
