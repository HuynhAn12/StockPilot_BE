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
      const masked = maskSensitiveFields(result, req.user?.role);
      return res.status(200).json({ success: true, message: 'Nhập hàng vào kho thành công', data: masked });
    } catch (error) {
      next(error);
    }
  }

  async outflow(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const result = await inventoryService.outflow(storeId, userId, req.body);
      const masked = maskSensitiveFields(result, req.user?.role);
      return res.status(200).json({ success: true, message: 'Xuất hàng thủ công thành công', data: masked });
    } catch (error) {
      next(error);
    }
  }

  async audit(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const result = await inventoryService.audit(storeId, userId, req.body);
      const masked = maskSensitiveFields(result, req.user?.role);
      return res.status(200).json({ success: true, message: 'Kiểm kê kho thành công', data: masked });
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
      const query = (req as any).validatedQuery || req.query;
      const result = await inventoryService.getMovements(storeId, stockItemId, query);
      const maskedItems = maskSensitiveFields(result.items, req.user?.role);
      return res.status(200).json({ success: true, items: maskedItems, pagination: result.pagination });
    } catch (error) {
      next(error);
    }
  }
}
