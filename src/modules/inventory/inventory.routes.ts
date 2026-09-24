import { Router } from 'express';
import { InventoryController } from './inventory.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { idempotency } from '../../common/middleware/idempotency';
import { inflowSchema, outflowSchema, auditSchema } from './inventory.schema';
import { movementListQuerySchema, inventoryBalanceQuerySchema } from '../../common/utils/pagination';

export const inventoryRouter = Router();
const controller = new InventoryController();

inventoryRouter.use(authMiddleware);
inventoryRouter.use(requireStoreScope);

inventoryRouter.get('/balances', validate({ query: inventoryBalanceQuerySchema }), (req, res, next) => controller.getBalances(req, res, next));
inventoryRouter.get('/movements', validate({ query: movementListQuerySchema }), (req, res, next) => controller.getMovements(req, res, next));
inventoryRouter.post('/inflow', validate({ body: inflowSchema }), idempotency({ operation: 'INVENTORY_INFLOW' }), (req, res, next) => controller.inflow(req, res, next));
inventoryRouter.post('/outflow', validate({ body: outflowSchema }), idempotency({ operation: 'INVENTORY_OUTFLOW' }), (req, res, next) => controller.outflow(req, res, next));
inventoryRouter.post('/audit', validate({ body: auditSchema }), idempotency({ operation: 'INVENTORY_AUDIT' }), (req, res, next) => controller.audit(req, res, next));

