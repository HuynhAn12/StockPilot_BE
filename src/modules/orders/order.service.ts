import { prisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createOrderSchema, cancelOrderSchema } from './order.schema';
import { toDecimal, toNumber } from '../../common/utils/decimal';
import { StockLedgerService } from '../inventory/stock-ledger.service';

export class OrderService {
  async createDraftOrder(storeId: number, userId: number, input: z.infer<typeof createOrderSchema>) {
    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    // Normalize and aggregate any duplicate stockItemId entries in input
    const aggregatedItems = StockLedgerService.normalizeItems(input.items);
    const itemIds = aggregatedItems.map((i) => i.stockItemId);

    const stockItems = await prisma.stockItem.findMany({
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

    let subtotalAmount = 0;
    const orderItemsData = [];

    for (const item of aggregatedItems) {
      const s = itemMap.get(item.stockItemId)!;
      const unitPrice = toNumber(s.sellingPrice);
      const costPrice = toNumber(s.costPrice);
      const lineSubtotal = unitPrice * item.quantity;
      subtotalAmount += lineSubtotal;

      orderItemsData.push({
        storeId,
        stockItemId: s.id,
        skuSnapshot: s.sku,
        nameSnapshot: s.name,
        unitPriceSnapshot: toDecimal(unitPrice),
        costPriceSnapshot: toDecimal(costPrice),
        quantity: item.quantity,
        subtotal: toDecimal(lineSubtotal),
      });
    }

    const discount = input.discountAmount || 0;
    const tax = input.taxAmount || 0;

    if (discount > subtotalAmount) {
      throw new ValidationError(`Số tiền chiết khấu (${discount}) không thể vượt quá tổng tiền hàng (${subtotalAmount})`);
    }

    const totalAmount = Math.max(0, subtotalAmount - discount + tax);

    return prisma.order.create({
      data: {
        storeId,
        orderNumber,
        status: 'DRAFT',
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        customerAddress: input.customerAddress,
        subtotalAmount: toDecimal(subtotalAmount),
        discountAmount: toDecimal(discount),
        taxAmount: toDecimal(tax),
        totalAmount: toDecimal(totalAmount),
        note: input.note,
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
    const defaultWarehouse = await prisma.warehouse.findFirst({
      where: { storeId, isDefault: true, isActive: true },
    });

    if (!defaultWarehouse) {
      throw new NotFoundError('Không tìm thấy kho hàng mặc định đang hoạt động để xuất đơn');
    }

    return prisma.$transaction(async (tx) => {
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
          note: `Xuất kho xác nhận đơn hàng ${order.orderNumber}`,
        },
        'ORDER_FULFILL',
        deductItems
      );

      return order;
    });
  }

  async fulfillOrder(storeId: number, orderId: number) {
    return prisma.$transaction(async (tx) => {
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
    const defaultWarehouse = await prisma.warehouse.findFirst({
      where: { storeId, isDefault: true, isActive: true },
    });

    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, storeId },
        include: { items: true },
      });

      if (!order) throw new NotFoundError('Đơn hàng không tồn tại');

      if (order.status === 'FULFILLED') {
        throw new ConflictError(
          'Đơn hàng đã hoàn thành FULFILLED không thể hủy trực tiếp. Vui lòng sử dụng tính năng Trả hàng (Returns)'
        );
      }

      if (order.status === 'CANCELED') {
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
      if (order.status === 'CONFIRMED') {
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

  async listOrders(storeId: number, status?: string) {
    return prisma.order.findMany({
      where: {
        storeId,
        ...(status ? { status: status as any } : {}),
      },
      include: {
        items: true,
        returns: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOrderById(storeId: number, id: number) {
    const order = await prisma.order.findFirst({
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
