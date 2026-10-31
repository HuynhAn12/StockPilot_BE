import { Request, Response, NextFunction } from 'express';
import { SystemSettingsService } from '../../common/services/system-settings.service';
import { PublicService } from './public.service';

export class PublicController {
  private publicService: PublicService;

  constructor() {
    this.publicService = new PublicService();
  }

  async createLead(req: Request, res: Response, next: NextFunction) {
    try {
      // Bot filled the hidden honeypot: answer like a success but store nothing.
      if (req.body.website) {
        return res.status(201).json({ success: true, message: 'Đăng ký nhận tư vấn thành công!', data: null });
      }
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

  /** Platform banner and sign-up availability, shown on the landing page and inside every store. */
  async getPlatformStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const [banner, signupEnabled] = await Promise.all([
        SystemSettingsService.get('maintenance.banner'),
        SystemSettingsService.get('signup.enabled'),
      ]);
      return res.status(200).json({
        success: true,
        data: { announcement: banner.enabled ? banner.message : null, signupEnabled },
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
