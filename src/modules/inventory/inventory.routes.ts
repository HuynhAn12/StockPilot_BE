import { Router } from 'express';
import { InventoryController } from './inventory.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { inflowSchema, outflowSchema, auditSchema } from './inventory.schema';

export const inventoryRouter = Router();
const controller = new InventoryController();

inventoryRouter.use(authMiddleware);
inventoryRouter.use(requireStoreScope);

inventoryRouter.get('/balances', (req, res, next) => controller.getBalances(req, res, next));
inventoryRouter.get('/movements', (req, res, next) => controller.getMovements(req, res, next));
inventoryRouter.post('/inflow', validate({ body: inflowSchema }), (req, res, next) => controller.inflow(req, res, next));
inventoryRouter.post('/outflow', validate({ body: outflowSchema }), (req, res, next) => controller.outflow(req, res, next));
inventoryRouter.post('/audit', validate({ body: auditSchema }), (req, res, next) => controller.audit(req, res, next));
