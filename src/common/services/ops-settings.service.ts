import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma as defaultPrisma } from '../../config/db';
import { logger } from '../logger';
import { ValidationError } from '../errors/app-error';

/**
 * Operational thresholds an admin can tune at runtime (stored in `system_settings`, no migration).
 *
 * Kept separate from SYSTEM_SETTING_DEFINITIONS on purpose: those keys are exposed by the existing
 * `/admin/system/settings` API and typed for the shop-facing settings. These "ops.*" keys are only
 * read/written through `/admin/ops/settings` and never shown to shops.
 */
export const OPS_SETTING_DEFINITIONS = {
  'ops.security.loginLockout': {
    schema: z
      .object({
        maxAttempts: z.number().int().min(0).max(50),
        windowMinutes: z.number().int().min(1).max(1440),
      })
      .strict(),
    defaultValue: { maxAttempts: 5, windowMinutes: 15 },
    description: 'Tạm khóa đăng nhập của một email sau N lần nhập sai trong M phút (maxAttempts = 0 để tắt)',
  },
  'ops.support.firstResponseSlaHours': {
    schema: z
      .object({
        HIGH: z.number().min(0.25).max(720),
        NORMAL: z.number().min(0.25).max(720),
        LOW: z.number().min(0.25).max(720),
      })
      .strict(),
    defaultValue: { HIGH: 4, NORMAL: 24, LOW: 72 },
    description: 'Thời hạn phản hồi đầu tiên cho ticket hỗ trợ theo mức ưu tiên (giờ)',
  },
  'ops.payments.pendingAlertMinutes': {
    schema: z.number().int().min(5).max(1440),
    defaultValue: 30,
    description: 'Giao dịch PayOS ở trạng thái chờ quá số phút này được coi là treo',
  },
} as const;

export type OpsSettingKey = keyof typeof OPS_SETTING_DEFINITIONS;
export type OpsSettingValue<K extends OpsSettingKey> = z.infer<(typeof OPS_SETTING_DEFINITIONS)[K]['schema']>;
export const OPS_SETTING_KEYS = Object.keys(OPS_SETTING_DEFINITIONS) as OpsSettingKey[];

type SettingsDb = Pick<PrismaClient, 'systemSetting'> | Prisma.TransactionClient;

export class OpsSettingsService {
  static isOpsKey(key: unknown): key is OpsSettingKey {
    return typeof key === 'string' && (OPS_SETTING_KEYS as string[]).includes(key);
  }

  /** Reads one value; a missing/invalid row or a read failure falls back to the safe default. */
  static async get<K extends OpsSettingKey>(key: K, db: SettingsDb = defaultPrisma): Promise<OpsSettingValue<K>> {
    const definition = OPS_SETTING_DEFINITIONS[key];
    try {
      const row = await db.systemSetting.findUnique({ where: { key } });
      if (row) {
        const parsed = definition.schema.safeParse(row.valueJson);
        if (parsed.success) return parsed.data as OpsSettingValue<K>;
        logger.warn('ops_setting_invalid', { key });
      }
    } catch (error: any) {
      logger.warn('ops_setting_read_failed', { key, message: error?.message });
    }
    return definition.defaultValue as OpsSettingValue<K>;
  }

  static async getAll(db: SettingsDb = defaultPrisma) {
    const rows = await db.systemSetting.findMany({
      where: { key: { in: OPS_SETTING_KEYS } },
      include: { updatedBy: { select: { id: true, fullName: true } } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return OPS_SETTING_KEYS.map((key) => {
      const definition = OPS_SETTING_DEFINITIONS[key];
      const row = byKey.get(key);
      const parsed = row ? definition.schema.safeParse(row.valueJson) : null;
      return {
        key,
        value: parsed?.success ? parsed.data : definition.defaultValue,
        defaultValue: definition.defaultValue,
        description: definition.description,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    });
  }

  static parse<K extends OpsSettingKey>(key: K, value: unknown): OpsSettingValue<K> {
    const result = OPS_SETTING_DEFINITIONS[key].schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(result.error.issues[0]?.message || 'Giá trị cài đặt không hợp lệ');
    }
    return result.data as OpsSettingValue<K>;
  }
}
