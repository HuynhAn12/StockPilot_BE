import { Request, Response, NextFunction } from 'express';
import { PricingService } from './pricing.service';
import {
  pricingListQuerySchema,
  pricingActionParamsSchema,
  modifyRecommendationSchema,
  acceptRecommendationSchema,
} from './pricing.schema';

export class PricingController {
  constructor(private readonly service: PricingService = new PricingService()) {}

  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const query = pricingListQuerySchema.parse(req.query);

      const result = await this.service.listRecommendations(storeId, query);
      return res.status(200).json({
        success: true,
        data: result.items,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  };

  accept = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const { id } = pricingActionParamsSchema.parse(req.params);
      const body = acceptRecommendationSchema.parse(req.body || {});

      const result = await this.service.acceptRecommendation(storeId, userId, id, body.applyToStockItem);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  reject = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const { id } = pricingActionParamsSchema.parse(req.params);

      const result = await this.service.rejectRecommendation(storeId, userId, id);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  modify = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const { id } = pricingActionParamsSchema.parse(req.params);
      const body = modifyRecommendationSchema.parse(req.body);

      const result = await this.service.modifyRecommendation(
        storeId,
        userId,
        id,
        body.customPrice,
        body.applyToStockItem
      );
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };
}
