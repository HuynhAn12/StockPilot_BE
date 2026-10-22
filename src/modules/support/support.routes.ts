import { Role } from '@prisma/client';
import { Router } from 'express';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole, requireStoreScope } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { idParamSchema } from '../../common/utils/pagination';
import { supportController as controller } from './support.controller';
import {
  adminReplySchema,
  adminTicketListQuerySchema,
  adminUpdateTicketSchema,
  createTicketSchema,
  replySchema,
  storeTicketListQuerySchema,
} from './support.schema';

/** /api/v1/support: store owners and staff talk to the platform team about their own store. */
export const supportRouter = Router();
supportRouter.use(authMiddleware);
supportRouter.use(requireStoreScope);
supportRouter.use(requireRole(Role.SHOP_OWNER, Role.WAREHOUSE_STAFF));

supportRouter.get('/tickets', validate({ query: storeTicketListQuerySchema }), controller.listStoreTickets);
supportRouter.post('/tickets', validate({ body: createTicketSchema }), controller.createTicket);
supportRouter.get('/tickets/:id', validate({ params: idParamSchema }), controller.getStoreTicket);
supportRouter.post('/tickets/:id/messages', validate({ params: idParamSchema, body: replySchema }), controller.replyAsStore);

/** /api/v1/admin/support: the platform team's inbox across every store. */
export const adminSupportRouter = Router();
adminSupportRouter.use(authMiddleware);
adminSupportRouter.use(requireRole(Role.ADMIN));

adminSupportRouter.get('/tickets', validate({ query: adminTicketListQuerySchema }), controller.listAdminTickets);
adminSupportRouter.get('/tickets/:id', validate({ params: idParamSchema }), controller.getAdminTicket);
adminSupportRouter.post('/tickets/:id/messages', validate({ params: idParamSchema, body: adminReplySchema }), controller.replyAsAdmin);
adminSupportRouter.patch('/tickets/:id', validate({ params: idParamSchema, body: adminUpdateTicketSchema }), controller.updateTicket);
