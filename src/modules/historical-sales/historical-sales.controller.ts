import { Request, Response, NextFunction } from 'express';
import { HistoricalSalesService } from './historical-sales.service';
import {
  HistoricalSalesPreviewInput,
  HistoricalSalesCommitInput,
  HistoricalSalesListQueryInput,
} from './historical-sales.schema';

export class HistoricalSalesController {
  constructor(private readonly service: HistoricalSalesService = new HistoricalSalesService()) {}

  preview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      // Route middleware validate({ body: historicalSalesPreviewSchema }) owns validation and normalization
      const parsed = req.body as HistoricalSalesPreviewInput;

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
      // Route middleware validate({ body: historicalSalesCommitSchema }) owns validation
      const parsed = req.body as HistoricalSalesCommitInput;

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
      // Route middleware validate({ query: historicalSalesListQuerySchema }) owns validation
      const query = (req.query as unknown) as HistoricalSalesListQueryInput;

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
