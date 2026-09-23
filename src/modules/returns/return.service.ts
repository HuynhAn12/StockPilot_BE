import { prisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createReturnSchema } from './return.schema';
import { toDecimal, toNumber } from '../../common/utils/decimal';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { PaginationQuery, buildPaginationResult } from '../../common/utils/pagination';

export class ReturnService {
  async createReturn(storeId: number, userId: number, input: z.infer<typeof createReturnSchema>) {
    const returnNumber = `RET-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    const defaultWarehouse = await prisma.warehouse.findFirst({
      where: { storeId, isDefault: true, isActive: true },
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
        throw new ConflictError(
          `Chỉ có thể tạo phiếu trả hàng đối với đơn hàng đã hoàn thành FULFILLED (Trạng thái hiện tại: ${order.status})`
        );
      }

      const orderItemMap = new Map(order.items.map((i) => [i.id, i]));

      // 1. Calculate historical returned quantity per orderItemId
      const previousReturnsMap = new Map<number, number>();
      for (const ret of order.returns) {
        for (const item of ret.items) {
          const current = previousReturnsMap.get(item.orderItemId) || 0;
          previousReturnsMap.set(item.orderItemId, current + item.quantity);
        }
      }

      // 2. Validate and aggregate current request items by orderItemId
      const requestItemsMap = new Map<number, { quantity: number; isRestockable: boolean; note?: string }>();
      for (const item of input.items) {
        const existing = requestItemsMap.get(item.orderItemId);
        if (existing) {
          if (existing.isRestockable !== item.isRestockable) {
            throw new ValidationError(
              `Return item ${item.orderItemId} is duplicated with conflicting restock policy; split it into separate return requests`
            );
          }

          requestItemsMap.set(item.orderItemId, {
            quantity: existing.quantity + item.quantity,
            isRestockable: existing.isRestockable,
            note: [existing.note, item.note].filter(Boolean).join('; '),
          });
        } else {
          requestItemsMap.set(item.orderItemId, {
            quantity: item.quantity,
            isRestockable: item.isRestockable,
            note: item.note,
          });
        }
      }

      let totalRefundAmount = 0;
      const returnItemsData = [];
      const restockList: { stockItemId: number; quantity: number }[] = [];

      for (const [orderItemId, reqItem] of requestItemsMap.entries()) {
        const orderItem = orderItemMap.get(orderItemId);
        if (!orderItem) {
          throw new NotFoundError(`Dòng đơn hàng ID ${orderItemId} không thuộc đơn hàng #${order.orderNumber}`);
        }

        const alreadyReturned = previousReturnsMap.get(orderItemId) || 0;
        const maxReturnable = orderItem.quantity - alreadyReturned;

        if (reqItem.quantity > maxReturnable) {
          throw new ValidationError(
            `Số lượng trả vượt quá giới hạn mua của SKU ${orderItem.skuSnapshot} (Đã mua: ${orderItem.quantity}, Đã trả trước đó: ${alreadyReturned}, Yêu cầu trả: ${reqItem.quantity}, Tối đa cho phép: ${maxReturnable})`
          );
        }

        const unitPrice = toNumber(orderItem.unitPriceSnapshot);
        const itemRefundPrice = unitPrice * reqItem.quantity;
        totalRefundAmount += itemRefundPrice;

        returnItemsData.push({
          storeId,
          orderItemId: orderItem.id,
          stockItemId: orderItem.stockItemId,
          quantity: reqItem.quantity,
          refundPrice: toDecimal(itemRefundPrice),
          isRestockable: reqItem.isRestockable,
          restockWarehouseId: reqItem.isRestockable ? defaultWarehouse.id : null,
          note: reqItem.note,
        });

        if (reqItem.isRestockable) {
          restockList.push({
            stockItemId: orderItem.stockItemId,
            quantity: reqItem.quantity,
          });
        }
      }

      // 3. Restock items into inventory atomically if restockable
      if (restockList.length > 0) {
        await StockLedgerService.atomicAdd(
          tx,
          {
            storeId,
            warehouseId: defaultWarehouse.id,
            userId,
            referenceType: 'RETURN',
            referenceId: returnNumber,
            note: `Nhập kho trả hàng từ đơn #${order.orderNumber}`,
          },
          'RETURN_RESTOCK',
          restockList
        );
      }

      // 4. Create ReturnOrder record
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

  async listReturns(storeId: number, query?: PaginationQuery) {
    const page = query?.page || 1;
    const limit = query?.limit || 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.returnOrder.findMany({
        where: { storeId },
        include: {
          order: true,
          items: true,
        },
        orderBy: { createdAt: (query?.order as any) || 'desc' },
        skip,
        take: limit,
      }),
      prisma.returnOrder.count({ where: { storeId } }),
    ]);

    return buildPaginationResult(items, total, page, limit);
  }
}
