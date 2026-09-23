import { prisma } from '../../config/db';
import { ConflictError, InsufficientStockError, NotFoundError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createOrderSchema, cancelOrderSchema } from './order.schema';
import { toDecimal, toNumber } from '../../common/utils/decimal';

export class OrderService {
  async createDraftOrder(storeId: number, userId: number, input: z.infer<typeof createOrderSchema>) {
    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const itemIds = input.items.map((i) => i.stockItemId);
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

    for (const item of input.items) {
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
      where: { storeId, isDefault: true },
    });

    if (!defaultWarehouse) {
      throw new NotFoundError('Không tìm thấy kho hàng mặc định để xuất đơn');
    }

    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, storeId },
        include: { items: true },
      });

      if (!order) {
        throw new NotFoundError('Đơn hàng không tồn tại');
      }

      if (order.status !== 'DRAFT') {
        throw new ConflictError(`Chỉ có thể xác nhận đơn hàng ở trạng thái DRAFT (Trạng thái hiện tại: ${order.status})`);
      }

      const sortedItems = [...order.items].sort((a, b) => a.stockItemId - b.stockItemId);

      for (const item of sortedItems) {
        const balance = await tx.inventoryBalance.findUnique({
          where: {
            warehouseId_stockItemId: {
              warehouseId: defaultWarehouse.id,
              stockItemId: item.stockItemId,
            },
          },
        });

        const currentQty = balance ? balance.quantity : 0;

        if (currentQty < item.quantity) {
          throw new InsufficientStockError(
            `Không đủ tồn kho để xác nhận đơn. SKU ${item.skuSnapshot}: hiện có ${currentQty}, cần ${item.quantity}`
          );
        }

        const afterQty = currentQty - item.quantity;

        await tx.inventoryBalance.update({
          where: { id: balance!.id },
          data: { quantity: afterQty },
        });

        await tx.stockMovement.create({
          data: {
            storeId,
            warehouseId: defaultWarehouse.id,
            stockItemId: item.stockItemId,
            type: 'ORDER_FULFILL',
            delta: -item.quantity,
            beforeQuantity: currentQty,
            afterQuantity: afterQty,
            referenceType: 'ORDER',
            referenceId: order.orderNumber,
            note: `Xuất kho cho đơn hàng ${order.orderNumber}`,
            createdById: userId,
          },
        });
      }

      return tx.order.update({
        where: { id: order.id },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
        include: {
          items: true,
        },
      });
    });
  }

  async fulfillOrder(storeId: number, orderId: number) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
    });

    if (!order) throw new NotFoundError('Đơn hàng không tồn tại');
    if (order.status !== 'CONFIRMED') {
      throw new ConflictError(`Chỉ có thể hoàn thành đơn hàng đã xác nhận CONFIRMED (Trạng thái hiện tại: ${order.status})`);
    }

    return prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'FULFILLED',
        fulfilledAt: new Date(),
      },
      include: {
        items: true,
      },
    });
  }

  async cancelOrder(storeId: number, userId: number, orderId: number, input: z.infer<typeof cancelOrderSchema>) {
    const defaultWarehouse = await prisma.warehouse.findFirst({
      where: { storeId, isDefault: true },
    });

    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, storeId },
        include: { items: true },
      });

      if (!order) throw new NotFoundError('Đơn hàng không tồn tại');

      if (order.status === 'FULFILLED') {
        throw new ConflictError('Đơn hàng đã hoàn thành FULFILLED không thể hủy trực tiếp. Vui lòng sử dụng tính năng Trả hàng (Returns)');
      }

      if (order.status === 'CANCELED') {
        throw new ConflictError('Đơn hàng đã bị hủy trước đó');
      }

      if (order.status === 'CONFIRMED' && defaultWarehouse) {
        const sortedItems = [...order.items].sort((a, b) => a.stockItemId - b.stockItemId);

        for (const item of sortedItems) {
          const balance = await tx.inventoryBalance.findUnique({
            where: {
              warehouseId_stockItemId: {
                warehouseId: defaultWarehouse.id,
                stockItemId: item.stockItemId,
              },
            },
          });

          const beforeQty = balance ? balance.quantity : 0;
          const afterQty = beforeQty + item.quantity;

          if (balance) {
            await tx.inventoryBalance.update({
              where: { id: balance.id },
              data: { quantity: afterQty },
            });
          }

          await tx.stockMovement.create({
            data: {
              storeId,
              warehouseId: defaultWarehouse.id,
              stockItemId: item.stockItemId,
              type: 'ORDER_CANCEL_RESTOCK',
              delta: item.quantity,
              beforeQuantity: beforeQty,
              afterQuantity: afterQty,
              referenceType: 'ORDER_CANCEL',
              referenceId: order.orderNumber,
              note: `Hoàn kho do hủy đơn hàng ${order.orderNumber}. Lý do: ${input.cancelReason}`,
              createdById: userId,
            },
          });
        }
      }

      return tx.order.update({
        where: { id: order.id },
        data: {
          status: 'CANCELED',
          canceledAt: new Date(),
          cancelReason: input.cancelReason,
        },
        include: {
          items: true,
        },
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
