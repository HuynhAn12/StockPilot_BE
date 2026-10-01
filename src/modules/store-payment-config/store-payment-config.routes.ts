import { Router } from 'express';
import { StorePaymentConfigController } from './store-payment-config.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { upsertPayosConfigSchema } from './store-payment-config.schema';

export const storePaymentConfigRouter = Router();
const controller = new StorePaymentConfigController();

storePaymentConfigRouter.use(authMiddleware);
storePaymentConfigRouter.use(requireStoreScope);
storePaymentConfigRouter.use(requireRole('SHOP_OWNER'));

storePaymentConfigRouter.get('/payos', (req, res, next) => controller.getPayosStatus(req, res, next));
storePaymentConfigRouter.put('/payos', validate({ body: upsertPayosConfigSchema }), (req, res, next) =>
  controller.upsertPayosConfig(req, res, next)
);
storePaymentConfigRouter.post('/payos/deactivate', (req, res, next) =>
  controller.deactivatePayosConfig(req, res, next)
);
