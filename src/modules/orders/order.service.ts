import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createOrderSchema, cancelOrderSchema } from './order.schema';
import { StockLedgerService } from '../inventory/stock-ledger.service';

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
    const orderItemsData = [];
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

    return this.prisma.order.create({
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
      await StockLedgerService.atomicDeduct(
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

      return order;
    });
  }

  async fulfillOrder(storeId: number, orderId: number) {
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

      return tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });
    });
  }

  async cancelOrder(storeId: number, userId: number, orderId: number, input: z.infer<typeof cancelOrderSchema>) {
    const defaultWarehouse = await this.prisma.warehouse.findFirst({
      where: { storeId, isDefault: true, isActive: true },
    });

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, storeId },
        include: { items: true },
      });

      if (!order) throw new NotFoundError('Đơn hàng không tồn tại');

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

      // Guard transition to CANCELED
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
      if (lockedOrder.status === 'CONFIRMED') {
        if (!defaultWarehouse) {
          throw new NotFoundError('Không tìm thấy kho mặc định để hoàn trả tồn kho');
        }

        const restockItems = order.items.map((i) => ({
          stockItemId: i.stockItemId,
          quantity: i.quantity,
        }));

        await StockLedgerService.atomicAdd(
          tx,
          {
            storeId,
            warehouseId: defaultWarehouse.id,
            userId,
            referenceType: 'ORDER_CANCEL',
            referenceId: order.orderNumber,
            idempotencyKey: `ORDER_CANCEL:${storeId}:${order.id}`,
            note: `Hoàn kho do hủy đơn hàng ${order.orderNumber}. Lý do: ${input.cancelReason}`,
          },
          'ORDER_CANCEL_RESTOCK',
          restockItems
        );
      }

      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });
    });
  }

  async listOrders(storeId: number, status?: string, query?: any) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = {
      storeId,
      ...(status ? { status: status as any } : {}),
    };

    if (query?.from || query?.to) {
      where.createdAt = {};
      if (query.from) {
        where.createdAt.gte = new Date(query.from);
      }
      if (query.to) {
        where.createdAt.lte = new Date(query.to);
      }
    }

    const sortField = ['createdAt', 'totalAmount', 'orderNumber'].includes(query?.sort)
      ? query.sort
      : 'createdAt';
    const sortOrder = query?.order === 'asc' ? 'asc' : 'desc';

    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          items: true,
          returns: true,
        },
        orderBy: { [sortField]: sortOrder },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
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

  async getOrderById(storeId: number, id: number) {
    const order = await this.prisma.order.findFirst({
      where: { id, storeId },
      include: {
        items: true,
        returns: {
          include: {
            items: true,
          },
        },
      },
    });

    if (!order) throw new NotFoundError('Đơn hàng không tồn tại');
    return order;
  }
}

