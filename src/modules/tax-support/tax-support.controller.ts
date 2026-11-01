import { Request, Response, NextFunction } from 'express';
import { TaxSupportService } from './tax-support.service';
import type { RevenueBookQuery } from './tax-support.schema';

export class TaxSupportController {
  constructor(private readonly service: TaxSupportService = new TaxSupportService()) {}

  revenueThreshold = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getRevenueThreshold(req.user!.storeId!);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  revenueBookPreview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.previewRevenueBook(req.user!.storeId!, req.query as unknown as RevenueBookQuery);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  revenueBookExport = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { csv, filename } = await this.service.exportRevenueBook(req.user!.storeId!, req.query as unknown as RevenueBookQuery);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  };
}
