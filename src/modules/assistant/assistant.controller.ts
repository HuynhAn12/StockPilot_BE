import { Request, Response, NextFunction } from 'express';
import { AssistantService } from './assistant.service';
import { explainSkuQuerySchema } from './assistant.schema';

export class AssistantController {
  constructor(private readonly service: AssistantService = new AssistantService()) {}

  explainSku = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const query = explainSkuQuerySchema.parse({
        stockItemId: req.params.stockItemId,
        question: req.query.question,
      });

      const result = await this.service.explainSku(storeId, query.stockItemId, query.question);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  explainStoreOverview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;

      const result = await this.service.explainStoreOverview(storeId);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };
}
