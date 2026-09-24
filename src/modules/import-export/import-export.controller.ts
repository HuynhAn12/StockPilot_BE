import { Request, Response, NextFunction } from 'express';
import { ImportExportService } from './import-export.service';

const service = new ImportExportService();

export class ImportExportController {
  async preview(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const result = await service.previewImport(storeId, req.body.items);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  async commit(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const result = await service.commitImport(storeId, userId, req.body);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  async exportProducts(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const csv = await service.exportProductsCsv(storeId, req.user?.role);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
      return res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  }

  async exportInventory(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const csv = await service.exportInventoryCsv(storeId, req.user?.role);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
      return res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  }
}
