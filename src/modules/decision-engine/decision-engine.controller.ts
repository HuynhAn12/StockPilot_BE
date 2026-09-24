import { Request, Response, NextFunction } from 'express';
import { DecisionEngineService } from './decision-engine.service';
import { EngineConfigService } from './engine-config.service';
import {
  decisionSkuParamsSchema,
  decisionOverviewQuerySchema,
  updateEngineConfigSchema,
} from './decision-engine.schema';

export class DecisionEngineController {
  constructor(
    private readonly service: DecisionEngineService = new DecisionEngineService(),
    private readonly configService: EngineConfigService = new EngineConfigService()
  ) {}

  analyzeSku = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const { stockItemId } = decisionSkuParamsSchema.parse(req.params);

      const result = await this.service.analyzeSku(storeId, stockItemId);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  getOverview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const query = decisionOverviewQuerySchema.parse(req.query);

      const result = await this.service.getOverview(storeId, query);
      return res.status(200).json({
        success: true,
        data: result.items,
        summary: result.summary,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  };

  recalculate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;

      const result = await this.service.recalculateStore(storeId);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  getConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;

      const config = await this.configService.getConfig(storeId);
      return res.status(200).json({
        success: true,
        data: config,
      });
    } catch (error) {
      next(error);
    }
  };

  updateConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const data = updateEngineConfigSchema.parse(req.body);

      const updated = await this.configService.upsertConfig(storeId, data);
      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };
}
