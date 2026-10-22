import { Router } from 'express';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { AdminController } from '../admin/admin.controller';
import { adminAuditLogQuerySchema } from '../admin/admin.schema';

/**
 * @deprecated Legacy path kept for backward compatibility. Use GET /api/v1/admin/audit-logs.
 */
export const auditLogRouter = Router();
const controller = new AdminController();

auditLogRouter.use(authMiddleware);
auditLogRouter.use(requireRole('ADMIN'));

auditLogRouter.get('/', validate({ query: adminAuditLogQuerySchema }), (req, res, next) =>
  controller.listAuditLogs(req, res, next)
);
