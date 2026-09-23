import { Request, Response, NextFunction } from 'express';
import { InventoryService } from './inventory.service';
import { maskSensitiveFields } from '../../common/middleware/sensitive-fields';

const inventoryService = new InventoryService();

export class InventoryController {
  async inflow(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const result = await inventoryService.inflow(storeId, userId, req.body);
      return res.status(200).json({ success: true, message: 'Nhập kho thành công', data: result });
    } catch (error) {
      next(error);
    }
  }

  async outflow(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const result = await inventoryService.outflow(storeId, userId, req.body);
      return res.status(200).json({ success: true, message: 'Xuất kho thành công', data: result });
    } catch (error) {
      next(error);
    }
  }

  async audit(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const result = await inventoryService.audit(storeId, userId, req.body);
      return res.status(200).json({ success: true, message: 'Kiểm kê kho thành công', data: result });
    } catch (error) {
      next(error);
    }
  }

  async getBalances(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const warehouseId = req.query.warehouseId ? Number(req.query.warehouseId) : undefined;
      const balances = await inventoryService.getBalances(storeId, warehouseId);
      const masked = maskSensitiveFields(balances, req.user?.role);
      return res.status(200).json({ success: true, data: masked });
    } catch (error) {
      next(error);
    }
  }

  async getMovements(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const stockItemId = req.query.stockItemId ? Number(req.query.stockItemId) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const movements = await inventoryService.getMovements(storeId, stockItemId, limit);
      const masked = maskSensitiveFields(movements, req.user?.role);
      return res.status(200).json({ success: true, data: masked });
    } catch (error) {
      next(error);
    }
  }
}
