import { z } from 'zod';
import { ACCOUNT_KEY_PATTERN } from '../../common/services/login-guard.service';
import { OPS_SETTING_KEYS } from '../../common/services/ops-settings.service';
import { SYSTEM_SETTING_KEYS } from '../../common/services/system-settings.service';

const reasonSchema = z.string().trim().min(3, 'Vui lòng nhập lý do (ít nhất 3 ký tự)').max(500);
const actorPasswordSchema = z.string().min(1, 'Vui lòng nhập mật khẩu của bạn để xác nhận').max(128);

export const storeIdParamSchema = z.object({
  storeId: z.coerce.number().int().positive({ message: 'storeId phải là số nguyên dương' }),
});

export const loginFailureQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const accountKeyParamSchema = z.object({
  accountKey: z.string().regex(ACCOUNT_KEY_PATTERN, 'Mã tài khoản không hợp lệ'),
});

export const clearLockSchema = z.object({ reason: reasonSchema }).strict();

export const paymentHealthQuerySchema = z.object({
  pendingMinutes: z.coerce.number().int().min(5).max(1440).optional(),
});

export const supportSlaQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((d) => !(d.from && d.to) || d.from <= d.to, { message: '"from" phải trước hoặc bằng "to"' });

export const growthQuerySchema = z.object({
  period: z.enum(['week', 'month']).default('month'),
  periods: z.coerce.number().int().min(1).max(24).default(6),
  dormantDays: z.coerce.number().int().min(7).max(365).default(30),
});

const ALL_SETTING_KEYS = [...SYSTEM_SETTING_KEYS, ...OPS_SETTING_KEYS] as [string, ...string[]];

export const settingHistoryQuerySchema = z.object({
  key: z.preprocess((v) => (v === '' || v === 'ALL' ? undefined : v), z.enum(ALL_SETTING_KEYS).optional()),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const auditIdParamSchema = z.object({
  auditId: z.string().regex(/^\d{1,19}$/, 'auditId không hợp lệ'),
});

export const restoreSettingSchema = z.object({ reason: reasonSchema }).strict();

export const opsSettingKeyParamSchema = z.object({
  key: z.enum(OPS_SETTING_KEYS as [string, ...string[]]),
});

export const updateOpsSettingSchema = z.object({ value: z.unknown() }).strict();

export const transferOwnerSchema = z
  .object({
    newOwnerUserId: z.coerce.number().int().positive(),
    reason: reasonSchema,
    actorPassword: actorPasswordSchema,
    deactivateFormerOwner: z.boolean().default(false),
  })
  .strict();

export const broadcastSchema = z
  .object({
    title: z.string().trim().min(3, 'Tiêu đề quá ngắn').max(150),
    message: z.string().trim().min(3, 'Nội dung quá ngắn').max(2000),
    storeIds: z.array(z.coerce.number().int().positive()).min(1).max(500).optional(),
    roles: z.array(z.enum(['SHOP_OWNER', 'WAREHOUSE_STAFF'])).min(1).optional(),
  })
  .strict();

export const retentionQuerySchema = z.object({
  olderThanDays: z.coerce.number().int().min(30).max(3650).default(180),
});

export const twoFactorSetupSchema = z.object({ actorPassword: actorPasswordSchema }).strict();
export const twoFactorEnableSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Mã gồm 6 chữ số') }).strict();
export const twoFactorDisableSchema = z
  .object({ actorPassword: actorPasswordSchema, code: z.string().trim().min(6).max(20) })
  .strict();
export const twoFactorResetSchema = z.object({ actorPassword: actorPasswordSchema, reason: reasonSchema }).strict();
export const userIdParamSchema = z.object({ userId: z.coerce.number().int().positive() });

export type RetentionQuery = z.infer<typeof retentionQuerySchema>;
export type LoginFailureQuery = z.infer<typeof loginFailureQuerySchema>;
export type PaymentHealthQuery = z.infer<typeof paymentHealthQuerySchema>;
export type SupportSlaQuery = z.infer<typeof supportSlaQuerySchema>;
export type GrowthQuery = z.infer<typeof growthQuerySchema>;
export type SettingHistoryQuery = z.infer<typeof settingHistoryQuerySchema>;
export type TransferOwnerInput = z.infer<typeof transferOwnerSchema>;
export type BroadcastInput = z.infer<typeof broadcastSchema>;
