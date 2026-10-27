import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { prisma as defaultPrisma } from '../../config/db';
import { hashPassword, comparePassword } from '../../common/utils/password';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  hashToken,
  getRefreshTokenExpiry,
} from '../../common/utils/jwt';
import { ConflictError, ForbiddenError, UnauthenticatedError, ValidationError } from '../../common/errors/app-error';
import { SystemSettingsService } from '../../common/services/system-settings.service';
import { env } from '../../config/env';
import { z } from 'zod';
import { registerSchema, sendRegisterOtpSchema, loginSchema, updateProfileSchema, forgotPasswordSchema, verifyOtpSchema, resetPasswordSchema } from './auth.schema';
import { AuditLogService } from '../../common/services/audit-log.service';
import { LoginGuardService } from '../../common/services/login-guard.service';
import { TwoFactorService } from '../../common/services/two-factor.service';
import { isValidTenantCode, normalizeTenantCode } from '../../common/utils/tenant-slug';
import { sendPasswordResetOtpEmail, sendRegisterOtpEmail } from '../../common/services/email.service';
import { sendPasswordResetOtpSms } from '../../common/services/sms.service';

// Store in-memory OTPs for registration verification (email -> { otp, expiresAt })
const registerOtpStore = new Map<string, { otp: string; expiresAt: Date }>();

export class AuthService {
  private prisma: PrismaClient;

  constructor(customPrisma?: PrismaClient) {
    this.prisma = customPrisma || defaultPrisma;
  }

  async sendRegisterOtp(input: z.infer<typeof sendRegisterOtpSchema>) {
    await this.assertSignupEnabled();
    const email = input.email.toLowerCase().trim();

    // 1. Kiểm tra email đã tồn tại hay chưa
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new ConflictError('Email này đã được sử dụng trong hệ thống');
    }

    // 2. Nếu có storeCode, kiểm tra trước storeCode
    if (input.storeCode) {
      const storeCode = normalizeTenantCode(input.storeCode);
      if (!isValidTenantCode(storeCode)) {
        throw new ValidationError('Mã cửa hàng phải là slug DNS hợp lệ');
      }
      const existingStore = await this.prisma.store.findUnique({
        where: { code: storeCode },
      });
      if (existingStore) {
        throw new ConflictError('Mã cửa hàng (Store Code) đã tồn tại');
      }
    }

    // 3. Sinh OTP 6 chữ số ngẫu nhiên
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 phút

    // Lưu vào bộ nhớ
    registerOtpStore.set(email, { otp, expiresAt });

    // 4. Gửi email chứa mã OTP
    const emailResult = await sendRegisterOtpEmail({
      to: email,
      name: input.fullName,
      otp,
      expiresMinutes: 10,
    });

    const publicResult: { expiresAt: Date; otp?: string; emailSent: boolean; simulated: boolean } = {
      expiresAt,
      emailSent: emailResult.sent,
      simulated: emailResult.simulated || false,
    };

    if (process.env.NODE_ENV !== 'production') {
      publicResult.otp = otp;
    }

    return publicResult;
  }

  async registerOwner(input: z.infer<typeof registerSchema>, meta?: { userAgent?: string; ipAddress?: string }) {
    await this.assertSignupEnabled();
    const email = input.email.toLowerCase().trim();

    // 1. Xác thực mã OTP đăng ký (bắt buộc trong production)
    if (input.otp) {
      const stored = registerOtpStore.get(email);
      if (!stored || stored.expiresAt < new Date()) {
        registerOtpStore.delete(email);
        throw new ValidationError('Mã OTP xác thực đã hết hạn hoặc không tồn tại. Vui lòng bấm gửi lại mã OTP');
      }

      if (stored.otp !== input.otp.trim()) {
        throw new ValidationError('Mã OTP xác thực không chính xác. Vui lòng kiểm tra lại hộp thư email');
      }
      registerOtpStore.delete(email);
    } else if (process.env.NODE_ENV === 'production') {
      throw new ValidationError('Mã OTP xác thực là bắt buộc');
    }

    const storeCode = normalizeTenantCode(input.storeCode);
    if (!isValidTenantCode(storeCode)) {
      throw new ValidationError(
        'Store code must be a DNS-safe tenant slug and cannot use a reserved platform hostname'
      );
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictError('Email này đã được sử dụng trong hệ thống');
    }

    const existingStore = await this.prisma.store.findUnique({
      where: { code: storeCode },
    });

    if (existingStore) {
      throw new ConflictError('Mã cửa hàng (Store Code) đã tồn tại');
    }

    // Xóa OTP sau khi kiểm tra hợp lệ
    registerOtpStore.delete(email);

    const passwordHash = await hashPassword(input.password);

    // Atomic Transaction: Create Store + Default Warehouse + Owner User + Initial AuthSession
    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.create({
        data: {
          name: input.storeName.trim(),
          code: storeCode,
          phone: input.phone,
          address: input.address,
        },
      });

      const defaultWarehouse = await tx.warehouse.create({
        data: {
          storeId: store.id,
          name: 'Kho Mặc Định',
          location: input.address || 'Kho chính',
          isDefault: true,
        },
      });

      const user = await tx.user.create({
        data: {
          email: input.email.toLowerCase().trim(),
          passwordHash,
          fullName: input.fullName.trim(),
          role: 'SHOP_OWNER',
          storeId: store.id,
        },
      });

      const tokenPayload = {
        userId: user.id,
        email: user.email,
        role: user.role,
        storeId: user.storeId,
      };

      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);
      const refreshTokenHash = hashToken(refreshToken);
      const expiresAt = getRefreshTokenExpiry(refreshToken);

      await tx.authSession.create({
        data: {
          userId: user.id,
          refreshTokenHash,
          expiresAt,
          userAgent: meta?.userAgent,
          ipAddress: meta?.ipAddress,
        },
      });

      await AuditLogService.create(tx, {
        storeId: store.id,
        userId: user.id,
        action: 'STORE_REGISTERED',
        entityType: 'STORE',
        entityId: store.id,
        afterJson: {
          storeId: store.id,
          storeCode: store.code,
          ownerUserId: user.id,
        },
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      });

      await AuditLogService.create(tx, {
        storeId: store.id,
        userId: user.id,
        action: 'USER_CREATED',
        entityType: 'USER',
        entityId: user.id,
        afterJson: {
          userId: user.id,
          role: user.role,
          storeId: user.storeId,
          storeCode: store.code,
          isActive: user.isActive,
        },
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      });

      return {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          storeId: user.storeId,
        },
        store,
        warehouse: defaultWarehouse,
        tokens: {
          accessToken,
          refreshToken,
        },
      };
    });
  }

  private async assertSignupEnabled() {
    if (!(await SystemSettingsService.get('signup.enabled', this.prisma))) {
      throw new ForbiddenError('StockPilot đang tạm ngừng nhận đăng ký cửa hàng mới. Vui lòng để lại thông tin liên hệ để được hỗ trợ.');
    }
  }

  async login(input: z.infer<typeof loginSchema>, meta?: { userAgent?: string; ipAddress?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase().trim() },
      include: {
        store: true,
      },
    });

    // Chống dò mật khẩu: ghi LOGIN_FAILED và tạm khóa theo email (xem LoginGuardService)
    const loginGuard = new LoginGuardService(this.prisma);
    const attempt = { userId: user?.id ?? null, storeId: user?.storeId ?? null, ipAddress: meta?.ipAddress, userAgent: meta?.userAgent };
    await loginGuard.assertNotLocked(input.email, attempt);

    if (!user || !user.isActive || (user.storeId && !user.store?.isActive)) {
      await loginGuard.recordFailure(input.email, user ? 'INACTIVE_ACCOUNT' : 'UNKNOWN_ACCOUNT', attempt);
      throw new UnauthenticatedError('Tài khoản hoặc mật khẩu không chính xác');
    }

    const isMatch = await comparePassword(input.password, user.passwordHash);
    if (!isMatch) {
      await loginGuard.recordFailure(input.email, 'WRONG_PASSWORD', attempt);
      throw new UnauthenticatedError('Tài khoản hoặc mật khẩu không chính xác');
    }

    // Xác thực 2 lớp: chỉ áp dụng cho ADMIN đã tự bật (mặc định tắt)
    if (user.role === 'ADMIN') {
      await new TwoFactorService(this.prisma).verifyLoginSecondFactor(user, input.otpCode, input.email, attempt);
    }

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      storeId: user.storeId,
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);
    const refreshTokenHash = hashToken(refreshToken);
    const expiresAt = getRefreshTokenExpiry(refreshToken);

    // Store new session with token hash
    await this.prisma.authSession.create({
      data: {
        userId: user.id,
        refreshTokenHash,
        expiresAt,
        userAgent: meta?.userAgent,
        ipAddress: meta?.ipAddress,
      },
    });

    await AuditLogService.create(this.prisma, {
      storeId: user.storeId,
      userId: user.id,
      action: 'USER_LOGIN',
      entityType: 'AUTH',
      entityId: user.id,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
      afterJson: {
        email: user.email,
        role: user.role,
        fullName: user.fullName,
      },
    }).catch(() => {});

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        storeId: user.storeId,
      },
      store: user.store,
      tokens: {
        accessToken,
        refreshToken,
      },
    };
  }

  async refreshToken(token: string, meta?: { userAgent?: string; ipAddress?: string }) {
    let _payload;
    try {
      _payload = verifyRefreshToken(token);
    } catch {
      throw new UnauthenticatedError('Refresh token không hợp lệ hoặc đã hết hạn');
    }

    const tokenHash = hashToken(token);
    const session = await ((this.prisma.authSession as any).findUnique
      ? this.prisma.authSession.findUnique({
          where: { refreshTokenHash: tokenHash },
          include: { user: { include: { store: true } } },
        })
      : this.prisma.authSession.findFirst({
          where: { refreshTokenHash: tokenHash },
          include: { user: { include: { store: true } } },
        }));

    // Replay detection: If session doesn't exist or already revoked
    if (!session) {
      throw new UnauthenticatedError('Phiên đăng nhập không tồn tại hoặc token không hợp lệ');
    }

    if (session.revokedAt !== null) {
      // Token reuse / replay attack detected! Revoke all sessions for this user for security
      await this.prisma.authSession.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthenticatedError('Phát hiện token đã qua sử dụng. Toàn bộ phiên đăng nhập đã bị thu hồi vì lý do an toàn');
    }

    if (session.expiresAt < new Date()) {
      await this.prisma.authSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthenticatedError('Phiên đăng nhập đã hết hạn');
    }

    const user = session.user;
    if (!user || !user.isActive || (user.storeId && !user.store?.isActive)) {
      throw new UnauthenticatedError('Tài khoản không tồn tại hoặc đã bị khóa');
    }

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      storeId: user.storeId,
    };

    const newAccessToken = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(tokenPayload);
    const newRefreshTokenHash = hashToken(newRefreshToken);
    const expiresAt = getRefreshTokenExpiry(newRefreshToken);

    // Rotate session race-safely: Atomically revoke old session where revokedAt is null
    const rotation = await this.prisma.$transaction(async (tx) => {
      const revokeResult = await tx.authSession.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      });

      if (revokeResult.count !== 1) {
        // Parallel request already rotated this session!
        // Revoke all remaining active sessions of this user (replay attack detection)
        await tx.authSession.updateMany({
          where: { userId: session.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return { replayDetected: true };
      }

      await tx.authSession.create({
        data: {
          userId: user.id,
          refreshTokenHash: newRefreshTokenHash,
          expiresAt,
          userAgent: meta?.userAgent || session.userAgent,
          ipAddress: meta?.ipAddress || session.ipAddress,
        },
      });

      return { replayDetected: false };
    });

    if (rotation.replayDetected) {
      throw new UnauthenticatedError(
        'Refresh token đã được sử dụng hoặc phiên không còn hợp lệ. Toàn bộ phiên đăng nhập đã bị thu hồi vì lý do an toàn'
      );
    }

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  async logout(userId: number, token?: string) {
    if (token) {
      const tokenHash = hashToken(token);
      await this.prisma.authSession.updateMany({
        where: { userId, refreshTokenHash: tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else {
      // If no token specified, revoke all active sessions for this user
      await this.prisma.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return { success: true };
  }

  async getMe(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        storeId: true,
        store: {
          include: {
            warehouses: true,
          },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthenticatedError('Không tìm thấy thông tin tài khoản');
    }

    return user;
  }

  async updateMe(userId: number, input: z.infer<typeof updateProfileSchema>) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        storeId: true,
        updatedAt: true,
      },
    });

    if (!user.isActive) {
      throw new UnauthenticatedError('Khong tim thay thong tin tai khoan');
    }

    return user;
  }

  private async findActiveUserByEmailOrPhone(email?: string, phone?: string) {
    if (email) {
      return this.prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
        include: { store: true },
      });
    }

    if (phone) {
      const cleaned = phone.replace(/[^\d+]/g, '');
      const rawDigits = cleaned.replace(/\D/g, '');
      const localPhone = rawDigits.startsWith('84') ? '0' + rawDigits.slice(2) : rawDigits;
      const internationalPhone = rawDigits.startsWith('0') ? '84' + rawDigits.slice(1) : rawDigits;

      // Tìm user theo số điện thoại cửa hàng đã đăng ký (hoặc khớp 9 số cuối)
      return this.prisma.user.findFirst({
        where: {
          isActive: true,
          store: {
            isActive: true,
            OR: [
              { phone: phone.trim() },
              { phone: cleaned },
              { phone: localPhone },
              { phone: `+${internationalPhone}` },
              { phone: { contains: localPhone.slice(-9) } },
            ],
          },
        },
        include: { store: true },
      });
    }

    return null;
  }

  async forgotPassword(input: z.infer<typeof forgotPasswordSchema>) {
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const publicResult: { expiresAt: Date; resetToken?: string; otp?: string } = { expiresAt };

    const user = await this.findActiveUserByEmailOrPhone(input.email, input.phone);

    if (!user || !user.isActive || (user.storeId && !user.store?.isActive)) {
      return publicResult;
    }

    // Sinh mã OTP 6 chữ số ngẫu nhiên và token kèm chữ ký HMAC
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const sig = crypto
      .createHmac('sha256', env.JWT_SECRET || 'stockpilot_secret')
      .update(`${user.id}:${otp}:${expiresAt.getTime()}`)
      .digest('hex');
    const rawToken = `${otp}.${sig}`;
    const tokenHash = hashToken(rawToken);

    // Vô hiệu hóa các mã reset trước đó của user này
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    // Lưu đúng 1 token duy nhất cho reset password
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    let sendResult = { sent: false, simulated: false };

    if (input.email) {
      // Gửi email chứa mã OTP về Gmail
      const emailResult = await sendPasswordResetOtpEmail({
        to: user.email,
        name: user.fullName,
        otp,
        expiresMinutes: 15,
      });
      sendResult = { sent: emailResult.sent, simulated: emailResult.simulated || false };
    } else if (input.phone) {
      // Gửi SMS chứa mã OTP đến số điện thoại
      const smsResult = await sendPasswordResetOtpSms({
        phone: input.phone,
        name: user.fullName,
        otp,
        expiresMinutes: 15,
      });
      sendResult = { sent: smsResult.sent, simulated: smsResult.simulated || false };
    }

    if (process.env.NODE_ENV !== 'production') {
      publicResult.resetToken = rawToken;
      publicResult.otp = otp;
    }

    return {
      ...publicResult,
      ...sendResult,
    };
  }

  async verifyOtp(input: z.infer<typeof verifyOtpSchema>) {
    const now = new Date();

    const user = await this.findActiveUserByEmailOrPhone(input.email, input.phone);

    if (!user || !user.isActive || (user.store && !user.store.isActive)) {
      throw new ValidationError('Mã OTP không chính xác hoặc tài khoản không hợp lệ');
    }

    const token = await this.prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      throw new ValidationError('Mã OTP không chính xác hoặc đã hết hạn');
    }

    const otpInput = input.otp.trim();
    const sig = crypto
      .createHmac('sha256', env.JWT_SECRET || 'stockpilot_secret')
      .update(`${user.id}:${otpInput}:${token.expiresAt.getTime()}`)
      .digest('hex');
    const expectedRawToken = `${otpInput}.${sig}`;
    const expectedHash = hashToken(expectedRawToken);
    const legacyOtpHash = hashToken(`${user.id}:otp:${otpInput}`);

    if (token.tokenHash !== expectedHash && token.tokenHash !== legacyOtpHash) {
      throw new ValidationError('Mã OTP không chính xác hoặc đã hết hạn');
    }

    return {
      valid: true,
      resetToken: expectedRawToken,
      email: user.email,
      phone: input.phone,
    };
  }

  async resetPassword(input: z.infer<typeof resetPasswordSchema>) {
    const now = new Date();
    const newPasswordHash = await hashPassword(input.newPassword);

    return this.prisma.$transaction(async (tx) => {
      let targetUserId: number | null = null;
      let targetTokenId: number | null = null;

      if (input.token) {
        const tokenHash = hashToken(input.token);
        const token = await tx.passwordResetToken.findUnique({
          where: { tokenHash },
          include: { user: { include: { store: true } } },
        });

        if (!token || token.usedAt || token.expiresAt <= now || !token.user.isActive || (token.user.storeId && !token.user.store?.isActive)) {
          throw new ValidationError('Reset token khong hop le hoac da het han');
        }

        targetUserId = token.userId;
        targetTokenId = token.id;
      } else if ((input.email || input.phone) && input.otp) {
        const user = await this.findActiveUserByEmailOrPhone(input.email, input.phone);

        if (!user || !user.isActive || (user.storeId && !user.store?.isActive)) {
          throw new ValidationError('Tài khoản không tồn tại hoặc đã bị khóa');
        }

        const activeToken = await tx.passwordResetToken.findFirst({
          where: {
            userId: user.id,
            usedAt: null,
            expiresAt: { gt: now },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (!activeToken) {
          throw new ValidationError('Mã OTP không chính xác hoặc đã hết hạn');
        }

        const otpInput = input.otp.trim();
        const sig = crypto
          .createHmac('sha256', env.JWT_SECRET || 'stockpilot_secret')
          .update(`${user.id}:${otpInput}:${activeToken.expiresAt.getTime()}`)
          .digest('hex');
        const expectedRawToken = `${otpInput}.${sig}`;
        const expectedHash = hashToken(expectedRawToken);
        const legacyOtpHash = hashToken(`${user.id}:otp:${otpInput}`);

        if (activeToken.tokenHash !== expectedHash && activeToken.tokenHash !== legacyOtpHash) {
          throw new ValidationError('Mã OTP không chính xác hoặc đã hết hạn');
        }

        targetUserId = user.id;
        targetTokenId = activeToken.id;
      } else {
        throw new ValidationError('Thiếu thông tin token hoặc OTP để đặt lại mật khẩu');
      }

      const consumeResult = await tx.passwordResetToken.updateMany({
        where: {
          id: targetTokenId,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });

      if (consumeResult.count !== 1) {
        throw new ValidationError('Reset token khong hop le hoac da duoc su dung');
      }

      // Đánh dấu tất cả các token reset còn lại của user này là đã sử dụng
      await tx.passwordResetToken.updateMany({
        where: {
          userId: targetUserId,
          usedAt: null,
        },
        data: { usedAt: now },
      });

      await tx.user.update({
        where: { id: targetUserId },
        data: { passwordHash: newPasswordHash },
      });

      await tx.authSession.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: now },
      });

      const userStore = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { storeId: true },
      });

      await AuditLogService.create(tx, {
        storeId: userStore?.storeId || null,
        userId: targetUserId,
        action: 'PASSWORD_RESET',
        entityType: 'USER',
        entityId: targetUserId,
        afterJson: { sessionsRevoked: true },
      });

      return { success: true };
    });
  }

  async updateStore(userId: number, input: { storeName?: string; phone?: string; address?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { store: true },
    });
    if (!user || !user.storeId) {
      throw new ValidationError('Người dùng chưa liên kết với cửa hàng');
    }

    const updatedStore = await this.prisma.store.update({
      where: { id: user.storeId },
      data: {
        ...(input.storeName ? { name: input.storeName.trim() } : {}),
        ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
        ...(input.address !== undefined ? { address: input.address?.trim() || null } : {}),
      },
    });

    return {
      success: true,
      store: updatedStore,
    };
  }

  async changePassword(userId: number, input: { oldPassword: string; newPassword: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new UnauthenticatedError('Tài khoản không tồn tại');
    }

    const isMatch = await comparePassword(input.oldPassword, user.passwordHash);
    if (!isMatch) {
      throw new ValidationError('Mật khẩu cũ không chính xác');
    }

    if (input.newPassword.length < 8) {
      throw new ValidationError('Mật khẩu mới phải có ít nhất 8 ký tự');
    }

    const newPasswordHash = await hashPassword(input.newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    });

    return { success: true, message: 'Đổi mật khẩu thành công' };
  }
}


