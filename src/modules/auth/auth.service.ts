import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { hashPassword, comparePassword } from '../../common/utils/password';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  hashToken,
  getRefreshTokenExpiry,
} from '../../common/utils/jwt';
import { ConflictError, UnauthenticatedError } from '../../common/errors/app-error';
import { z } from 'zod';
import { registerSchema, loginSchema } from './auth.schema';

export class AuthService {
  private prisma: PrismaClient;

  constructor(customPrisma?: PrismaClient) {
    this.prisma = customPrisma || defaultPrisma;
  }

  async registerOwner(input: z.infer<typeof registerSchema>, meta?: { userAgent?: string; ipAddress?: string }) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase().trim() },
    });

    if (existingUser) {
      throw new ConflictError('Email này đã được sử dụng trong hệ thống');
    }

    const existingStore = await this.prisma.store.findUnique({
      where: { code: input.storeCode.toUpperCase().trim() },
    });

    if (existingStore) {
      throw new ConflictError('Mã cửa hàng (Store Code) đã tồn tại');
    }

    const passwordHash = await hashPassword(input.password);

    // Atomic Transaction: Create Store + Default Warehouse + Owner User + Initial AuthSession
    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.create({
        data: {
          name: input.storeName.trim(),
          code: input.storeCode.toUpperCase().trim(),
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

  async login(input: z.infer<typeof loginSchema>, meta?: { userAgent?: string; ipAddress?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase().trim() },
      include: {
        store: true,
      },
    });

    if (!user || !user.isActive || (user.storeId && !user.store?.isActive)) {
      throw new UnauthenticatedError('Tài khoản hoặc mật khẩu không chính xác');
    }

    const isMatch = await comparePassword(input.password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthenticatedError('Tài khoản hoặc mật khẩu không chính xác');
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
    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      throw new UnauthenticatedError('Refresh token không hợp lệ hoặc đã hết hạn');
    }

    const tokenHash = hashToken(token);
    const session = await this.prisma.authSession.findFirst({
      where: { refreshTokenHash: tokenHash },
      include: { user: { include: { store: true } } },
    });

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
    await this.prisma.$transaction(async (tx) => {
      const revokeResult = await tx.authSession.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      });

      if (revokeResult.count !== 1) {
        // Replay attack / concurrent reused token detected! Revoke all sessions for this user
        await tx.authSession.updateMany({
          where: { userId: session.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        throw new UnauthenticatedError(
          'Refresh token đã được sử dụng hoặc phiên không còn hợp lệ. Toàn bộ phiên đăng nhập đã bị thu hồi vì lý do an toàn'
        );
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
    });

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
}

