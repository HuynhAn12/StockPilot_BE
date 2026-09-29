import { prisma } from '../../config/db';
import { hashPassword } from '../../common/utils/password';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createStaffSchema, updateStaffSchema } from './user.schema';
import { AuditLogService } from '../../common/services/audit-log.service';

export class UserService {
  async createStaff(storeId: number, input: z.infer<typeof createStaffSchema>, actorUserId?: number) {
    const existingUser = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase().trim() },
    });

    if (existingUser) {
      throw new ConflictError('Email này đã được sử dụng trong hệ thống');
    }

    const passwordHash = await hashPassword(input.password);

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
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

      await AuditLogService.create(tx, {
        storeId,
        userId: actorUserId ?? null,
        action: 'USER_CREATED',
        entityType: 'USER',
        entityId: created.id,
        afterJson: {
          userId: created.id,
          role: created.role,
          isActive: created.isActive,
          storeId: created.storeId,
        },
      });

      return created;
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

  async updateStaff(storeId: number, staffId: number, input: z.infer<typeof updateStaffSchema>, actorUserId?: number) {
    const existing = await prisma.user.findFirst({
      where: { id: staffId, storeId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        storeId: true,
      },
    });

    if (!existing) {
      throw new NotFoundError('Khong tim thay nhan vien trong cua hang');
    }

    if (existing.role !== 'WAREHOUSE_STAFF') {
      throw new ForbiddenError('Chi co the cap nhat tai khoan WAREHOUSE_STAFF qua API nhan vien');
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: staffId },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
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

      if (input.isActive === false && existing.isActive) {
        await tx.authSession.updateMany({
          where: { userId: staffId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      await AuditLogService.create(tx, {
        storeId,
        userId: actorUserId ?? null,
        action: input.isActive === false && existing.isActive ? 'USER_DISABLED' : 'USER_UPDATED',
        entityType: 'USER',
        entityId: staffId,
        beforeJson: {
          userId: existing.id,
          fullName: existing.fullName,
          role: existing.role,
          isActive: existing.isActive,
          storeId: existing.storeId,
        },
        afterJson: {
          userId: updated.id,
          fullName: updated.fullName,
          role: updated.role,
          isActive: updated.isActive,
          storeId: updated.storeId,
        },
      });

      return updated;
    });
  }
}
