import { Request, Response, NextFunction } from 'express';
import { PosService } from './pos.service';
import { PosPayosService } from './pos-payos.service';
import { PosMomoService } from './pos-momo.service';

const service = new PosService();
const payosService = new PosPayosService();
const momoService = new PosMomoService();

export class PosController {
  async createSale(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await service.createCashSale(
        req.user!.storeId!,
        req.user!.userId,
        req.body,
        (req as any).idempotencyContext?.effectKey
      );

      return res.status(201).json({
        success: true,
        message: 'POS sale created',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async createPayosLink(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await payosService.createPaymentLink(
        req.user!.storeId!,
        req.user!.userId,
        req.body
      );

      return res.status(201).json({
        success: true,
        message: 'PayOS payment link created',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async checkPayosStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const orderCode = Number(req.params.orderCode);
      const result = await payosService.checkPaymentStatus(req.user!.storeId!, orderCode);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async createMomoPayment(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await momoService.createPayment(
        req.user!.storeId!,
        req.user!.userId,
        req.body
      );

      return res.status(201).json({
        success: true,
        message: 'MoMo QR payment created',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async checkMomoStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const momoOrderId = req.params.momoOrderId;
      const result = await momoService.checkPaymentStatus(req.user!.storeId!, momoOrderId);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async confirmMomoSuccess(req: Request, res: Response, next: NextFunction) {
    try {
      const momoOrderId = req.params.momoOrderId;
      const result = await momoService.confirmPaymentSuccess(req.user!.storeId!, momoOrderId);

      return res.status(200).json({
        success: true,
        message: 'MoMo payment confirmed successfully',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async handleMomoIpn(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.body || {};
      if (orderId) {
        // Find store from orderId
        const order = await (service as any).db?.order?.findFirst({ where: { orderNumber: { contains: orderId } } });
        if (order) {
          await momoService.confirmPaymentSuccess(order.storeId, orderId);
        }
      }
      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  async getMomoConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await momoService.getMomoConfig(req.user!.storeId!);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async saveMomoConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await momoService.saveMomoConfig(req.user!.storeId!, req.body);
      return res.status(200).json({
        success: true,
        message: 'Cập nhật cấu hình Ví MoMo thành công',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}


