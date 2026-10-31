import { Request, Response, NextFunction } from 'express';
import { AlertService } from './alert.service';
import { alertListQuerySchema, alertActionParamsSchema, acknowledgeAlertBodySchema } from './alert.schema';

export class AlertController {
  constructor(private readonly service: AlertService = new AlertService()) {}

  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const query = alertListQuerySchema.parse(req.query);

      const result = await this.service.listAlerts(storeId, query, req.user!.role);
      return res.status(200).json({
        success: true,
        data: result.items,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  };

  stats = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const result = await this.service.getStats(storeId);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  acknowledge = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const { id } = alertActionParamsSchema.parse(req.params);
      const { note } = acknowledgeAlertBodySchema.parse(req.body);

      const result = await this.service.acknowledgeAlert(storeId, id, userId, {
        note,
        actorRole: req.user!.role,
      });
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  resolve = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const { id } = alertActionParamsSchema.parse(req.params);

      const result = await this.service.resolveAlert(storeId, id, userId);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };
}
