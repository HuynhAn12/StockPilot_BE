import { prisma } from '../../config/db';
import { hashPassword } from '../../common/utils/password';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createStaffSchema } from './user.schema';

export class UserService {
  async createStaff(storeId: number, input: z.infer<typeof createStaffSchema>) {
    const existingUser = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase().trim() },
    });

    if (existingUser) {
      throw new ConflictError('Email này đã được sử dụng trong hệ thống');
    }

    const passwordHash = await hashPassword(input.password);

    const user = await prisma.user.create({
      data: {
        email: input.email.toLowerCase().trim(),
        passwordHash,
        fullName: input.fullName.trim(),
        role: 'WAREHOUSE_STAFF',
        storeId,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        storeId: true,
        createdAt: true,
      },
    });

    return user;
  }

  async listStoreUsers(storeId: number, query?: any) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where: { storeId },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: { createdAt: (query?.order as any) || 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count({ where: { storeId } }),
    ]);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }
}
