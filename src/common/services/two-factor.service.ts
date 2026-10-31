import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma as defaultPrisma } from '../../config/db';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors/app-error';
import { logger } from '../logger';
import { comparePassword } from '../utils/password';
import { AuditLogService } from './audit-log.service';
import { LoginAttemptContext, LoginGuardService } from './login-guard.service';
import { SecretEncryptionService } from './secret-encryption.service';
import { buildOtpAuthUrl, generateTotpSecret, totpStep, verifyTotp } from './totp.service';

/**
 * Optional two-factor authentication (TOTP) for ADMIN accounts.
 *
 * - OFF by default: nothing changes for an admin until they enable it themselves.
 * - State lives in `system_settings` under `admin2fa:<userId>` (no migration). The TOTP secret is
 *   encrypted with SecretEncryptionService; recovery codes are stored only as SHA-256 hashes.
 * - Emergency reset if every admin is locked out: delete the `admin2fa:<userId>` row in
 *   system_settings (server/DB access required). Another admin can also reset it via the API.
 */
const KEY_PREFIX = 'admin2fa:';
const ISSUER = 'StockPilot';
const RECOVERY_CODE_COUNT = 10;
const TWO_FACTOR_ENTITY = 'ADMIN_2FA';

const stateSchema = z.object({
  enabled: z.boolean(),
  secretEncrypted: z.string().optional(),
  pendingSecretEncrypted: z.string().optional(),
  recoveryCodeHashes: z.array(z.string()).default([]),
  enabledAt: z.string().optional(),
  lastUsedStep: z.number().int().optional(),
});
type TwoFactorState = z.infer<typeof stateSchema>;

type TwoFactorDb = Pick<PrismaClient, 'systemSetting' | 'auditLog' | 'user'>;

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

const hashRecoveryCode = (code: string) =>
  crypto.createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');

function generateRecoveryCode(): string {
  const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Login error that tells the client to show the 2FA code field (`error.details.twoFactorRequired`). */
export class TwoFactorRequiredError extends AppError {
  constructor(message = 'Vui lòng nhập mã xác thực 2 lớp') {
    super(message, 401, 'UNAUTHENTICATED', { twoFactorRequired: true });
  }
}

export class TwoFactorService {
  constructor(private readonly db: TwoFactorDb = defaultPrisma) {}

  private key(userId: number) {
    return `${KEY_PREFIX}${userId}`;
  }

  async getState(userId: number): Promise<TwoFactorState | null> {
    const row = await this.db.systemSetting.findUnique({ where: { key: this.key(userId) } });
    if (!row) return null;
    const parsed = stateSchema.safeParse(row.valueJson);
    if (!parsed.success) {
      logger.warn('two_factor_state_invalid', { userId });
      return null;
    }
    return parsed.data;
  }

  private async saveState(userId: number, state: TwoFactorState) {
    const key = this.key(userId);
    const valueJson = state as unknown as Prisma.InputJsonValue;
    await this.db.systemSetting.upsert({
      where: { key },
      create: { key, valueJson, description: 'Internal admin 2FA state (not a user setting)' },
      update: { valueJson },
    });
  }

  private async assertPassword(userId: number, password: string) {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!user || !(await comparePassword(password, user.passwordHash))) {
      throw new ForbiddenError('Mật khẩu xác nhận không đúng');
    }
  }

  private encrypt(secret: string): string {
    try {
      return SecretEncryptionService.encrypt(secret);
    } catch {
      throw new ValidationError('Máy chủ chưa cấu hình khóa mã hóa (PAYMENT_CONFIG_ENCRYPTION_KEY), chưa thể bật 2FA');
    }
  }

  private audit(action: string, actorUserId: number, targetUserId: number, meta: RequestMeta, after: Record<string, unknown> = {}) {
    return AuditLogService.create(this.db, {
      userId: actorUserId,
      action,
      entityType: TWO_FACTOR_ENTITY,
      entityId: targetUserId,
      afterJson: { targetUserId, ...after },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  async getStatus(userId: number) {
    const state = await this.getState(userId);
    return {
      enabled: Boolean(state?.enabled),
      enabledAt: state?.enabledAt ?? null,
      recoveryCodesRemaining: state?.enabled ? state.recoveryCodeHashes.length : 0,
      setupPending: Boolean(state?.pendingSecretEncrypted),
    };
  }

  /** Step 1: re-enter password → receive a new secret + otpauth URL (shown once, as a QR code). */
  async startSetup(userId: number, email: string, actorPassword: string) {
    await this.assertPassword(userId, actorPassword);
    const state = await this.getState(userId);
    if (state?.enabled) throw new ConflictError('Xác thực 2 lớp đang bật. Hãy tắt trước khi thiết lập lại');

    const secret = generateTotpSecret();
    await this.saveState(userId, { enabled: false, recoveryCodeHashes: [], pendingSecretEncrypted: this.encrypt(secret) });
    return { secret, otpauthUrl: buildOtpAuthUrl(ISSUER, email, secret) };
  }

  /** Step 2: confirm with a code from the app → 2FA on, 10 one-time recovery codes returned once. */
  async enable(userId: number, code: string, meta: RequestMeta = {}) {
    const state = await this.getState(userId);
    if (state?.enabled) throw new ConflictError('Xác thực 2 lớp đã được bật');
    if (!state?.pendingSecretEncrypted) throw new ValidationError('Chưa thiết lập. Hãy bắt đầu thiết lập 2FA trước');

    const secret = SecretEncryptionService.decrypt(state.pendingSecretEncrypted);
    const step = verifyTotp(secret, code);
    if (step === null) throw new ValidationError('Mã xác thực không đúng hoặc đã hết hạn');

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await this.saveState(userId, {
      enabled: true,
      secretEncrypted: state.pendingSecretEncrypted,
      recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
      enabledAt: new Date().toISOString(),
      lastUsedStep: step,
    });
    await this.audit('ADMIN_2FA_ENABLED', userId, userId, meta);
    return { enabled: true, recoveryCodes };
  }

  /** Turn off for yourself: password + a current code (or a recovery code). */
  async disable(userId: number, actorPassword: string, code: string, meta: RequestMeta = {}) {
    await this.assertPassword(userId, actorPassword);
    const state = await this.getState(userId);
    if (!state?.enabled) throw new ConflictError('Xác thực 2 lớp chưa được bật');
    if (!(await this.consumeSecondFactor(userId, state, code))) {
      throw new ValidationError('Mã xác thực không đúng');
    }
    await this.saveState(userId, { enabled: false, recoveryCodeHashes: [] });
    await this.audit('ADMIN_2FA_DISABLED', userId, userId, meta);
    return { enabled: false };
  }

  /** Another admin resets 2FA for an admin who lost their phone and recovery codes. */
  async resetForUser(targetUserId: number, actorUserId: number, actorPassword: string, reason: string, meta: RequestMeta = {}) {
    if (targetUserId === actorUserId) {
      throw new ForbiddenError('Không thể tự đặt lại 2FA của chính mình — hãy dùng chức năng tắt 2FA');
    }
    await this.assertPassword(actorUserId, actorPassword);
    const target = await this.db.user.findUnique({ where: { id: targetUserId }, select: { id: true, role: true } });
    if (!target || target.role !== 'ADMIN') throw new NotFoundError('Không tìm thấy tài khoản quản trị viên');
    await this.saveState(targetUserId, { enabled: false, recoveryCodeHashes: [] });
    await this.audit('ADMIN_2FA_RESET', actorUserId, targetUserId, meta, { reason });
    return { targetUserId, enabled: false };
  }

  /**
   * Called by AuthService.login after the password check. No-op when 2FA is off.
   * Wrong codes count as failed logins (same lockout as passwords).
   */
  async verifyLoginSecondFactor(user: { id: number }, otpCode: string | undefined, email: string, context: LoginAttemptContext) {
    const state = await this.getState(user.id);
    if (!state?.enabled) return;
    if (!otpCode) throw new TwoFactorRequiredError();

    if (await this.consumeSecondFactor(user.id, state, otpCode)) return;

    await new LoginGuardService(this.db).recordFailure(email, 'WRONG_OTP', context);
    throw new TwoFactorRequiredError('Mã xác thực 2 lớp không đúng hoặc đã hết hạn');
  }

  /** Accepts a TOTP code (no replay) or a recovery code (single use). Persists what was consumed. */
  private async consumeSecondFactor(userId: number, state: TwoFactorState, code: string): Promise<boolean> {
    if (state.secretEncrypted && /^\s*\d{6}\s*$/.test(code)) {
      let secret: string | null = null;
      try {
        secret = SecretEncryptionService.decrypt(state.secretEncrypted);
      } catch {
        logger.error('two_factor_secret_decrypt_failed', { userId });
      }
      if (secret) {
        const step = verifyTotp(secret, code, { lastUsedStep: state.lastUsedStep ?? null });
        if (step !== null) {
          await this.saveState(userId, { ...state, lastUsedStep: Math.max(step, state.lastUsedStep ?? 0) });
          return true;
        }
      }
      return false;
    }

    const hash = hashRecoveryCode(code);
    const index = state.recoveryCodeHashes.indexOf(hash);
    if (index === -1) return false;
    const remaining = [...state.recoveryCodeHashes];
    remaining.splice(index, 1);
    await this.saveState(userId, { ...state, recoveryCodeHashes: remaining, lastUsedStep: state.lastUsedStep ?? totpStep() });
    return true;
  }
}
