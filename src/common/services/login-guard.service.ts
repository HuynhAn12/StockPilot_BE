import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { logger } from '../logger';
import { RateLimitedError } from '../errors/app-error';
import { AuditLogService } from './audit-log.service';
import { OpsSettingsService } from './ops-settings.service';

/**
 * Brute-force protection for password login, built on the existing audit_logs table (no migration).
 *
 * - Every failed login writes an audit row `LOGIN_FAILED` keyed by a hash of the e-mail, so the
 *   counter works for unknown e-mails too and the raw address is never stored as the key.
 * - After `maxAttempts` failures inside `windowMinutes`, further attempts for that e-mail are
 *   rejected with 429 *before* the password is checked, and logged as `LOGIN_BLOCKED` (not counted,
 *   so a blocked attacker cannot extend the lock forever by retrying).
 * - A successful login or an admin "clear lock" resets the counter.
 * - Reads fail open: if the audit table cannot be read, login is not blocked (availability first);
 *   the IP rate limiter in app.ts still applies.
 * - The lock message is identical for existing and unknown e-mails, so it does not reveal accounts.
 */
export const LOGIN_AUDIT_ENTITY = 'AUTH_LOGIN';
export const LOGIN_FAILED_ACTION = 'LOGIN_FAILED';
export const LOGIN_BLOCKED_ACTION = 'LOGIN_BLOCKED';
export const LOGIN_LOCK_CLEARED_ACTION = 'LOGIN_LOCK_CLEARED';
/** Written by AuthService.login on success (entityType 'AUTH', entityId = userId). */
const LOGIN_SUCCESS_ACTION = 'USER_LOGIN';

export type LoginFailureReason = 'UNKNOWN_ACCOUNT' | 'INACTIVE_ACCOUNT' | 'WRONG_PASSWORD' | 'WRONG_OTP';

export interface LoginAttemptContext {
  userId?: number | null;
  storeId?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface LoginLockState {
  locked: boolean;
  failures: number;
  retryAfterMinutes: number;
  maxAttempts: number;
  windowMinutes: number;
}

export const ACCOUNT_KEY_PATTERN = /^email:[a-f0-9]{40}$/;

export function normalizeLoginEmail(email: string): string {
  return email.toLowerCase().trim();
}

/** Stable, non-reversible key for an e-mail (used as audit entityId). */
export function loginAccountKey(email: string): string {
  const digest = crypto.createHash('sha256').update(normalizeLoginEmail(email)).digest('hex');
  return `email:${digest.slice(0, 40)}`;
}

/** "nguyenvana@shop.vn" -> "ng******@shop.vn" — enough for an admin to recognise, not to harvest. */
export function maskEmail(email: string): string {
  const normalized = normalizeLoginEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.min(6, Math.max(1, local.length - visible.length)))}@${domain}`;
}

type GuardDb = Pick<PrismaClient, 'auditLog' | 'systemSetting'>;

export class LoginGuardService {
  constructor(private readonly db: GuardDb = defaultPrisma) {}

  /** Lock state for an account key. Throws on DB errors (callers decide whether to fail open). */
  async getLockState(accountKey: string, userId?: number | null, now: Date = new Date()): Promise<LoginLockState> {
    const { maxAttempts, windowMinutes } = await OpsSettingsService.get('ops.security.loginLockout', this.db);
    const base = { maxAttempts, windowMinutes };
    if (maxAttempts <= 0) {
      return { ...base, locked: false, failures: 0, retryAfterMinutes: 0 };
    }

    const windowMs = windowMinutes * 60 * 1000;
    let since = new Date(now.getTime() - windowMs);

    const [cleared, succeeded] = await Promise.all([
      this.db.auditLog.findFirst({
        where: { action: LOGIN_LOCK_CLEARED_ACTION, entityType: LOGIN_AUDIT_ENTITY, entityId: accountKey, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      userId
        ? this.db.auditLog.findFirst({
            where: { action: LOGIN_SUCCESS_ACTION, entityType: 'AUTH', entityId: String(userId), createdAt: { gte: since } },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          })
        : Promise.resolve(null),
    ]);
    for (const reset of [cleared, succeeded]) {
      if (reset && reset.createdAt > since) since = reset.createdAt;
    }

    // Newest `maxAttempts` failures since the last reset.
    const failures = await this.db.auditLog.findMany({
      where: { action: LOGIN_FAILED_ACTION, entityType: LOGIN_AUDIT_ENTITY, entityId: accountKey, createdAt: { gt: since } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
      take: maxAttempts,
    });

    if (failures.length < maxAttempts) {
      return { ...base, locked: false, failures: failures.length, retryAfterMinutes: 0 };
    }

    // The lock lifts once the oldest of these failures leaves the window.
    const oldest = failures[failures.length - 1].createdAt.getTime();
    const remainingMs = oldest + windowMs - now.getTime();
    return {
      ...base,
      locked: remainingMs > 0,
      failures: failures.length,
      retryAfterMinutes: Math.max(1, Math.ceil(remainingMs / 60000)),
    };
  }

  /** Throws RateLimitedError (429) while the e-mail is locked. Fails open on read errors. */
  async assertNotLocked(email: string, context: LoginAttemptContext = {}): Promise<void> {
    const accountKey = loginAccountKey(email);
    let state: LoginLockState;
    try {
      state = await this.getLockState(accountKey, context.userId);
    } catch (error: any) {
      logger.warn('login_guard_check_failed', { message: error?.message });
      return;
    }
    if (!state.locked) return;

    await this.writeAttempt(LOGIN_BLOCKED_ACTION, email, null, context);
    throw new RateLimitedError(
      `Đăng nhập tạm thời bị khóa do nhập sai quá nhiều lần. Vui lòng thử lại sau ${state.retryAfterMinutes} phút.`,
      { retryAfterMinutes: state.retryAfterMinutes }
    );
  }

  /** Records a failed attempt. Never throws. */
  async recordFailure(email: string, reason: LoginFailureReason, context: LoginAttemptContext = {}): Promise<void> {
    await this.writeAttempt(LOGIN_FAILED_ACTION, email, reason, context);
  }

  private async writeAttempt(action: string, email: string, reason: LoginFailureReason | null, context: LoginAttemptContext) {
    try {
      await AuditLogService.create(this.db, {
        storeId: context.storeId ?? null,
        userId: context.userId ?? null,
        action,
        entityType: LOGIN_AUDIT_ENTITY,
        entityId: loginAccountKey(email),
        afterJson: { emailMasked: maskEmail(email), reason },
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ? context.userAgent.slice(0, 255) : null,
      });
    } catch (error: any) {
      logger.warn('login_guard_record_failed', { action, message: error?.message });
    }
  }
}
