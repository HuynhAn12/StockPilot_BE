import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { z } from 'zod';
import { createReturnSchema } from './return.schema';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { PaginationQuery, buildPaginationResult } from '../../common/utils/pagination';

export class ReturnService {
  private prisma: PrismaClient;

  constructor(customPrisma?: PrismaClient) {
    this.prisma = customPrisma || defaultPrisma;
  }

  async createReturn(
    storeId: number,
    userId: number,
    input: z.infer<typeof createReturnSchema>,
    clientRequestKey?: string
  ) {
    const returnNumber = `RET-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    const defaultWarehouse = await this.prisma.warehouse.findFirst({
      where: { storeId, isDefault: true, isActive: true },
    });

    if (!defaultWarehouse) {
      throw new NotFoundError('Không tìm thấy kho mặc định để nhận hàng trả');
    }

    return this.prisma.$transaction(async (tx) => {
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

      // 1. Validate and aggregate current request items by orderItemId
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

      // Sort orderItemIds ascending to prevent deadlocks under high concurrency
      const sortedEntries = Array.from(requestItemsMap.entries()).sort((a, b) => a[0] - b[0]);

      let totalRefundAmount = new Prisma.Decimal(0);
      const returnItemsData = [];
      const restockList: { stockItemId: number; quantity: number }[] = [];

      // 2. Perform atomic conditional updates on order_items to strictly guard against over-return and over-refund
      for (const [orderItemId, reqItem] of sortedEntries) {
        const lockedOrderItems = typeof (tx as any).$queryRaw === 'function'
          ? await tx.$queryRaw<Array<{
          id: number;
          orderId: number;
          storeId: number;
          stockItemId: number;
          skuSnapshot: string;
          unitPriceSnapshot: Prisma.Decimal;
          quantity: number;
          subtotal: Prisma.Decimal;
          returnedQuantity: number;
          refundableAmount: Prisma.Decimal;
          refundedAmount: Prisma.Decimal;
        }>>`
          SELECT id, orderId, storeId, stockItemId, skuSnapshot, unitPriceSnapshot,
                 quantity, subtotal, returnedQuantity, refundableAmount, refundedAmount
          FROM order_items
          WHERE id = ${orderItemId}
            AND orderId = ${order.id}
            AND storeId = ${storeId}
          FOR UPDATE
        `
          : [];

        const orderItem = lockedOrderItems[0] || orderItemMap.get(orderItemId);
        if (!orderItem) {
          throw new NotFoundError(`Dòng đơn hàng ID ${orderItemId} không thuộc đơn hàng #${order.orderNumber}`);
        }

        const linePrice = orderItem.unitPriceSnapshot
          ? new Prisma.Decimal(orderItem.unitPriceSnapshot).mul(orderItem.quantity)
          : new Prisma.Decimal(0);
        const refundableTotal = orderItem.refundableAmount !== undefined && orderItem.refundableAmount !== null
          ? new Prisma.Decimal(orderItem.refundableAmount)
          : (orderItem.subtotal !== undefined && orderItem.subtotal !== null)
          ? new Prisma.Decimal(orderItem.subtotal)
          : linePrice;
        const currentRefunded = orderItem.refundedAmount !== undefined && orderItem.refundedAmount !== null
          ? new Prisma.Decimal(orderItem.refundedAmount)
          : new Prisma.Decimal(0);
        const returnedQty = typeof orderItem.returnedQuantity === 'number' ? orderItem.returnedQuantity : 0;
        const remainingRefundable = refundableTotal.minus(currentRefunded);

        if (remainingRefundable.lte(0)) {
          throw new ConflictError(
            `Dòng sản phẩm ${orderItem.skuSnapshot} đã được hoàn tiền tối đa (Tổng được hoàn: ${refundableTotal}, Đã hoàn: ${currentRefunded})`
          );
        }

        const remainingQuantity = orderItem.quantity - returnedQty;
        if (reqItem.quantity > remainingQuantity) {
          throw new ConflictError(
            `Số lượng trả vượt quá giới hạn mua còn lại của SKU ${orderItem.skuSnapshot} (Còn lại có thể trả: ${remainingQuantity}, Yêu cầu trả: ${reqItem.quantity})`
          );
        }

        // Exact refund calculation: If returning all remaining units of this line, absorb any rounding remainder
        let itemRefundPrice: Prisma.Decimal;
        if (reqItem.quantity === remainingQuantity) {
          itemRefundPrice = remainingRefundable;
        } else {
          const proRata = orderItem.quantity > 0
            ? refundableTotal.mul(reqItem.quantity).div(orderItem.quantity).toDecimalPlaces(2)
            : new Prisma.Decimal(0);
          itemRefundPrice = Prisma.Decimal.min(proRata, remainingRefundable);
        }

        if (itemRefundPrice.lt(0)) {
          itemRefundPrice = new Prisma.Decimal(0);
        }

        const updateResult = await tx.orderItem.updateMany({
          where: {
            id: orderItemId,
            orderId: order.id,
            storeId,
            returnedQuantity: {
              lte: orderItem.quantity - reqItem.quantity,
            },
            refundedAmount: {
              lte: refundableTotal.minus(itemRefundPrice),
            },
          },
          data: {
            returnedQuantity: {
              increment: reqItem.quantity,
            },
            refundedAmount: {
              increment: itemRefundPrice,
            },
          },
        });

        if (updateResult.count !== 1) {
          throw new ConflictError(
            `Số lượng trả hoặc số tiền hoàn vượt quá giới hạn cho phép của SKU ${orderItem.skuSnapshot}`
          );
        }

        totalRefundAmount = totalRefundAmount.plus(itemRefundPrice);

        returnItemsData.push({
          storeId,
          orderItemId: orderItem.id,
          stockItemId: orderItem.stockItemId,
          quantity: reqItem.quantity,
          refundPrice: itemRefundPrice,
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
            idempotencyKey: clientRequestKey,
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
          totalRefundAmount,
          reason: input.reason,
          clientRequestKey,
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
      this.prisma.returnOrder.findMany({
        where: { storeId },
        include: {
          order: true,
          items: true,
        },
        orderBy: { createdAt: (query?.order as any) || 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.returnOrder.count({ where: { storeId } }),
    ]);

    return buildPaginationResult(items, total, page, limit);
  }
}

