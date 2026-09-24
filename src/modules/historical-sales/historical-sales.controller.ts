import { Request, Response, NextFunction } from 'express';
import { HistoricalSalesService } from './historical-sales.service';
import {
  historicalSalesPreviewSchema,
  historicalSalesCommitSchema,
  historicalSalesListQuerySchema,
} from './historical-sales.schema';

export class HistoricalSalesController {
  constructor(private readonly service: HistoricalSalesService = new HistoricalSalesService()) {}

  preview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const parsed = historicalSalesPreviewSchema.parse(req.body);

      const result = await this.service.previewHistoricalSales(storeId, userId, parsed.rows);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  commit = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const parsed = historicalSalesCommitSchema.parse(req.body);

      const result = await this.service.commitHistoricalSales(storeId, userId, parsed.jobId);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const query = historicalSalesListQuerySchema.parse(req.query);

      const result = await this.service.listHistoricalSales(storeId, query);
      return res.status(200).json({
        success: true,
        data: result.items,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  };
}
