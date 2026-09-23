import { prisma } from '../../config/db';
import { hashPassword, comparePassword } from '../../common/utils/password';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../../common/utils/jwt';
import { ConflictError, UnauthenticatedError } from '../../common/errors/app-error';
import { z } from 'zod';
import { registerSchema, loginSchema } from './auth.schema';

export class AuthService {
  async registerOwner(input: z.infer<typeof registerSchema>) {
    const existingUser = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase().trim() },
    });

    if (existingUser) {
      throw new ConflictError('Email này đã được sử dụng trong hệ thống');
    }

    const existingStore = await prisma.store.findUnique({
      where: { code: input.storeCode.toUpperCase().trim() },
    });

    if (existingStore) {
      throw new ConflictError('Mã cửa hàng (Store Code) đã tồn tại');
    }

    const passwordHash = await hashPassword(input.password);

    // Atomic Transaction: Create Store + Default Warehouse + Owner User
    const result = await prisma.$transaction(async (tx) => {
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

      return { user, store, defaultWarehouse };
    });

    const tokenPayload = {
      userId: result.user.id,
      email: result.user.email,
      role: result.user.role,
      storeId: result.user.storeId,
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        fullName: result.user.fullName,
        role: result.user.role,
        storeId: result.user.storeId,
      },
      store: result.store,
      warehouse: result.defaultWarehouse,
      tokens: {
        accessToken,
        refreshToken,
      },
    };
  }

  async login(input: z.infer<typeof loginSchema>) {
    const user = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase().trim() },
      include: {
        store: true,
      },
    });

    if (!user || !user.isActive) {
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

  async refreshToken(token: string) {
    try {
      const payload = verifyRefreshToken(token);
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
      });

      if (!user || !user.isActive) {
        throw new UnauthenticatedError('Tài khoản không tồn tại hoặc đã bị khóa');
      }

      const tokenPayload = {
        userId: user.id,
        email: user.email,
        role: user.role,
        storeId: user.storeId,
      };

      return {
        accessToken: generateAccessToken(tokenPayload),
        refreshToken: generateRefreshToken(tokenPayload),
      };
    } catch {
      throw new UnauthenticatedError('Refresh token không hợp lệ hoặc đã hết hạn');
    }
  }

  async getMe(userId: number) {
    const user = await prisma.user.findUnique({
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

    if (!user) {
      throw new UnauthenticatedError('Không tìm thấy thông tin tài khoản');
    }

    return user;
  }
}
