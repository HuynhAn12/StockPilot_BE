import { z } from 'zod';
import { paginationQuerySchema } from '../../common/utils/pagination';
import { SYSTEM_SETTING_KEYS } from '../../common/services/system-settings.service';

/** Current admin's own password, re-entered to confirm a high-impact action. */
const actorPasswordSchema = z.string().min(1, 'Vui lòng nhập mật khẩu của bạn để xác nhận').max(128);
const optionalActorPasswordSchema = z.string().max(128).optional();

const optionalTrimmedString = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().trim().max(191).optional()
);

const optionalBooleanQuery = z.preprocess((val) => {
  if (val === 'true' || val === true) return true;
  if (val === 'false' || val === false) return false;
  if (val === '' || val === 'ALL') return undefined;
  return val;
}, z.boolean().optional());

const emptyOrAllToUndefined = (val: unknown) => (val === '' || val === 'ALL' ? undefined : val);

const dateRangeRefinement = {
  check: (data: { from?: Date; to?: Date }) => !(data.from && data.to) || data.from <= data.to,
  message: 'Khoảng thời gian không hợp lệ: "from" phải trước hoặc bằng "to"',
};

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'REJECTED'] as const;

export const adminUserListQuerySchema = paginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: optionalTrimmedString,
  role: z.preprocess(emptyOrAllToUndefined, z.enum(['SHOP_OWNER', 'WAREHOUSE_STAFF', 'ADMIN']).optional()),
  isActive: optionalBooleanQuery,
  storeId: z.coerce.number().int().positive().optional(),
});

export const createAdminUserSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Họ tên phải có ít nhất 2 ký tự').max(255),
    email: z.string().trim().email('Email không đúng định dạng').max(255),
    password: z.string().min(8, 'Mật khẩu phải có ít nhất 8 ký tự').max(128),
    actorPassword: actorPasswordSchema,
  })
  .strict();

export const updateStatusSchema = z
  .object({
    isActive: z.boolean({ required_error: 'Vui lòng truyền isActive (true/false)' }),
    reason: z.string().trim().max(500).optional(),
    actorPassword: optionalActorPasswordSchema,
  })
  .strict()
  .refine((data) => data.isActive || (data.reason?.length ?? 0) >= 5, {
    message: 'Vui lòng nhập lý do khóa (ít nhất 5 ký tự). Lý do được lưu vào nhật ký kiểm toán.',
    path: ['reason'],
  });

export const revokeSessionsSchema = z
  .object({
    reason: z.string().trim().min(5, 'Vui lòng nhập lý do (ít nhất 5 ký tự)').max(500),
  })
  .strict();

export const settingKeyParamSchema = z.object({
  key: z.enum(SYSTEM_SETTING_KEYS as [string, ...string[]], { errorMap: () => ({ message: 'Cài đặt không tồn tại' }) }),
});

export const updateSystemSettingSchema = z
  .object({
    value: z.unknown().refine((v) => v !== undefined, { message: 'Vui lòng truyền value' }),
  })
  .strict();

export const adminStoreListQuerySchema = paginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: optionalTrimmedString,
  isActive: optionalBooleanQuery,
});

const auditLogFilterShape = {
  storeId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  action: optionalTrimmedString,
  entityType: z.preprocess(emptyOrAllToUndefined, z.string().trim().max(50).optional()),
  search: optionalTrimmedString,
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

export const adminAuditLogQuerySchema = paginationQuerySchema
  .extend({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    ...auditLogFilterShape,
  })
  .refine(dateRangeRefinement.check, { message: dateRangeRefinement.message, path: ['from'] });

export const adminAuditLogExportQuerySchema = z
  .object(auditLogFilterShape)
  .refine(dateRangeRefinement.check, { message: dateRangeRefinement.message, path: ['from'] });

export const adminAiUsageQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine(dateRangeRefinement.check, { message: dateRangeRefinement.message, path: ['from'] });

export const adminLeadListQuerySchema = paginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: optionalTrimmedString,
  status: z.preprocess(emptyOrAllToUndefined, z.enum(LEAD_STATUSES).optional()),
});

export const updateLeadStatusSchema = z
  .object({
    status: z.enum(LEAD_STATUSES, { errorMap: () => ({ message: 'Trạng thái lead không hợp lệ' }) }),
  })
  .strict();

export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;
export type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>;
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;
export type AdminStoreListQuery = z.infer<typeof adminStoreListQuerySchema>;
export type AdminAuditLogQuery = z.infer<typeof adminAuditLogQuerySchema>;
export type AdminAuditLogFilter = z.infer<typeof adminAuditLogExportQuerySchema>;
export type AdminAiUsageQuery = z.infer<typeof adminAiUsageQuerySchema>;
export type AdminLeadListQuery = z.infer<typeof adminLeadListQuerySchema>;
export type UpdateLeadStatusInput = z.infer<typeof updateLeadStatusSchema>;
export type RevokeSessionsInput = z.infer<typeof revokeSessionsSchema>;
