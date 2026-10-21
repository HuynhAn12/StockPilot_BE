import { Router } from 'express';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { idempotency } from '../../common/middleware/idempotency';
import { PosController } from './pos.controller';
import { createPosSaleSchema } from './pos.schema';

export const posRouter = Router();
const controller = new PosController();

// Public Webhook IPN from MoMo (No auth required)
posRouter.post(
  '/momo/ipn',
  (req, res, next) => controller.handleMomoIpn(req, res, next)
);

// Public Webhook IPN from PayOS (No auth required, verified by Checksum Key HMAC-SHA256)
posRouter.post(
  '/payos/webhook',
  (req, res, next) => controller.handlePayosWebhook(req, res, next)
);

posRouter.use(authMiddleware);
posRouter.use(requireStoreScope);

posRouter.post(
  '/sales',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  validate({ body: createPosSaleSchema }),
  idempotency({ operation: 'POS_SALE_CREATE' }),
  (req, res, next) => controller.createSale(req, res, next)
);

posRouter.post(
  '/payos/create-link',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  (req, res, next) => controller.createPayosLink(req, res, next)
);

posRouter.get(
  '/payos/status/:orderCode',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  (req, res, next) => controller.checkPayosStatus(req, res, next)
);

posRouter.post(
  '/momo/create-payment',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  (req, res, next) => controller.createMomoPayment(req, res, next)
);

posRouter.get(
  '/momo/status/:momoOrderId',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  (req, res, next) => controller.checkMomoStatus(req, res, next)
);

posRouter.post(
  '/momo/confirm-success/:momoOrderId',
  requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'),
  (req, res, next) => controller.confirmMomoSuccess(req, res, next)
);

posRouter.get(
  '/momo/config',
  requireRole('SHOP_OWNER'),
  (req, res, next) => controller.getMomoConfig(req, res, next)
);

posRouter.post(
  '/momo/config',
  requireRole('SHOP_OWNER'),
  (req, res, next) => controller.saveMomoConfig(req, res, next)
);


