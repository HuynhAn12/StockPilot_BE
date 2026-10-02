import { Prisma, PrismaClient } from '@prisma/client';

type AuditClient = Pick<PrismaClient, 'auditLog'> | Prisma.TransactionClient;

export interface AuditLogEntry {
  storeId?: number | null;
  userId?: number | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const SENSITIVE_KEY_PATTERN =
  /(password|token|jwt|secret|credential|authorization|cookie|session|apiKey|checksumKey|encryptionKey)/i;
const ENCRYPTED_CREDENTIAL_KEY_PATTERN =
  /^(apiKey|checksumKey|clientId|clientSecret|secret|credential|credentials).*Encrypted$/i;

export class AuditLogService {
  static sanitizeJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    const sanitized = sanitize(value);
    return sanitized === null ? Prisma.JsonNull : (sanitized as Prisma.InputJsonValue);
  }

  static async create(client: AuditClient, entry: AuditLogEntry) {
    return client.auditLog.create({
      data: {
        storeId: entry.storeId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
        beforeJson: entry.beforeJson === undefined ? undefined : AuditLogService.sanitizeJson(entry.beforeJson),
        afterJson: entry.afterJson === undefined ? undefined : AuditLogService.sanitizeJson(entry.afterJson),
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  }
}

function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitize(item));

  if (typeof value === 'object') {
    if (isPrismaDecimal(value)) return value.toFixed(2);

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) continue;
      result[key] = sanitize(child);
    }
    return result;
  }

  return String(value);
}

function isSensitiveKey(key: string) {
  return SENSITIVE_KEY_PATTERN.test(key) || ENCRYPTED_CREDENTIAL_KEY_PATTERN.test(key);
}

function isPrismaDecimal(value: object): value is Prisma.Decimal {
  return typeof (Prisma.Decimal as any).isDecimal === 'function'
    ? (Prisma.Decimal as any).isDecimal(value)
    : value.constructor?.name === 'Decimal' && typeof (value as { toString?: unknown }).toString === 'function';
}
