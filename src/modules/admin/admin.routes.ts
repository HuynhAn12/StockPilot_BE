import { Router } from 'express';
import { AdminController } from './admin.controller';
import { leadController } from '../leads/lead.controller';
import { addLeadNoteSchema, leadListQuerySchema, updateLeadSchema, updateLeadStatusSchema } from '../leads/lead.schema';
import { authMiddleware } from '../../common/middleware/auth';
import { requireRole } from '../../common/middleware/rbac';
import { validate } from '../../common/middleware/validate';
import { idParamSchema } from '../../common/utils/pagination';
import {
  adminAiUsageQuerySchema,
  adminAuditLogExportQuerySchema,
  adminAuditLogQuerySchema,
  adminStoreListQuerySchema,
  adminUserListQuerySchema,
  createAdminUserSchema,
  revokeSessionsSchema,
  settingKeyParamSchema,
  updateStatusSchema,
  updateSystemSettingSchema,
  updateStoreSchema,
  updateUserProfileSchema,
} from './admin.schema';

export const adminRouter = Router();
const controller = new AdminController();

adminRouter.use(authMiddleware);
adminRouter.use(requireRole('ADMIN'));

adminRouter.get('/dashboard', (req, res, next) => controller.getDashboard(req, res, next));

adminRouter.get('/users', validate({ query: adminUserListQuerySchema }), (req, res, next) => controller.listUsers(req, res, next));
adminRouter.post('/users', validate({ body: createAdminUserSchema }), (req, res, next) => controller.createAdminUser(req, res, next));
adminRouter.get('/users/:id', validate({ params: idParamSchema }), (req, res, next) => controller.getUser(req, res, next));
adminRouter.patch('/users/:id', validate({ params: idParamSchema, body: updateUserProfileSchema }), (req, res, next) =>
  controller.updateUserProfile(req, res, next)
);
adminRouter.patch('/users/:id/status', validate({ params: idParamSchema, body: updateStatusSchema }), (req, res, next) =>
  controller.updateUserStatus(req, res, next)
);
adminRouter.post('/users/:id/revoke-sessions', validate({ params: idParamSchema, body: revokeSessionsSchema }), (req, res, next) =>
  controller.revokeUserSessions(req, res, next)
);
adminRouter.post('/users/:id/password-reset', validate({ params: idParamSchema }), (req, res, next) =>
  controller.sendPasswordReset(req, res, next)
);

adminRouter.get('/stores', validate({ query: adminStoreListQuerySchema }), (req, res, next) => controller.listStores(req, res, next));
adminRouter.get('/stores/:id', validate({ params: idParamSchema }), (req, res, next) => controller.getStore(req, res, next));
adminRouter.patch('/stores/:id', validate({ params: idParamSchema, body: updateStoreSchema }), (req, res, next) =>
  controller.updateStore(req, res, next)
);
adminRouter.patch('/stores/:id/status', validate({ params: idParamSchema, body: updateStatusSchema }), (req, res, next) =>
  controller.updateStoreStatus(req, res, next)
);

adminRouter.get('/audit-logs', validate({ query: adminAuditLogQuerySchema }), (req, res, next) =>
  controller.listAuditLogs(req, res, next)
);
adminRouter.get('/audit-logs/export', validate({ query: adminAuditLogExportQuerySchema }), (req, res, next) =>
  controller.exportAuditLogs(req, res, next)
);

adminRouter.get('/ai-usage', validate({ query: adminAiUsageQuerySchema }), (req, res, next) => controller.getAiUsage(req, res, next));

adminRouter.get('/system/config-status', (req, res, next) => controller.getConfigStatus(req, res, next));
adminRouter.get('/system/health', (req, res, next) => controller.getSystemHealth(req, res, next));
adminRouter.get('/system/settings', (req, res, next) => controller.getSystemSettings(req, res, next));
adminRouter.put(
  '/system/settings/:key',
  validate({ params: settingKeyParamSchema, body: updateSystemSettingSchema }),
  (req, res, next) => controller.updateSystemSetting(req, res, next)
);

adminRouter.get('/leads', validate({ query: leadListQuerySchema }), leadController.list);
adminRouter.get('/leads/:id', validate({ params: idParamSchema }), leadController.get);
adminRouter.patch('/leads/:id', validate({ params: idParamSchema, body: updateLeadSchema }), leadController.update);
adminRouter.patch('/leads/:id/status', validate({ params: idParamSchema, body: updateLeadStatusSchema }), leadController.update);
adminRouter.post('/leads/:id/notes', validate({ params: idParamSchema, body: addLeadNoteSchema }), leadController.addNote);
