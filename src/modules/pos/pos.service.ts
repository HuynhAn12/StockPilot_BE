import { PaymentMethod, PaymentProvider, PaymentStatus, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { AuditLogService } from '../../common/services/audit-log.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { createPosSaleSchema } from './pos.schema';
import { z } from 'zod';

type CreatePosSaleInput = z.input<typeof createPosSaleSchema>;

export class PosService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  async createCashSale(storeId: number, userId: number, input: CreatePosSaleInput, clientRequestKey?: string) {
    const now = new Date();

    return this.db.$transaction(async (tx) => {
      const warehouse = input.warehouseId
        ? await tx.warehouse.findFirst({ where: { id: input.warehouseId, storeId, isActive: true } })
        : await tx.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

      if (!warehouse) {
        throw new NotFoundError('Active POS warehouse was not found');
      }

      const store = await tx.store.findFirst({
        where: { id: storeId, isActive: true },
        select: { id: true, name: true, code: true, phone: true, address: true },
      });
      if (!store) {
        throw new NotFoundError('Store was not found or inactive');
      }

      const aggregatedItems = StockLedgerService.normalizeItems(input.items);
      const itemIds = aggregatedItems.map((item) => item.stockItemId);
      const stockItems = await tx.stockItem.findMany({
        where: {
          storeId,
          id: { in: itemIds },
          isActive: true,
          product: { isActive: true },
        },
      });

      if (stockItems.length !== itemIds.length) {
        throw new NotFoundError('One or more POS sale items do not exist in this store or are inactive');
      }

      const itemMap = new Map(stockItems.map((stockItem) => [stockItem.id, stockItem]));
      let subtotalAmount = new Prisma.Decimal(0);
      const rawLines = aggregatedItems.map((item) => {
        const stockItem = itemMap.get(item.stockItemId)!;
        const unitPrice = new Prisma.Decimal(stockItem.sellingPrice);
        const costPrice = new Prisma.Decimal(stockItem.costPrice);
        const subtotal = unitPrice.mul(item.quantity).toDecimalPlaces(2);
        subtotalAmount = subtotalAmount.plus(subtotal);

        return { item, stockItem, unitPrice, costPrice, subtotal };
      });

      const discountAmount = new Prisma.Decimal(input.discountAmount || 0).toDecimalPlaces(2);
      const taxAmount = new Prisma.Decimal(input.taxAmount || 0).toDecimalPlaces(2);
      if (discountAmount.gt(subtotalAmount)) {
        throw new ValidationError('POS sale discount cannot exceed subtotal');
      }
      const totalAmount = subtotalAmount.minus(discountAmount).plus(taxAmount).toDecimalPlaces(2);
      const orderItemsData: Prisma.OrderItemUncheckedCreateWithoutOrderInput[] = [];
      let allocatedRefundableSum = new Prisma.Decimal(0);

      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        const isLastLine = i === rawLines.length - 1;
        let refundableAmount: Prisma.Decimal;

        if (isLastLine) {
          refundableAmount = totalAmount.minus(allocatedRefundableSum).toDecimalPlaces(2);
        } else {
          const lineDiscount = discountAmount.mul(line.subtotal).div(subtotalAmount).toDecimalPlaces(2);
          const lineTax = taxAmount.mul(line.subtotal).div(subtotalAmount).toDecimalPlaces(2);
          refundableAmount = line.subtotal.minus(lineDiscount).plus(lineTax).toDecimalPlaces(2);
          allocatedRefundableSum = allocatedRefundableSum.plus(refundableAmount);
        }

        orderItemsData.push({
          storeId,
          stockItemId: line.stockItem.id,
          skuSnapshot: line.stockItem.sku,
          nameSnapshot: line.stockItem.name,
          unitPriceSnapshot: line.unitPrice,
          costPriceSnapshot: line.costPrice,
          quantity: line.item.quantity,
          refundableAmount,
          refundedAmount: new Prisma.Decimal(0),
          returnedQuantity: 0,
          subtotal: line.subtotal,
        });
      }

      const orderNumber = `POS-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

      const order = await tx.order.create({
        data: {
          storeId,
          orderNumber,
          status: 'DRAFT',
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          subtotalAmount,
          discountAmount,
          taxAmount,
          totalAmount,
          note: input.note,
          clientRequestKey,
          createdById: userId,
          items: {
            create: orderItemsData,
          },
        },
        include: { items: true },
      });

      const payment = await tx.payment.create({
        data: {
          storeId,
          orderId: order.id,
          provider: PaymentProvider.CASH,
          method: PaymentMethod.CASH,
          amount: totalAmount,
          currency: 'VND',
          status: PaymentStatus.PAID,
          providerReference: `CASH-${order.orderNumber}`,
          clientRequestKey: clientRequestKey ? `${clientRequestKey}:PAYMENT` : undefined,
          paidAt: now,
          metadataJson: {
            source: 'POS',
            orderNumber: order.orderNumber,
          },
        },
      });

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'ORDER_CREATED',
        entityType: 'ORDER',
        entityId: order.id,
        afterJson: {
          orderNumber: order.orderNumber,
          status: order.status,
          totalAmount: order.totalAmount,
          itemCount: order.items.length,
          source: 'POS',
        },
      });
      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'POS_SALE_CREATED',
        entityType: 'ORDER',
        entityId: order.id,
        afterJson: {
          orderNumber: order.orderNumber,
          status: order.status,
          totalAmount: order.totalAmount,
          paymentId: payment.id,
        },
      });
      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'PAYMENT_CREATED',
        entityType: 'PAYMENT',
        entityId: payment.id,
        afterJson: {
          orderId: order.id,
          provider: payment.provider,
          method: payment.method,
          status: payment.status,
          amount: payment.amount,
        },
      });
      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'PAYMENT_PAID',
        entityType: 'PAYMENT',
        entityId: payment.id,
        beforeJson: { status: PaymentStatus.PENDING },
        afterJson: {
          status: payment.status,
          paidAt: payment.paidAt,
          providerReference: payment.providerReference,
        },
      });

      await tx.order.update({
        where: { id: order.id },
        data: { status: 'CONFIRMED', confirmedAt: now },
      });

      const movements = await StockLedgerService.atomicDeduct(
        tx,
        {
          storeId,
          warehouseId: warehouse.id,
          userId,
          referenceType: 'POS_SALE',
          referenceId: order.orderNumber,
          idempotencyKey: clientRequestKey ? `${clientRequestKey}:STOCK` : undefined,
          note: `POS sale ${order.orderNumber}`,
        },
        'ORDER_FULFILL',
        aggregatedItems
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
          source: 'POS',
        },
      });

      const fulfilledOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: 'FULFILLED', fulfilledAt: now },
        include: { items: true },
      });

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'ORDER_FULFILLED',
        entityType: 'ORDER',
        entityId: order.id,
        beforeJson: { status: 'CONFIRMED' },
        afterJson: {
          status: fulfilledOrder.status,
          orderNumber: fulfilledOrder.orderNumber,
          fulfilledAt: fulfilledOrder.fulfilledAt,
          source: 'POS',
        },
      });

      return {
        order: fulfilledOrder,
        payment,
        warehouse,
        receipt: {
          orderId: fulfilledOrder.id,
          orderNumber: fulfilledOrder.orderNumber,
          store,
          soldAt: fulfilledOrder.fulfilledAt,
          items: fulfilledOrder.items.map((item) => ({
            stockItemId: item.stockItemId,
            sku: item.skuSnapshot,
            name: item.nameSnapshot,
            quantity: item.quantity,
            unitPrice: item.unitPriceSnapshot,
            subtotal: item.subtotal,
          })),
          subtotal: fulfilledOrder.subtotalAmount,
          discount: fulfilledOrder.discountAmount,
          tax: fulfilledOrder.taxAmount,
          total: fulfilledOrder.totalAmount,
          payment: {
            id: payment.id,
            method: payment.method,
            status: payment.status,
            amount: payment.amount,
            currency: payment.currency,
            paidAt: payment.paidAt,
          },
        },
      };
    }).catch((error) => {
      if (isUniqueConstraintError(error)) {
        throw new ConflictError('POS sale was already processed for this idempotency key or payment reference');
      }
      throw error;
    });
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? error.code === 'P2002'
    : (error as { code?: unknown })?.code === 'P2002';
}
