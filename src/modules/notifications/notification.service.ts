import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError } from '../../common/errors/app-error';
import { NotificationListQuery } from './notification.schema';

export class NotificationService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async list(storeId: number, userId: number, query: NotificationListQuery) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const where: Prisma.NotificationWhereInput = {
      storeId,
      userId,
      ...(query.isRead !== undefined ? { isRead: query.isRead } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
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

  async markRead(storeId: number, userId: number, id: number) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, storeId, userId },
    });

    if (!notification) {
      throw new NotFoundError('Notification not found');
    }

    if (notification.isRead) {
      return notification;
    }

    const now = new Date();
    await this.prisma.notification.updateMany({
      where: { id, storeId, userId, isRead: false },
      data: {
        isRead: true,
        readAt: now,
      },
    });

    return this.prisma.notification.findFirstOrThrow({
      where: { id, storeId, userId },
    });
  }

  async markAllRead(storeId: number, userId: number) {
    const result = await this.prisma.notification.updateMany({
      where: {
        storeId,
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return { updatedCount: result.count };
  }
}
