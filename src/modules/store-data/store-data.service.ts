import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError } from '../../common/errors/app-error';
import { AuditLogService } from '../../common/services/audit-log.service';

/** Per-table cap so one export cannot exhaust server memory; `truncated` tells the owner if hit. */
export const STORE_EXPORT_ROW_LIMIT = 50000;

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * C2 (phần an toàn) — the shop owner downloads a copy of their own store's data (Nghị định 13/2023:
 * quyền truy cập/nhận bản sao dữ liệu). Read-only; nothing is deleted or anonymised.
 *
 * Every query is scoped by `storeId` from the authenticated user (never from the request).
 * Excluded on purpose: password hashes, sessions/refresh tokens, payment gateway credentials
 * (StorePaymentConfig), payment provider metadata, AI conversation text, internal job/lease rows.
 */
export class StoreDataService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async exportStore(storeId: number, actorUserId: number, meta: RequestMeta = {}) {
    const take = STORE_EXPORT_ROW_LIMIT + 1;

    const store = await this.prisma.store.findFirst({
      where: { id: storeId },
      select: { id: true, name: true, code: true, phone: true, address: true, createdAt: true },
    });
    if (!store) throw new NotFoundError('Không tìm thấy cửa hàng');

    const [users, warehouses, categories, products, stockItems, balances, movements, orders, returns, payments] = await Promise.all([
      this.prisma.user.findMany({
        where: { storeId },
        select: { id: true, fullName: true, email: true, role: true, isActive: true, createdAt: true },
        orderBy: { id: 'asc' },
        take,
      }),
      this.prisma.warehouse.findMany({ where: { storeId }, orderBy: { id: 'asc' }, take }),
      this.prisma.category.findMany({ where: { storeId }, orderBy: { id: 'asc' }, take }),
      this.prisma.product.findMany({ where: { storeId }, orderBy: { id: 'asc' }, take }),
      this.prisma.stockItem.findMany({ where: { storeId }, orderBy: { id: 'asc' }, take }),
      this.prisma.inventoryBalance.findMany({ where: { storeId }, orderBy: { id: 'asc' }, take }),
      this.prisma.stockMovement.findMany({ where: { storeId }, orderBy: { id: 'desc' }, take }),
      this.prisma.order.findMany({
        where: { storeId },
        orderBy: { id: 'desc' },
        take,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          customerName: true,
          customerPhone: true,
          customerAddress: true,
          subtotalAmount: true,
          discountAmount: true,
          taxAmount: true,
          totalAmount: true,
          note: true,
          confirmedAt: true,
          fulfilledAt: true,
          canceledAt: true,
          cancelReason: true,
          createdById: true,
          createdAt: true,
          items: {
            select: {
              id: true,
              stockItemId: true,
              skuSnapshot: true,
              nameSnapshot: true,
              unitPriceSnapshot: true,
              costPriceSnapshot: true,
              quantity: true,
              returnedQuantity: true,
              subtotal: true,
            },
          },
        },
      }),
      this.prisma.returnOrder.findMany({
        where: { storeId },
        orderBy: { id: 'desc' },
        take,
        include: { items: true },
      }),
      this.prisma.payment.findMany({
        where: { storeId },
        orderBy: { id: 'desc' },
        take,
        select: { id: true, orderId: true, provider: true, method: true, amount: true, currency: true, status: true, paidAt: true, createdAt: true },
      }),
    ]);

    const tables = { users, warehouses, categories, products, stockItems, inventoryBalances: balances, stockMovements: movements, orders, returnOrders: returns, payments };
    const counts: Record<string, number> = {};
    const truncated: string[] = [];
    const data: Record<string, unknown[]> = {};
    for (const [name, rows] of Object.entries(tables)) {
      const list = rows as unknown[];
      if (list.length > STORE_EXPORT_ROW_LIMIT) truncated.push(name);
      data[name] = list.slice(0, STORE_EXPORT_ROW_LIMIT);
      counts[name] = (data[name] as unknown[]).length;
    }

    await AuditLogService.create(this.prisma, {
      storeId,
      userId: actorUserId,
      action: 'STORE_DATA_EXPORTED',
      entityType: 'STORE',
      entityId: storeId,
      afterJson: { counts, truncated },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      rowLimitPerTable: STORE_EXPORT_ROW_LIMIT,
      truncated,
      counts,
      store,
      ...data,
    };
  }
}
