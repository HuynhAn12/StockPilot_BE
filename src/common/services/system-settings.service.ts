import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma as defaultPrisma } from '../../config/db';
import { logger } from '../logger';
import { ValidationError } from '../errors/app-error';

/**
 * Platform settings an admin can change at runtime (stored in system_settings).
 * Only keys declared here can be read or written; each has a schema and a safe default.
 */
export const SYSTEM_SETTING_DEFINITIONS = {
  'signup.enabled': {
    schema: z.boolean(),
    defaultValue: true,
    description: 'Cho phép cửa hàng mới tự đăng ký trên trang chủ',
  },
  'maintenance.banner': {
    schema: z
      .object({
        enabled: z.boolean(),
        message: z.string().trim().max(300),
      })
      .strict()
      .refine((v) => !v.enabled || v.message.length > 0, { message: 'Cần nhập nội dung thông báo khi bật' }),
    defaultValue: { enabled: false, message: '' },
    description: 'Thông báo hiển thị cho mọi cửa hàng (bảo trì, sự cố, cập nhật)',
  },
  'ai.dailyQuotaPerStore': {
    schema: z.number().int().min(0).max(10000),
    defaultValue: 0,
    description: 'Số lượt hỏi trợ lý AI tối đa mỗi cửa hàng mỗi ngày (0 = không giới hạn)',
  },
} as const;

export type SystemSettingKey = keyof typeof SYSTEM_SETTING_DEFINITIONS;
export type SystemSettingValue<K extends SystemSettingKey> = (typeof SYSTEM_SETTING_DEFINITIONS)[K]['defaultValue'] extends boolean
  ? boolean
  : (typeof SYSTEM_SETTING_DEFINITIONS)[K]['defaultValue'] extends number
  ? number
  : { enabled: boolean; message: string };

export const SYSTEM_SETTING_KEYS = Object.keys(SYSTEM_SETTING_DEFINITIONS) as SystemSettingKey[];

type SettingsDb = Pick<PrismaClient, 'systemSetting'> | Prisma.TransactionClient;

export class SystemSettingsService {
  /**
   * Reads one setting. A missing or invalid row, or a read failure, falls back to the default so a
   * settings problem never blocks sign-up, the AI assistant or page rendering.
   */
  static async get<K extends SystemSettingKey>(key: K, db: SettingsDb = defaultPrisma): Promise<SystemSettingValue<K>> {
    const definition = SYSTEM_SETTING_DEFINITIONS[key];
    try {
      const row = await db.systemSetting.findUnique({ where: { key } });
      if (!row) return definition.defaultValue as SystemSettingValue<K>;
      const parsed = definition.schema.safeParse(row.valueJson);
      if (parsed.success) return parsed.data as SystemSettingValue<K>;
      logger.warn('system_setting_invalid', { key });
    } catch (error: any) {
      logger.warn('system_setting_read_failed', { key, message: error?.message });
    }
    return definition.defaultValue as SystemSettingValue<K>;
  }

  static async getAll(db: SettingsDb = defaultPrisma) {
    const rows = await db.systemSetting.findMany({
      where: { key: { in: SYSTEM_SETTING_KEYS } },
      include: { updatedBy: { select: { id: true, fullName: true } } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));

    return SYSTEM_SETTING_KEYS.map((key) => {
      const definition = SYSTEM_SETTING_DEFINITIONS[key];
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

  /** Validates against the key's schema; throws ValidationError on invalid input. */
  static parse(key: SystemSettingKey, value: unknown) {
    const result = SYSTEM_SETTING_DEFINITIONS[key].schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(result.error.issues[0]?.message || 'Giá trị cài đặt không hợp lệ');
    }
    return result.data;
  }
}
