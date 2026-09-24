import { Request, Response, NextFunction } from 'express';
import { ImportExportService } from './import-export.service';

const service = new ImportExportService();

export class ImportExportController {
  async preview(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const result = await service.previewImport(storeId, userId, req.body);
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

  async exportOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const csv = await service.exportOrdersCsv(storeId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
      return res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  }

  async exportSales(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const csv = await service.exportSalesCsv(storeId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="sales.csv"');
      return res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  }

  async exportReturns(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const csv = await service.exportReturnsCsv(storeId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="returns.csv"');
      return res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  }

  async exportDecisionReport(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const csv = await service.exportDecisionReportCsv(storeId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="decision_report.csv"');
      return res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  }

  async exportAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const csv = await service.exportAlertsCsv(storeId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="smart_alerts.csv"');
      return res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  }

  async exportPricingRecommendations(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const csv = await service.exportPricingRecommendationsCsv(storeId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="pricing_recommendations.csv"');
      return res.status(200).send(csv);
    } catch (error) {
      next(error);
    }
  }
}
