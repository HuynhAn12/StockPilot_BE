import { prisma } from '../../config/db';
import { InsufficientStockError, NotFoundError } from '../../common/errors/app-error';
import { z } from 'zod';
import { inflowSchema, outflowSchema, auditSchema } from './inventory.schema';

export class InventoryService {
  private async getTargetWarehouse(storeId: number, warehouseId?: number) {
    if (warehouseId) {
      const wh = await prisma.warehouse.findFirst({
        where: { id: warehouseId, storeId, isActive: true },
      });
      if (!wh) throw new NotFoundError('Kho hàng không tồn tại hoặc đã bị vô hiệu hóa');
      return wh;
    }

    const defaultWh = await prisma.warehouse.findFirst({
      where: { storeId, isDefault: true, isActive: true },
    });
    if (!defaultWh) throw new NotFoundError('Không tìm thấy kho mặc định của cửa hàng');
    return defaultWh;
  }

  async inflow(storeId: number, userId: number, input: z.infer<typeof inflowSchema>) {
    const warehouse = await this.getTargetWarehouse(storeId, input.warehouseId);
    const refId = input.referenceId || `INFLOW-${Date.now()}`;

    return prisma.$transaction(async (tx) => {
      const movements = [];

      for (const item of input.items) {
        const stockItem = await tx.stockItem.findFirst({
          where: { id: item.stockItemId, storeId, isActive: true },
        });

        if (!stockItem) {
          throw new NotFoundError(`Sản phẩm/SKU ID ${item.stockItemId} không tồn tại trong cửa hàng`);
        }

        let balance = await tx.inventoryBalance.findUnique({
          where: {
            warehouseId_stockItemId: {
              warehouseId: warehouse.id,
              stockItemId: stockItem.id,
            },
          },
        });

        const beforeQuantity = balance ? balance.quantity : 0;
        const afterQuantity = beforeQuantity + item.quantity;

        if (balance) {
          balance = await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: { quantity: afterQuantity },
          });
        } else {
          balance = await tx.inventoryBalance.create({
            data: {
              storeId,
              warehouseId: warehouse.id,
              stockItemId: stockItem.id,
              quantity: afterQuantity,
              reservedQuantity: 0,
            },
          });
        }

        const movement = await tx.stockMovement.create({
          data: {
            storeId,
            warehouseId: warehouse.id,
            stockItemId: stockItem.id,
            type: 'INFLOW',
            delta: item.quantity,
            beforeQuantity,
            afterQuantity,
            referenceType: 'GOODS_RECEIPT',
            referenceId: refId,
            note: input.note || 'Nhập hàng vào kho',
            createdById: userId,
          },
        });

        movements.push(movement);
      }

      return { warehouse, movements };
    });
  }

  async outflow(storeId: number, userId: number, input: z.infer<typeof outflowSchema>) {
    const warehouse = await this.getTargetWarehouse(storeId, input.warehouseId);
    const refId = input.referenceId || `OUTFLOW-${Date.now()}`;

    return prisma.$transaction(async (tx) => {
      const movements = [];

      for (const item of input.items) {
        const stockItem = await tx.stockItem.findFirst({
          where: { id: item.stockItemId, storeId, isActive: true },
        });

        if (!stockItem) {
          throw new NotFoundError(`Sản phẩm/SKU ID ${item.stockItemId} không tồn tại trong cửa hàng`);
        }

        const balance = await tx.inventoryBalance.findUnique({
          where: {
            warehouseId_stockItemId: {
              warehouseId: warehouse.id,
              stockItemId: stockItem.id,
            },
          },
        });

        const beforeQuantity = balance ? balance.quantity : 0;

        if (beforeQuantity < item.quantity) {
          throw new InsufficientStockError(
            `Tồn kho SKU ${stockItem.sku} không đủ (Hiện có: ${beforeQuantity}, Yêu cầu xuất: ${item.quantity})`
          );
        }

        const afterQuantity = beforeQuantity - item.quantity;

        await tx.inventoryBalance.update({
          where: { id: balance!.id },
          data: { quantity: afterQuantity },
        });

        const movement = await tx.stockMovement.create({
          data: {
            storeId,
            warehouseId: warehouse.id,
            stockItemId: stockItem.id,
            type: 'OUTFLOW',
            delta: -item.quantity,
            beforeQuantity,
            afterQuantity,
            referenceType: 'MANUAL_OUTFLOW',
            referenceId: refId,
            note: input.note || 'Xuất hàng thủ công',
            createdById: userId,
          },
        });

        movements.push(movement);
      }

      return { warehouse, movements };
    });
  }

  async audit(storeId: number, userId: number, input: z.infer<typeof auditSchema>) {
    const warehouse = await this.getTargetWarehouse(storeId, input.warehouseId);
    const refId = input.referenceId || `AUDIT-${Date.now()}`;

    return prisma.$transaction(async (tx) => {
      const movements = [];

      for (const item of input.items) {
        const stockItem = await tx.stockItem.findFirst({
          where: { id: item.stockItemId, storeId, isActive: true },
        });

        if (!stockItem) {
          throw new NotFoundError(`Sản phẩm/SKU ID ${item.stockItemId} không tồn tại trong cửa hàng`);
        }

        let balance = await tx.inventoryBalance.findUnique({
          where: {
            warehouseId_stockItemId: {
              warehouseId: warehouse.id,
              stockItemId: stockItem.id,
            },
          },
        });

        const beforeQuantity = balance ? balance.quantity : 0;
        const afterQuantity = item.countedQuantity;
        const delta = afterQuantity - beforeQuantity;

        if (balance) {
          await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: { quantity: afterQuantity },
          });
        } else {
          await tx.inventoryBalance.create({
            data: {
              storeId,
              warehouseId: warehouse.id,
              stockItemId: stockItem.id,
              quantity: afterQuantity,
              reservedQuantity: 0,
            },
          });
        }

        const movement = await tx.stockMovement.create({
          data: {
            storeId,
            warehouseId: warehouse.id,
            stockItemId: stockItem.id,
            type: 'AUDIT_ADJUSTMENT',
            delta,
            beforeQuantity,
            afterQuantity,
            referenceType: 'STOCK_AUDIT',
            referenceId: refId,
            note: input.note || `Kiểm kê điều chỉnh: ${delta >= 0 ? '+' : ''}${delta}`,
            createdById: userId,
          },
        });

        movements.push(movement);
      }

      return { warehouse, movements };
    });
  }

  async getBalances(storeId: number, warehouseId?: number) {
    return prisma.inventoryBalance.findMany({
      where: {
        storeId,
        ...(warehouseId ? { warehouseId } : {}),
      },
      include: {
        warehouse: true,
        stockItem: {
          include: {
            product: true,
          },
        },
      },
      orderBy: { stockItemId: 'asc' },
    });
  }

  async getMovements(storeId: number, stockItemId?: number, limit = 50) {
    return prisma.stockMovement.findMany({
      where: {
        storeId,
        ...(stockItemId ? { stockItemId } : {}),
      },
      include: {
        stockItem: true,
        warehouse: true,
        createdBy: {
          select: { id: true, fullName: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
