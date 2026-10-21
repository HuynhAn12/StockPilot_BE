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
    const limit = Number(query?.limit) || 50;
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

    const userIds = items.map((u) => u.id);
    const statsMap = new Map<number, { completedOrdersCount: number; totalAmountPaid: number }>();

    if (userIds.length > 0) {
      try {
        const orderStats = await prisma.order.groupBy({
          by: ['createdById'],
          where: {
            storeId,
            createdById: { in: userIds },
            status: { in: ['CONFIRMED', 'FULFILLED'] },
          },
          _count: {
            id: true,
          },
          _sum: {
            totalAmount: true,
          },
        });

        for (const stat of orderStats) {
          if (stat.createdById !== null && stat.createdById !== undefined) {
            statsMap.set(stat.createdById, {
              completedOrdersCount: stat._count.id || 0,
              totalAmountPaid: Number(stat._sum.totalAmount || 0),
            });
          }
        }
      } catch (err) {
        console.error('Failed to aggregate user order stats:', err);
      }
    }

    const itemsWithStats = items.map((u) => {
      const stats = statsMap.get(u.id) || { completedOrdersCount: 0, totalAmountPaid: 0 };
      return {
        ...u,
        completedOrdersCount: stats.completedOrdersCount,
        totalAmountPaid: stats.totalAmountPaid,
      };
    });

    return {
      items: itemsWithStats,
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

    if (existing.role === 'SHOP_OWNER' && input.isActive === false) {
      throw new ForbiddenError('Không thể khóa tài khoản Chủ cửa hàng (SHOP_OWNER)');
    }

    if (input.email && input.email.toLowerCase().trim() !== existing.email.toLowerCase()) {
      const emailConflict = await prisma.user.findUnique({
        where: { email: input.email.toLowerCase().trim() },
      });
      if (emailConflict) {
        throw new ConflictError('Email này đã được sử dụng bởi người dùng khác');
      }
    }

    const passwordHash = input.password ? await hashPassword(input.password) : undefined;

    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: staffId },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
          ...(input.email !== undefined ? { email: input.email.toLowerCase().trim() } : {}),
          ...(passwordHash !== undefined ? { passwordHash } : {}),
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

      if ((input.isActive === false && existing.isActive) || passwordHash) {
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

  async deleteStaff(storeId: number, staffId: number, actorUserId?: number) {
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
      throw new NotFoundError('Không tìm thấy nhân viên trong cửa hàng');
    }

    if (existing.role !== 'WAREHOUSE_STAFF') {
      throw new ForbiddenError('Chỉ có thể xóa tài khoản nhân viên (WAREHOUSE_STAFF)');
    }

    if (actorUserId && actorUserId === staffId) {
      throw new ForbiddenError('Không thể tự xóa chính mình');
    }

    return prisma.$transaction(async (tx) => {
      // First revoke any active sessions
      await tx.authSession.deleteMany({
        where: { userId: staffId },
      });

      // Delete password reset tokens
      await tx.passwordResetToken.deleteMany({
        where: { userId: staffId },
      });

      // Delete user notifications
      await tx.notification.deleteMany({
        where: { userId: staffId },
      });

      // Delete user
      await tx.user.delete({
        where: { id: staffId },
      });

      await AuditLogService.create(tx, {
        storeId,
        userId: actorUserId ?? null,
        action: 'USER_DELETED',
        entityType: 'USER',
        entityId: staffId,
        beforeJson: {
          userId: existing.id,
          fullName: existing.fullName,
          role: existing.role,
          email: existing.email,
          storeId: existing.storeId,
        },
      });

      return { success: true, message: 'Đã xóa nhân viên thành công' };
    });
  }
}

