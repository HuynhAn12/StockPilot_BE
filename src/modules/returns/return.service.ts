import { prisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createReturnSchema } from './return.schema';
import { toDecimal, toNumber } from '../../common/utils/decimal';

export class ReturnService {
  async createReturn(storeId: number, userId: number, input: z.infer<typeof createReturnSchema>) {
    const returnNumber = `RET-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const defaultWarehouse = await prisma.warehouse.findFirst({
      where: { storeId, isDefault: true },
    });

    if (!defaultWarehouse) {
      throw new NotFoundError('Không tìm thấy kho mặc định để nhận hàng trả');
    }

    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, storeId },
        include: {
          items: true,
          returns: {
            include: { items: true },
          },
        },
      });

      if (!order) {
        throw new NotFoundError('Đơn hàng không tồn tại trong cửa hàng');
      }

      if (order.status !== 'FULFILLED') {
        throw new ConflictError(`Chỉ có thể trả hàng đối với đơn đã hoàn thành FULFILLED (Trạng thái: ${order.status})`);
      }

      const orderItemMap = new Map(order.items.map((i) => [i.id, i]));

      const previousReturnsMap = new Map<number, number>();
      for (const ret of order.returns) {
        for (const item of ret.items) {
          const current = previousReturnsMap.get(item.orderItemId) || 0;
          previousReturnsMap.set(item.orderItemId, current + item.quantity);
        }
      }

      let totalRefundAmount = 0;
      const returnItemsData = [];

      for (const item of input.items) {
        const orderItem = orderItemMap.get(item.orderItemId);
        if (!orderItem) {
          throw new NotFoundError(`Dòng đơn hàng ID ${item.orderItemId} không thuộc đơn hàng này`);
        }

        const alreadyReturned = previousReturnsMap.get(item.orderItemId) || 0;
        const maxReturnable = orderItem.quantity - alreadyReturned;

        if (item.quantity > maxReturnable) {
          throw new ValidationError(
            `Số lượng trả vượt quá số lượng đã mua/chưa trả của SKU ${orderItem.skuSnapshot} (Đã mua: ${orderItem.quantity}, Đã trả: ${alreadyReturned}, Muốn trả: ${item.quantity})`
          );
        }

        const unitPrice = toNumber(orderItem.unitPriceSnapshot);
        const itemRefundPrice = unitPrice * item.quantity;
        totalRefundAmount += itemRefundPrice;

        returnItemsData.push({
          storeId,
          orderItemId: orderItem.id,
          stockItemId: orderItem.stockItemId,
          quantity: item.quantity,
          refundPrice: toDecimal(itemRefundPrice),
          isRestockable: item.isRestockable,
          restockWarehouseId: item.isRestockable ? defaultWarehouse.id : null,
          note: item.note,
        });

        if (item.isRestockable) {
          const balance = await tx.inventoryBalance.findUnique({
            where: {
              warehouseId_stockItemId: {
                warehouseId: defaultWarehouse.id,
                stockItemId: orderItem.stockItemId,
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
          } else {
            await tx.inventoryBalance.create({
              data: {
                storeId,
                warehouseId: defaultWarehouse.id,
                stockItemId: orderItem.stockItemId,
                quantity: afterQty,
                reservedQuantity: 0,
              },
            });
          }

          await tx.stockMovement.create({
            data: {
              storeId,
              warehouseId: defaultWarehouse.id,
              stockItemId: orderItem.stockItemId,
              type: 'RETURN_RESTOCK',
              delta: item.quantity,
              beforeQuantity: beforeQty,
              afterQuantity: afterQty,
              referenceType: 'RETURN',
              referenceId: returnNumber,
              note: `Nhập kho trả hàng từ đơn ${order.orderNumber}`,
              createdById: userId,
            },
          });
        }
      }

      return tx.returnOrder.create({
        data: {
          storeId,
          orderId: order.id,
          returnNumber,
          status: 'COMPLETED',
          totalRefundAmount: toDecimal(totalRefundAmount),
          reason: input.reason,
          createdById: userId,
          items: {
            create: returnItemsData,
          },
        },
        include: {
          items: true,
          order: true,
        },
      });
    });
  }

  async listReturns(storeId: number) {
    return prisma.returnOrder.findMany({
      where: { storeId },
      include: {
        order: true,
        items: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
