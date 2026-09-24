import { Request, Response, NextFunction } from 'express';
import { DecisionEngineService } from './decision-engine.service';
import { PolicyService } from './policy.service';
import {
  decisionSkuParamsSchema,
  decisionOverviewQuerySchema,
  updatePolicySchema,
} from './decision-engine.schema';

export class DecisionEngineController {
  constructor(
    private readonly service: DecisionEngineService = new DecisionEngineService(),
    private readonly policyService: PolicyService = new PolicyService()
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

  getPolicy = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const { stockItemId } = decisionSkuParamsSchema.parse(req.params);

      const policy = await this.policyService.getPolicy(storeId, stockItemId);
      return res.status(200).json({
        success: true,
        data: policy,
      });
    } catch (error) {
      next(error);
    }
  };

  updatePolicy = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const { stockItemId } = decisionSkuParamsSchema.parse(req.params);
      const data = updatePolicySchema.parse(req.body);

      const updated = await this.policyService.upsertPolicy(storeId, stockItemId, data);
      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };
}
