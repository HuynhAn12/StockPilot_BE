import { PrismaClient, MovementType } from '@prisma/client';
import { InsufficientStockError, NotFoundError } from '../../common/errors/app-error';

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface StockChangeItem {
  stockItemId: number;
  quantity: number;
}

export interface StockChangeContext {
  storeId: number;
  warehouseId: number;
  userId: number;
  referenceType: string;
  referenceId: string;
  idempotencyKey?: string;
  note?: string;
}

export class StockLedgerService {
  /**
   * Aggregates duplicate stock items in input list and sorts them by stockItemId ascending
   * to strictly eliminate deadlock risks in concurrent transactions.
   */
  static normalizeItems(items: StockChangeItem[]): StockChangeItem[] {
    const map = new Map<number, number>();
    for (const item of items) {
      const current = map.get(item.stockItemId) || 0;
      map.set(item.stockItemId, current + item.quantity);
    }

    return Array.from(map.entries())
      .map(([stockItemId, quantity]) => ({ stockItemId, quantity }))
      .sort((a, b) => a.stockItemId - b.stockItemId);
  }

  /**
   * Atomically decreases inventory balance with concurrency check (quantity >= requested).
   * Prevents lost updates and overselling.
   */
  static async atomicDeduct(
    tx: TransactionClient,
    context: StockChangeContext,
    movementType: MovementType,
    items: StockChangeItem[]
  ) {
    const normalized = this.normalizeItems(items);
    const movements = [];

    for (const item of normalized) {
      if (item.quantity <= 0) continue;
      const movementIdempotencyKey = context.idempotencyKey && normalized.length > 1
        ? `${context.idempotencyKey}:${item.stockItemId}`
        : context.idempotencyKey;

      // 1. Verify SKU exists and is active in store
      const stockItem = await tx.stockItem.findFirst({
        where: { id: item.stockItemId, storeId: context.storeId, isActive: true },
      });

      if (!stockItem) {
        throw new NotFoundError(`Sản phẩm/SKU ID ${item.stockItemId} không tồn tại hoặc đã ngừng hoạt động`);
      }

      // 2. Perform atomic decrement with conditional gte check
      const updateResult = await tx.inventoryBalance.updateMany({
        where: {
          warehouseId: context.warehouseId,
          stockItemId: item.stockItemId,
          quantity: { gte: item.quantity },
        },
        data: {
          quantity: { decrement: item.quantity },
        },
      });

      if (updateResult.count === 0) {
        // Fetch current quantity to build informative error message
        const currentBalance = await tx.inventoryBalance.findUnique({
          where: {
            warehouseId_stockItemId: {
              warehouseId: context.warehouseId,
              stockItemId: item.stockItemId,
            },
          },
        });
        const currentQty = currentBalance ? currentBalance.quantity : 0;
        throw new InsufficientStockError(
          `Tồn kho SKU ${stockItem.sku} không đủ hoặc đang có giao dịch cạnh tranh (Hiện có: ${currentQty}, Yêu cầu: ${item.quantity})`
        );
      }

      // 3. Retrieve accurate post-update balance
      const updatedBalance = await tx.inventoryBalance.findUnique({
        where: {
          warehouseId_stockItemId: {
            warehouseId: context.warehouseId,
            stockItemId: item.stockItemId,
          },
        },
      });

      const afterQuantity = updatedBalance!.quantity;
      const beforeQuantity = afterQuantity + item.quantity;

      // 4. Create immutable stock movement ledger entry
      const movement = await tx.stockMovement.create({
        data: {
          storeId: context.storeId,
          warehouseId: context.warehouseId,
          stockItemId: item.stockItemId,
          type: movementType,
          delta: -item.quantity,
          beforeQuantity,
          afterQuantity,
          referenceType: context.referenceType,
          referenceId: context.referenceId,
          idempotencyKey: movementIdempotencyKey,
          note: context.note || `Xuất kho: ${movementType}`,
          createdById: context.userId,
        },
      });

      movements.push(movement);
    }

    return movements;
  }

  /**
   * Atomically increases inventory balance.
   */
  static async atomicAdd(
    tx: TransactionClient,
    context: StockChangeContext,
    movementType: MovementType,
    items: StockChangeItem[]
  ) {
    const normalized = this.normalizeItems(items);
    const movements = [];

    for (const item of normalized) {
      if (item.quantity <= 0) continue;
      const movementIdempotencyKey = context.idempotencyKey && normalized.length > 1
        ? `${context.idempotencyKey}:${item.stockItemId}`
        : context.idempotencyKey;

      const stockItem = await tx.stockItem.findFirst({
        where: { id: item.stockItemId, storeId: context.storeId, isActive: true },
      });

      if (!stockItem) {
        throw new NotFoundError(`Sản phẩm/SKU ID ${item.stockItemId} không tồn tại hoặc đã ngừng hoạt động`);
      }

      // Atomic upsert / increment
      const balance = await tx.inventoryBalance.upsert({
        where: {
          warehouseId_stockItemId: {
            warehouseId: context.warehouseId,
            stockItemId: item.stockItemId,
          },
        },
        create: {
          storeId: context.storeId,
          warehouseId: context.warehouseId,
          stockItemId: item.stockItemId,
          quantity: item.quantity,
          reservedQuantity: 0,
        },
        update: {
          quantity: { increment: item.quantity },
        },
      });

      const afterQuantity = balance.quantity;
      const beforeQuantity = afterQuantity - item.quantity;

      const movement = await tx.stockMovement.create({
        data: {
          storeId: context.storeId,
          warehouseId: context.warehouseId,
          stockItemId: item.stockItemId,
          type: movementType,
          delta: item.quantity,
          beforeQuantity,
          afterQuantity,
          referenceType: context.referenceType,
          referenceId: context.referenceId,
          idempotencyKey: movementIdempotencyKey,
          note: context.note || `Nhập kho: ${movementType}`,
          createdById: context.userId,
        },
      });

      movements.push(movement);
    }

    return movements;
  }

  static async replaceWithCount(
    tx: TransactionClient,
    context: StockChangeContext,
    item: { stockItemId: number; countedQuantity: number },
    movementType: MovementType = 'AUDIT_ADJUSTMENT'
  ) {
    const stockItem = await tx.stockItem.findFirst({
      where: { id: item.stockItemId, storeId: context.storeId, isActive: true },
    });

    if (!stockItem) {
      throw new NotFoundError(`Sản phẩm/SKU ID ${item.stockItemId} không tồn tại hoặc đã ngừng hoạt động`);
    }

    await tx.inventoryBalance.upsert({
      where: {
        warehouseId_stockItemId: {
          warehouseId: context.warehouseId,
          stockItemId: item.stockItemId,
        },
      },
      create: {
        storeId: context.storeId,
        warehouseId: context.warehouseId,
        stockItemId: item.stockItemId,
        quantity: 0,
        reservedQuantity: 0,
      },
      update: {},
    });

    const lockedRows = await tx.$queryRaw<Array<{ id: number; quantity: number }>>`
      SELECT id, quantity
      FROM inventory_balances
      WHERE warehouseId = ${context.warehouseId}
        AND stockItemId = ${item.stockItemId}
      FOR UPDATE
    `;

    const lockedBalance = lockedRows[0];
    const beforeQuantity = lockedBalance ? Number(lockedBalance.quantity) : 0;
    const afterQuantity = item.countedQuantity;
    const delta = afterQuantity - beforeQuantity;

    await tx.inventoryBalance.update({
      where: {
        warehouseId_stockItemId: {
          warehouseId: context.warehouseId,
          stockItemId: item.stockItemId,
        },
      },
      data: { quantity: afterQuantity },
    });

    if (delta === 0) {
      return null;
    }

    return tx.stockMovement.create({
      data: {
        storeId: context.storeId,
        warehouseId: context.warehouseId,
        stockItemId: item.stockItemId,
        type: movementType,
        delta,
        beforeQuantity,
        afterQuantity,
        referenceType: context.referenceType,
        referenceId: context.referenceId,
        idempotencyKey: context.idempotencyKey,
        note: context.note || `Kiểm kê điều chỉnh kho: ${delta >= 0 ? '+' : ''}${delta}`,
        createdById: context.userId,
      },
    });
  }
}
