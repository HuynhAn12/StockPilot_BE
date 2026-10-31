import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError } from '../../common/errors/app-error';
import { NotificationListQuery } from './notification.schema';

export interface NotificationViewerOptions {
  /** D9: pricing recommendation notifications are owner-only. Defaults to true for backward compatibility. */
  includePricing?: boolean;
}

export class NotificationService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async syncRealNotifications(storeId: number, userId: number, options: NotificationViewerOptions = {}) {
    const includePricing = options.includePricing !== false;
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    try {
      // 1. Đồng bộ cảnh báo rủi ro thực tế (Alerts)
      const activeAlerts = await this.prisma.alert.findMany({
        where: { storeId, status: 'OPEN' },
        orderBy: { riskScore: 'desc' },
        take: 8,
        include: { stockItem: { include: { product: true } } },
      });

      for (const alert of activeAlerts) {
        const existing = await this.prisma.notification.findFirst({
          where: { storeId, userId, entityType: 'ALERT', entityId: String(alert.id) },
        });

        if (!existing) {
          await this.prisma.notification.create({
            data: {
              storeId,
              userId,
              type: 'alert',
              title: alert.title,
              message: alert.message,
              entityType: 'ALERT',
              entityId: String(alert.id),
              isRead: false,
              createdAt: alert.openedAt || alert.createdAt,
            },
          });
        }
      }

      // 2. Đồng bộ đề xuất giá AI thực tế (Pricing Recommendations) - chỉ dành cho Chủ cửa hàng (D9)
      const pendingPricing = includePricing
        ? await this.prisma.pricingRecommendation.findMany({
            where: { storeId, status: 'PENDING' },
            orderBy: { id: 'asc' },
            take: 4,
            include: { stockItem: { include: { product: true } } },
          })
        : [];

      for (const rec of pendingPricing) {
        const existing = await this.prisma.notification.findFirst({
          where: { storeId, userId, entityType: 'PRICING', entityId: String(rec.id) },
        });

        if (!existing) {
          const prodName = rec.stockItem?.product?.name || `Sản phẩm SP${rec.stockItemId}`;
          const currentFmt = Number(rec.currentPrice).toLocaleString('vi-VN') + ' đ';
          const recFmt = Number(rec.recommendedPrice).toLocaleString('vi-VN') + ' đ';
          const actionText = rec.action === 'INCREASE' ? 'Đề xuất tăng giá' : rec.action === 'DECREASE' ? 'Đề xuất giảm giá' : 'Gợi ý giá mới';

          await this.prisma.notification.create({
            data: {
              storeId,
              userId,
              type: 'pricing',
              title: `${actionText}: ${prodName}`,
              message: `AI đề xuất điều chỉnh giá từ ${currentFmt} lên ${recFmt} để bảo toàn biên lợi nhuận mục tiêu.`,
              entityType: 'PRICING',
              entityId: String(rec.id),
              isRead: false,
              createdAt: rec.createdAt,
            },
          });
        }
      }

      // 3. Đồng bộ hóa đơn bán lẻ gần đây (Orders)
      const recentOrders = await this.prisma.order.findMany({
        where: { storeId },
        orderBy: { createdAt: 'desc' },
        take: 4,
      });

      for (const order of recentOrders) {
        const existing = await this.prisma.notification.findFirst({
          where: { storeId, userId, entityType: 'ORDER', entityId: String(order.id) },
        });

        if (!existing) {
          const totalFmt = Number(order.totalAmount).toLocaleString('vi-VN') + ' đ';
          await this.prisma.notification.create({
            data: {
              storeId,
              userId,
              type: 'order',
              title: `Đơn hàng mới: ${order.orderNumber}`,
              message: `Hóa đơn bán lẻ trị giá ${totalFmt} đã được thanh toán thành công lúc ${new Date(order.createdAt).toLocaleTimeString('vi-VN')}.`,
              entityType: 'ORDER',
              entityId: String(order.id),
              isRead: false,
              createdAt: order.createdAt,
            },
          });
        }
      }

      // 4. Thông báo đồng bộ hệ thống thực tế
      const sysSync = await this.prisma.notification.findFirst({
        where: { storeId, userId, entityType: 'SYSTEM' },
      });
      if (!sysSync) {
        await this.prisma.notification.create({
          data: {
            storeId,
            userId,
            type: 'system',
            title: 'Hệ thống đồng bộ thành công',
            message: 'Dữ liệu tồn kho và số liệu kinh doanh đã được đồng bộ với máy chủ.',
            entityType: 'SYSTEM',
            entityId: 'sync-ready',
            isRead: true,
            createdAt: new Date(Date.now() - 30 * 60 * 1000),
          },
        });
      }
    } catch (err) {
      console.error('Error in syncRealNotifications:', err);
    }
  }

  async list(storeId: number, userId: number, query: NotificationListQuery, options: NotificationViewerOptions = {}) {
    const includePricing = options.includePricing !== false;

    // Tự động đồng bộ các sự kiện thực tế trong kho và cửa hàng (bỏ qua khi chạy test)
    if (process.env.NODE_ENV !== 'test') {
      await this.syncRealNotifications(storeId, userId, { includePricing });
    }

    const page = query.page || 1;
    const limit = query.limit || 20;
    const where: Prisma.NotificationWhereInput = {
      storeId,
      userId,
      ...(query.isRead !== undefined ? { isRead: query.isRead } : {}),
      // Hide pricing rows created for non-owners before the D9 fix; NULL entityType rows stay visible.
      ...(includePricing ? {} : { OR: [{ entityType: null }, { entityType: { not: 'PRICING' } }] }),
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
