import { Router } from 'express';
import { InventoryController } from './inventory.controller';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { idempotency } from '../../common/middleware/idempotency';
import { inflowSchema, outflowSchema, auditSchema } from './inventory.schema';
import { movementListQuerySchema, inventoryBalanceQuerySchema } from '../../common/utils/pagination';

export const inventoryRouter = Router();
const controller = new InventoryController();

inventoryRouter.use(authMiddleware);
inventoryRouter.use(requireStoreScope);

inventoryRouter.get('/balances', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ query: inventoryBalanceQuerySchema }), (req, res, next) => controller.getBalances(req, res, next));
inventoryRouter.get('/movements', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ query: movementListQuerySchema }), (req, res, next) => controller.getMovements(req, res, next));
inventoryRouter.post('/inflow', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ body: inflowSchema }), idempotency({ operation: 'INVENTORY_INFLOW' }), (req, res, next) => controller.inflow(req, res, next));
inventoryRouter.post('/outflow', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ body: outflowSchema }), idempotency({ operation: 'INVENTORY_OUTFLOW' }), (req, res, next) => controller.outflow(req, res, next));
inventoryRouter.post('/audit', requireRole('SHOP_OWNER', 'WAREHOUSE_STAFF'), validate({ body: auditSchema }), idempotency({ operation: 'INVENTORY_AUDIT' }), (req, res, next) => controller.audit(req, res, next));

