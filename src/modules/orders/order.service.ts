import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createOrderSchema, cancelOrderSchema } from './order.schema';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { BusinessSyncService } from '../../common/services/business-sync.service';

export class OrderService {
  private prisma: PrismaClient;

  constructor(customPrisma?: PrismaClient) {
    this.prisma = customPrisma || defaultPrisma;
  }

  async createDraftOrder(
    storeId: number,
    userId: number,
    input: z.infer<typeof createOrderSchema>,
    clientRequestKey?: string
  ) {
    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    // Normalize and aggregate any duplicate stockItemId entries in input
    const aggregatedItems = StockLedgerService.normalizeItems(input.items);
    const itemIds = aggregatedItems.map((i) => i.stockItemId);

    const stockItems = await this.prisma.stockItem.findMany({
      where: {
        storeId,
        id: { in: itemIds },
        isActive: true,
        product: { isActive: true },
      },
    });

    if (stockItems.length !== itemIds.length) {
      throw new NotFoundError('Một hoặc nhiều sản phẩm trong đơn hàng không tồn tại hoặc đã ngừng kinh doanh');
    }

    const itemMap = new Map(stockItems.map((s) => [s.id, s]));

    let subtotalAmount = new Prisma.Decimal(0);
    const rawLines: {
      stockItem: (typeof stockItems)[0];
      quantity: number;
      unitPrice: Prisma.Decimal;
      costPrice: Prisma.Decimal;
      lineSubtotal: Prisma.Decimal;
    }[] = [];

    for (const item of aggregatedItems) {
      const s = itemMap.get(item.stockItemId)!;
      const unitPrice = new Prisma.Decimal(s.sellingPrice);
      const costPrice = new Prisma.Decimal(s.costPrice);
      const lineSubtotal = unitPrice.mul(item.quantity);
      subtotalAmount = subtotalAmount.plus(lineSubtotal);

      rawLines.push({
        stockItem: s,
        quantity: item.quantity,
        unitPrice,
        costPrice,
        lineSubtotal,
      });
    }

    const discount = new Prisma.Decimal(input.discountAmount || 0);
    const tax = new Prisma.Decimal(input.taxAmount || 0);

    if (discount.gt(subtotalAmount)) {
      throw new ValidationError(`Số tiền chiết khấu (${discount}) không thể vượt quá tổng tiền hàng (${subtotalAmount})`);
    }

    const totalAmount = subtotalAmount.minus(discount).plus(tax);

    // Pro-rata allocate discount & tax across lines to derive exact line-item refundableAmount
    // Invariant: SUM(lineRefundable) == Order.totalAmount
    const orderItemsData: Prisma.OrderItemUncheckedCreateWithoutOrderInput[] = [];
    let allocatedRefundableSum = new Prisma.Decimal(0);

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const isLastLine = i === rawLines.length - 1;

      let lineRefundable: Prisma.Decimal;
      if (isLastLine) {
        // Last line absorbs any rounding remainder
        lineRefundable = totalAmount.minus(allocatedRefundableSum);
      } else {
        if (subtotalAmount.gt(0)) {
          const lineDiscount = discount.mul(line.lineSubtotal).div(subtotalAmount).toDecimalPlaces(2);
          const lineTax = tax.mul(line.lineSubtotal).div(subtotalAmount).toDecimalPlaces(2);
          lineRefundable = line.lineSubtotal.minus(lineDiscount).plus(lineTax).toDecimalPlaces(2);
        } else {
          lineRefundable = new Prisma.Decimal(0);
        }
        allocatedRefundableSum = allocatedRefundableSum.plus(lineRefundable);
      }

      orderItemsData.push({
        storeId,
        stockItemId: line.stockItem.id,
        skuSnapshot: line.stockItem.sku,
        nameSnapshot: line.stockItem.name,
        unitPriceSnapshot: line.unitPrice,
        costPriceSnapshot: line.costPrice,
        quantity: line.quantity,
        returnedQuantity: 0,
        refundableAmount: lineRefundable,
        refundedAmount: new Prisma.Decimal(0),
        subtotal: line.lineSubtotal,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          storeId,
          orderNumber,
          status: 'DRAFT',
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          customerAddress: input.customerAddress,
          subtotalAmount,
          discountAmount: discount,
          taxAmount: tax,
          totalAmount,
          note: input.note,
          clientRequestKey,
          createdById: userId,
          items: {
            create: orderItemsData,
          },
        },
        include: {
          items: true,
        },
      });

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'ORDER_CREATED',
        entityType: 'ORDER',
        entityId: order.id,
        afterJson: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          totalAmount: order.totalAmount,
          itemCount: order.items.length,
        },
      });

      // Tạo thông báo thực tế gửi tới người dùng trong cửa hàng
      const storeUsers = await tx.user.findMany({
        where: { OR: [{ storeId }, { role: 'ADMIN' }], isActive: true },
        select: { id: true },
      });
      if (storeUsers.length > 0) {
        await tx.notification.createMany({
          data: storeUsers.map((u) => ({
            storeId,
            userId: u.id,
            type: 'order',
            title: `Đơn hàng mới: ${order.orderNumber}`,
            message: `Hóa đơn bán lẻ trị giá ${Number(totalAmount).toLocaleString('vi-VN')} đ đã được lập thành công.`,
            entityType: 'ORDER',
            entityId: String(order.id),
            isRead: false,
          })),
        });
      }

      return order;
    });
  }

  async confirmOrder(storeId: number, userId: number, orderId: number) {
    const defaultWarehouse = await this.prisma.warehouse.findFirst({
      where: { storeId, isDefault: true, isActive: true },
    });

    if (!defaultWarehouse) {
      throw new NotFoundError('Không tìm thấy kho hàng mặc định đang hoạt động để xuất đơn');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Atomically guard and advance order status from DRAFT -> CONFIRMED
      const updateOrderGuard = await tx.order.updateMany({
        where: { id: orderId, storeId, status: 'DRAFT' },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
      });

      if (updateOrderGuard.count === 0) {
        const existing = await tx.order.findFirst({ where: { id: orderId, storeId } });
        if (!existing) {
          throw new NotFoundError('Đơn hàng không tồn tại trong cửa hàng');
        }
        throw new ConflictError(
          `Chỉ có thể xác nhận đơn hàng ở trạng thái DRAFT (Trạng thái hiện tại: ${existing.status})`
        );
      }

      // 2. Fetch order items for inventory deduction
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });

      const deductItems = order.items.map((i) => ({
        stockItemId: i.stockItemId,
        quantity: i.quantity,
      }));

      // 3. Atomically deduct inventory with concurrency protection & ledger movements
      const movements = await StockLedgerService.atomicDeduct(
        tx,
        {
          storeId,
          warehouseId: defaultWarehouse.id,
          userId,
          referenceType: 'ORDER',
          referenceId: order.orderNumber,
          idempotencyKey: `ORDER_CONFIRM:${storeId}:${order.id}`,
          note: `Xuất kho xác nhận đơn hàng ${order.orderNumber}`,
        },
        'ORDER_FULFILL',
        deductItems
      );

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'ORDER_CONFIRMED',
        entityType: 'ORDER',
        entityId: order.id,
        beforeJson: { status: 'DRAFT' },
        afterJson: {
          status: 'CONFIRMED',
          orderNumber: order.orderNumber,
          movementIds: movements.map((movement) => movement.id),
        },
      });

      return order;
    }).then((result) => {
      BusinessSyncService.getInstance(this.prisma)
        .syncAfterSale(storeId, result.items.map((i) => i.stockItemId))
        .catch(() => {});
      return result;
    });
  }

  async fulfillOrder(storeId: number, orderId: number, userId?: number) {
    return this.prisma.$transaction(async (tx) => {
      const updateResult = await tx.order.updateMany({
        where: { id: orderId, storeId, status: 'CONFIRMED' },
        data: {
          status: 'FULFILLED',
          fulfilledAt: new Date(),
        },
      });

      if (updateResult.count === 0) {
        const order = await tx.order.findFirst({ where: { id: orderId, storeId } });
        if (!order) throw new NotFoundError('Đơn hàng không tồn tại');
        throw new ConflictError(
          `Chỉ có thể hoàn thành đơn hàng đã xác nhận CONFIRMED (Trạng thái hiện tại: ${order.status})`
        );
      }

      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });

      await AuditLogService.create(tx, {
        storeId,
        userId: userId ?? null,
        action: 'ORDER_FULFILLED',
        entityType: 'ORDER',
        entityId: order.id,
        beforeJson: { status: 'CONFIRMED' },
        afterJson: {
          status: order.status,
          orderNumber: order.orderNumber,
          fulfilledAt: order.fulfilledAt,
        },
      });

      return order;
    }).then((result) => {
      BusinessSyncService.getInstance(this.prisma)
        .syncAfterSale(storeId, result.items.map((i) => i.stockItemId))
        .catch(() => {});
      return result;
    });
  }

  async cancelOrder(
    storeId: number,
    userId: number,
    orderId: number,
    input: z.infer<typeof cancelOrderSchema>,
    userRole?: string
  ) {
    const defaultWarehouse = await this.prisma.warehouse.findFirst({
      where: { storeId, isDefault: true, isActive: true },
    });

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, storeId },
        include: { items: true },
      });

      if (!order) throw new NotFoundError('Đơn hàng không tồn tại');

      // If staff, verify order belongs to today or was created/handled by this staff
      if (userRole === 'WAREHOUSE_STAFF') {
        const now = new Date();
        const vnNow = new Date(now.getTime() + 7 * 3600000);
        const vnYear = vnNow.getUTCFullYear();
        const vnMonth = vnNow.getUTCMonth();
        const vnDate = vnNow.getUTCDate();
        const startOfToday = new Date(Date.UTC(vnYear, vnMonth, vnDate, -7, 0, 0, 0));

        const isToday = order.createdAt >= startOfToday;
        const isCreator = order.createdById === userId;

        if (!isToday && !isCreator) {
          throw new ConflictError('Bạn không có quyền hủy đơn hàng này');
        }
      }

      const lockedOrders = typeof (tx as any).$queryRaw === 'function'
        ? await tx.$queryRaw<Array<{ id: number; status: string }>>`
            SELECT id, status
            FROM orders
            WHERE id = ${orderId}
              AND storeId = ${storeId}
            FOR UPDATE
          `
        : [{ id: order.id, status: order.status }];

      const lockedOrder = lockedOrders[0];

      if (lockedOrder.status === 'FULFILLED') {
        throw new ConflictError(
          'Đơn hàng đã hoàn thành FULFILLED không thể hủy trực tiếp. Vui lòng sử dụng tính năng Trả hàng (Returns)'
        );
      }

      if (lockedOrder.status === 'CANCELED') {
        throw new ConflictError('Đơn hàng đã bị hủy trước đó');
      }

      // Guard transition to CANCELED (only DRAFT and CONFIRMED)
      const updateResult = await tx.order.updateMany({
        where: {
          id: orderId,
          storeId,
          status: { in: ['DRAFT', 'CONFIRMED'] },
        },
        data: {
          status: 'CANCELED',
          canceledAt: new Date(),
          cancelReason: input.cancelReason,
        },
      });

      if (updateResult.count === 0) {
        throw new ConflictError('Không thể chuyển trạng thái đơn hàng sang CANCELED');
      }

      // If order was CONFIRMED, atomically restock items into inventory
      let restockMovements: Array<{ id: number; stockItemId: number; delta: number; beforeQuantity: number; afterQuantity: number }> = [];
      if (lockedOrder.status === 'CONFIRMED') {
        if (!defaultWarehouse) {
          throw new NotFoundError('Không tìm thấy kho mặc định để hoàn trả tồn kho');
        }

        const restockItems = order.items.map((i) => ({
          stockItemId: i.stockItemId,
          quantity: i.quantity,
        }));

        if (restockItems.length > 0) {
          restockMovements = await StockLedgerService.atomicAdd(
            tx,
            {
              storeId,
              warehouseId: defaultWarehouse.id,
              userId,
              referenceType: 'ORDER_CANCEL',
              referenceId: order.orderNumber,
              idempotencyKey: `ORDER_CANCEL:${storeId}:${order.id}`,
              note: `Hoàn kho do khách trả / hủy đơn hàng ${order.orderNumber}. Lý do: ${input.cancelReason}`,
            },
            'ORDER_CANCEL_RESTOCK',
            restockItems
          );
        }
      }

      const canceledOrder = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'ORDER_CANCELED',
        entityType: 'ORDER',
        entityId: order.id,
        beforeJson: { status: lockedOrder.status },
        afterJson: {
          status: canceledOrder.status,
          orderNumber: canceledOrder.orderNumber,
          cancelReason: input.cancelReason,
          restockMovementIds: restockMovements.map((movement) => movement.id),
        },
      });

      return canceledOrder;
    }).then((result) => {
      BusinessSyncService.getInstance(this.prisma)
        .syncAfterCancelOrReturn(storeId, result.items.map((i) => i.stockItemId))
        .catch(() => {});
      return result;
    });
  }

  async listOrders(
    storeId: number,
    status?: string,
    query?: any,
    userRole?: string,
    userId?: number
  ) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const skip = (page - 1) * limit;

    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 3600000);
    const vnYear = vnNow.getUTCFullYear();
    const vnMonth = vnNow.getUTCMonth();
    const vnDate = vnNow.getUTCDate();
    const startOfToday = new Date(Date.UTC(vnYear, vnMonth, vnDate, -7, 0, 0, 0));
    const startOf3Days = new Date(Date.UTC(vnYear, vnMonth, vnDate - 2, -7, 0, 0, 0));
    const startOf7Days = new Date(Date.UTC(vnYear, vnMonth, vnDate - 6, -7, 0, 0, 0));
    const startOf30Days = new Date(Date.UTC(vnYear, vnMonth, vnDate - 29, -7, 0, 0, 0));

    const where: any = {
      storeId,
      ...(status && status !== 'ALL' ? { status: status as any } : {}),
    };

    const andConditions: any[] = [];

    const searchTerm = query?.search || query?.q;
    if (searchTerm && typeof searchTerm === 'string' && searchTerm.trim()) {
      const term = searchTerm.trim();
      andConditions.push({
        OR: [
          { orderNumber: { contains: term } },
          { customerName: { contains: term } },
          { customerPhone: { contains: term } },
          { createdBy: { fullName: { contains: term } } },
        ],
      });
    }

    if (query?.from || query?.to) {
      const dateFilter: any = {};
      if (query.from) {
        dateFilter.gte = new Date(query.from);
      }
      if (query.to) {
        dateFilter.lte = new Date(query.to);
      }
      andConditions.push({ createdAt: dateFilter });
    }

    // Role-based visibility scoping for staff:
    // WAREHOUSE_STAFF can only see:
    // 1. All orders created today (for counter checkout, shift lookups, re-printing invoices, checking transfers)
    // 2. OR orders prior to today where they were the creator/handler (createdById === userId)
    const isStaff = userRole === 'WAREHOUSE_STAFF';
    const staffVisibilityCondition = isStaff && userId
      ? {
          OR: [
            { createdAt: { gte: startOfToday } },
            { createdById: userId },
          ],
        }
      : null;

    if (staffVisibilityCondition) {
      andConditions.push(staffVisibilityCondition);
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const sortField = ['createdAt', 'totalAmount', 'orderNumber'].includes(query?.sort)
      ? query.sort
      : 'createdAt';
    const sortOrder = query?.order === 'asc' ? 'asc' : 'desc';

    const baseStaffFilter = staffVisibilityCondition ? [staffVisibilityCondition] : [];

    const [
      items,
      total,
      activeOrderCount,
      totalRevAgg,
      itemsSoldAgg,
      paymentAggs,
      allCount,
      todayCount,
      threeDaysCount,
      sevenDaysCount,
      thirtyDaysCount,
    ] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          items: true,
          returns: true,
          payments: true,
          createdBy: {
            select: { id: true, fullName: true, email: true },
          },
        },
        orderBy: { [sortField]: sortOrder },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
      this.prisma.order.count({
        where: { ...where, status: { notIn: ['CANCELED'] } },
      }),
      this.prisma.order.aggregate({
        where: { ...where, status: { notIn: ['CANCELED'] } },
        _sum: { totalAmount: true },
      }),
      this.prisma.orderItem.aggregate({
        where: { order: { ...where, status: { notIn: ['CANCELED'] } } },
        _sum: { quantity: true },
      }),
      this.prisma.payment.groupBy({
        by: ['method'],
        where: { order: { ...where, status: { notIn: ['CANCELED'] } } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.order.count({
        where: {
          storeId,
          status: { notIn: ['CANCELED'] },
          ...(baseStaffFilter.length > 0 ? { AND: baseStaffFilter } : {}),
        },
      }),
      this.prisma.order.count({
        where: {
          storeId,
          status: { notIn: ['CANCELED'] },
          createdAt: { gte: startOfToday },
        },
      }),
      this.prisma.order.count({
        where: {
          storeId,
          status: { notIn: ['CANCELED'] },
          createdAt: { gte: startOf3Days },
          ...(baseStaffFilter.length > 0 ? { AND: baseStaffFilter } : {}),
        },
      }),
      this.prisma.order.count({
        where: {
          storeId,
          status: { notIn: ['CANCELED'] },
          createdAt: { gte: startOf7Days },
          ...(baseStaffFilter.length > 0 ? { AND: baseStaffFilter } : {}),
        },
      }),
      this.prisma.order.count({
        where: {
          storeId,
          status: { notIn: ['CANCELED'] },
          createdAt: { gte: startOf30Days },
          ...(baseStaffFilter.length > 0 ? { AND: baseStaffFilter } : {}),
        },
      }),
    ]);

    let cashCount = 0;
    let cashTotal = 0;
    let transferCount = 0;
    let transferTotal = 0;
    let walletCount = 0;
    let walletTotal = 0;

    for (const p of paymentAggs) {
      const m = String(p.method || 'CASH').toUpperCase();
      const count = p._count?._all || 0;
      const amt = Number(p._sum?.amount || 0);
      if (m === 'BANK_TRANSFER') {
        transferCount += count;
        transferTotal += amt;
      } else if (m === 'PAYOS' || m === 'WALLET') {
        walletCount += count;
        walletTotal += amt;
      } else {
        cashCount += count;
        cashTotal += amt;
      }
    }

    const metrics = {
      totalRevenue: Number(totalRevAgg._sum?.totalAmount || 0),
      orderCount: activeOrderCount,
      totalSoldQuantity: Number(itemsSoldAgg._sum?.quantity || 0),
      cashCount,
      cashTotal,
      transferCount,
      transferTotal,
      walletCount,
      walletTotal,
      customerCount: activeOrderCount,
      draftCount: 0,
      confirmedCount: 0,
      fulfilledCount: activeOrderCount,
      canceledCount: 0,
    };

    const timeframeCounts = {
      all: allCount,
      today: todayCount,
      threeDays: threeDaysCount,
      sevenDays: sevenDaysCount,
      thirtyDays: thirtyDaysCount,
    };

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
      metrics,
      timeframeCounts,
    };
  }

  async getOrderById(storeId: number, id: number, userRole?: string, userId?: number) {
    const order = await this.prisma.order.findFirst({
      where: { id, storeId },
      include: {
        items: true,
        createdBy: {
          select: { id: true, fullName: true, email: true },
        },
        returns: {
          include: {
            items: true,
          },
        },
        payments: true,
      },
    });

    if (!order) throw new NotFoundError('Đơn hàng không tồn tại');

    // Role-based visibility check for WAREHOUSE_STAFF
    if (userRole === 'WAREHOUSE_STAFF' && userId) {
      const now = new Date();
      const vnNow = new Date(now.getTime() + 7 * 3600000);
      const vnYear = vnNow.getUTCFullYear();
      const vnMonth = vnNow.getUTCMonth();
      const vnDate = vnNow.getUTCDate();
      const startOfToday = new Date(Date.UTC(vnYear, vnMonth, vnDate, -7, 0, 0, 0));

      const isToday = order.createdAt >= startOfToday;
      const isCreator = order.createdById === userId;

      if (!isToday && !isCreator) {
        throw new NotFoundError('Đơn hàng không tồn tại hoặc bạn không có quyền xem đơn hàng này');
      }
    }

    return order;
  }
}

