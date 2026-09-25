import { Request, Response, NextFunction } from 'express';
import { OrderService } from './order.service';
import { maskSensitiveFields } from '../../common/middleware/sensitive-fields';

const orderService = new OrderService();

export class OrderController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const status = req.query.status as string;
      const query = (req as any).validatedQuery || req.query;
      const result = await orderService.listOrders(storeId, status, query);
      const maskedItems = maskSensitiveFields(result.items, req.user?.role);
      return res.status(200).json({ success: true, items: maskedItems, pagination: result.pagination });
    } catch (error) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const id = Number(req.params.id);
      const order = await orderService.getOrderById(storeId, id);
      const masked = maskSensitiveFields(order, req.user?.role);
      return res.status(200).json({ success: true, data: masked });
    } catch (error) {
      next(error);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const order = await orderService.createDraftOrder(
        storeId,
        userId,
        req.body,
        (req as any).idempotencyContext?.effectKey
      );
      const masked = maskSensitiveFields(order, req.user?.role);
      return res.status(201).json({ success: true, message: 'Tạo đơn hàng nháp thành công', data: masked });
    } catch (error) {
      next(error);
    }
  }

  async confirm(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const id = Number(req.params.id);
      const order = await orderService.confirmOrder(storeId, userId, id);
      const masked = maskSensitiveFields(order, req.user?.role);
      return res.status(200).json({ success: true, message: 'Xác nhận đơn và trừ tồn kho thành công', data: masked });
    } catch (error) {
      next(error);
    }
  }

  async fulfill(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const id = Number(req.params.id);
      const order = await orderService.fulfillOrder(storeId, id);
      const masked = maskSensitiveFields(order, req.user?.role);
      return res.status(200).json({ success: true, message: 'Hoàn thành đơn hàng thành công', data: masked });
    } catch (error) {
      next(error);
    }
  }

  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const userId = req.user!.userId;
      const id = Number(req.params.id);
      const order = await orderService.cancelOrder(storeId, userId, id, req.body);
      const masked = maskSensitiveFields(order, req.user?.role);
      return res.status(200).json({ success: true, message: 'Hủy đơn hàng thành công', data: masked });
    } catch (error) {
      next(error);
    }
  }
}
