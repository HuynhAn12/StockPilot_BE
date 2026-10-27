import { Request, Response, NextFunction } from 'express';
import { DecisionEngineService } from './decision-engine.service';
import { EngineConfigService } from './engine-config.service';
import { DecisionJobsService } from './decision-jobs.service';
import {
  decisionSkuParamsSchema,
  decisionOverviewQuerySchema,
  recalculateBodySchema,
  updateEngineConfigSchema,
} from './decision-engine.schema';
import { toEngineConfigView, toOverviewSummaryView, toSkuDecisionView } from './decision-view';

export class DecisionEngineController {
  constructor(
    private readonly service: DecisionEngineService = new DecisionEngineService(),
    private readonly configService: EngineConfigService = new EngineConfigService(),
    private readonly jobsService: DecisionJobsService = new DecisionJobsService()
  ) {}

  analyzeSku = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const { stockItemId } = decisionSkuParamsSchema.parse(req.params);

      // Read-only: latest snapshot (+ freshness), never recomputes or writes.
      const { analysis, freshness } = await this.service.getSkuDecision(storeId, stockItemId);
      return res.status(200).json({
        success: true,
        data: { ...toSkuDecisionView(analysis, req.user!.role), ...freshness },
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
      const role = req.user!.role;
      return res.status(200).json({
        success: true,
        data: result.items.map(({ analysis, freshness }) => ({ ...toSkuDecisionView(analysis, role), ...freshness })),
        summary: toOverviewSummaryView(result.summary, role),
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  };

  recalculate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const options = recalculateBodySchema.parse(req.body);

      // Bounded and exclusive per store (409 while another recalculation runs); see DecisionJobsService.
      const result = await this.jobsService.recalculateStore(storeId, options);
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
        data: toEngineConfigView(config, req.user!.role),
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
