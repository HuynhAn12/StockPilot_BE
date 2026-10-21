import { Request, Response, NextFunction } from 'express';
import { PublicService } from './public.service';

export class PublicController {
  private publicService: PublicService;

  constructor() {
    this.publicService = new PublicService();
  }

  async createLead(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.publicService.createLead(req.body);
      return res.status(201).json({
        success: true,
        message: 'Đăng ký nhận tư vấn thành công! Chuyên viên StockPilot sẽ liên hệ với bạn trong ít phút.',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getPlatformStats(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await this.publicService.getPlatformStats();
      return res.status(200).json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }

  async getPricingPlans(req: Request, res: Response, next: NextFunction) {
    try {
      const plans = await this.publicService.getPricingPlans();
      return res.status(200).json({
        success: true,
        data: plans,
      });
    } catch (error) {
      next(error);
    }
  }
}
