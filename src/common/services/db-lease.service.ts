import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';

const LEASE_KEY_PREFIX = 'lease:';

/**
 * Best-effort cross-instance mutual exclusion for background jobs, stored as rows in the existing
 * `system_settings` table (no schema migration). A lease expires on its own, so a crashed holder
 * never blocks the job forever.
 *
 * Why not MySQL GET_LOCK: it is bound to one connection, and Prisma's pool does not pin a
 * connection for the duration of a long job.
 *
 * Leases only prevent duplicate work. Correctness of the Decision Engine never depends on them:
 * recomputation is idempotent and serialized per SKU by a row lock.
 *
 * Lease rows are not exposed by the SystemSetting admin API, which only lists known setting keys.
 */
export class DbLeaseService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  /** Returns a token when the lease was acquired, or null when another holder owns an unexpired lease. */
  async tryAcquire(name: string, ttlMs: number): Promise<string | null> {
    const key = `${LEASE_KEY_PREFIX}${name}`;
    const token = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + ttlMs;

    // Atomic "insert, or take over only if expired". The row alias syntax requires MySQL >= 8.0.19.
    await this.prisma.$executeRaw`
      INSERT INTO system_settings (\`key\`, valueJson, description, isPublic, createdAt, updatedAt)
      VALUES (${key}, JSON_OBJECT('token', ${token}, 'expiresAt', ${expiresAt}), 'Internal job lease (not a user setting)', false, NOW(3), NOW(3))
      AS incoming
      ON DUPLICATE KEY UPDATE
        valueJson = IF(CAST(JSON_EXTRACT(system_settings.valueJson, '$.expiresAt') AS UNSIGNED) < ${now}, incoming.valueJson, system_settings.valueJson),
        updatedAt = NOW(3)`;

    const row = await this.prisma.systemSetting.findUnique({ where: { key }, select: { valueJson: true } });
    const holder = (row?.valueJson as { token?: string } | null)?.token;
    return holder === token ? token : null;
  }

  /** Releases the lease only if it is still held by this token. */
  async release(name: string, token: string): Promise<void> {
    const key = `${LEASE_KEY_PREFIX}${name}`;
    await this.prisma.$executeRaw`
      DELETE FROM system_settings
      WHERE \`key\` = ${key} AND JSON_UNQUOTE(JSON_EXTRACT(valueJson, '$.token')) = ${token}`;
  }

  /** Runs `work` while holding the lease; returns `{ acquired: false }` without running it otherwise. */
  async runExclusive<T>(name: string, ttlMs: number, work: () => Promise<T>): Promise<{ acquired: true; result: T } | { acquired: false }> {
    const token = await this.tryAcquire(name, ttlMs);
    if (!token) {
      return { acquired: false };
    }

    try {
      return { acquired: true, result: await work() };
    } finally {
      await this.release(name, token).catch(() => {});
    }
  }
}
