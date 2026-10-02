import { MovementType, PrismaClient, StockTakeStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import {
  CreateStockTakeInput,
  StockTakeListQuery,
  UpdateStockTakeCountsInput,
} from './stock-take.schema';
import { AuditLogService } from '../../common/services/audit-log.service';

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export class StockTakeService {
  private prisma: PrismaClient;

  constructor(customPrisma?: PrismaClient) {
    this.prisma = customPrisma || defaultPrisma;
  }

  private async getActiveWarehouse(storeId: number, warehouseId: number, tx: TransactionClient | PrismaClient = this.prisma) {
    const warehouse = await tx.warehouse.findFirst({
      where: { id: warehouseId, storeId, isActive: true },
    });

    if (!warehouse) {
      throw new NotFoundError('Warehouse does not exist in this store or is inactive');
    }

    return warehouse;
  }

  private async getStockTakeOrThrow(storeId: number, id: number, tx: TransactionClient | PrismaClient = this.prisma) {
    const stockTake = await tx.stockTake.findFirst({
      where: { id, storeId },
      include: {
        warehouse: true,
        createdBy: { select: { id: true, fullName: true, email: true } },
        items: {
          include: {
            stockItem: { include: { product: true } },
            adjustmentMovement: true,
          },
          orderBy: { stockItemId: 'asc' },
        },
      },
    });

    if (!stockTake) {
      throw new NotFoundError('Stock take not found');
    }

    return stockTake;
  }

  async create(storeId: number, userId: number, input: CreateStockTakeInput) {
    await this.getActiveWarehouse(storeId, input.warehouseId);

    return this.prisma.stockTake.create({
      data: {
        storeId,
        warehouseId: input.warehouseId,
        note: input.note,
        createdById: userId,
      },
      include: {
        warehouse: true,
        createdBy: { select: { id: true, fullName: true, email: true } },
        items: true,
      },
    });
  }

  async list(storeId: number, query: StockTakeListQuery) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;
    const where = {
      storeId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.stockTake.findMany({
        where,
        include: {
          warehouse: true,
          createdBy: { select: { id: true, fullName: true, email: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.stockTake.count({ where }),
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

  async detail(storeId: number, id: number) {
    return this.getStockTakeOrThrow(storeId, id);
  }

  async start(storeId: number, id: number) {
    return this.prisma.$transaction(async (tx) => {
      const stockTake = await tx.stockTake.findFirst({ where: { id, storeId } });
      if (!stockTake) throw new NotFoundError('Stock take not found');
      if (stockTake.status !== StockTakeStatus.DRAFT) {
        throw new ConflictError('Only DRAFT stock takes can be started');
      }

      const transition = await tx.stockTake.updateMany({
        where: { id, storeId, status: StockTakeStatus.DRAFT },
        data: { status: StockTakeStatus.IN_PROGRESS, startedAt: new Date() },
      });
      if (transition.count !== 1) {
        throw new ConflictError('Stock take state changed while starting');
      }

      const balances = await tx.inventoryBalance.findMany({
        where: { storeId, warehouseId: stockTake.warehouseId },
        orderBy: { stockItemId: 'asc' },
      });

      if (balances.length > 0) {
        await tx.stockTakeItem.createMany({
          data: balances.map((balance) => ({
            storeId,
            stockTakeId: id,
            stockItemId: balance.stockItemId,
            expectedQuantity: balance.quantity,
            countedQuantity: balance.quantity,
            varianceQuantity: 0,
          })),
          skipDuplicates: true,
        });
      }

      return this.getStockTakeOrThrow(storeId, id, tx);
    });
  }

  async updateCounts(storeId: number, id: number, input: UpdateStockTakeCountsInput) {
    return this.prisma.$transaction(async (tx) => {
      const stockTake = await tx.stockTake.findFirst({ where: { id, storeId } });
      if (!stockTake) throw new NotFoundError('Stock take not found');
      if (stockTake.status !== StockTakeStatus.IN_PROGRESS) {
        throw new ConflictError('Counts can only be updated while a stock take is IN_PROGRESS');
      }

      const sortedItems = [...input.items].sort((a, b) => a.stockItemId - b.stockItemId);
      for (const item of sortedItems) {
        const stockTakeItem = await tx.stockTakeItem.findFirst({
          where: {
            storeId,
            stockTakeId: id,
            stockItemId: item.stockItemId,
            stockItem: { storeId },
          },
        });

        if (!stockTakeItem) {
          throw new NotFoundError(`Stock take item for stockItemId ${item.stockItemId} not found`);
        }

        await tx.stockTakeItem.update({
          where: { id: stockTakeItem.id },
          data: {
            countedQuantity: item.countedQuantity,
            varianceQuantity: item.countedQuantity - stockTakeItem.expectedQuantity,
            note: item.note,
          },
        });
      }

      return this.getStockTakeOrThrow(storeId, id, tx);
    });
  }

  async complete(storeId: number, userId: number, id: number, idempotencyKey?: string) {
    return this.prisma.$transaction(async (tx) => {
      const stockTake = await tx.stockTake.findFirst({ where: { id, storeId } });
      if (!stockTake) throw new NotFoundError('Stock take not found');
      if (stockTake.status !== StockTakeStatus.IN_PROGRESS) {
        throw new ConflictError('Only IN_PROGRESS stock takes can be completed');
      }

      const transition = await tx.stockTake.updateMany({
        where: { id, storeId, status: StockTakeStatus.IN_PROGRESS },
        data: { status: StockTakeStatus.COMPLETED, completedAt: new Date() },
      });
      if (transition.count !== 1) {
        throw new ConflictError('Stock take state changed while completing');
      }

      const items = await tx.stockTakeItem.findMany({
        where: { storeId, stockTakeId: id },
        orderBy: { stockItemId: 'asc' },
      });
      const movementIds: number[] = [];

      for (const item of items) {
        await tx.inventoryBalance.upsert({
          where: {
            warehouseId_stockItemId: {
              warehouseId: stockTake.warehouseId,
              stockItemId: item.stockItemId,
            },
          },
          create: {
            storeId,
            warehouseId: stockTake.warehouseId,
            stockItemId: item.stockItemId,
            quantity: 0,
            reservedQuantity: 0,
          },
          update: {},
        });

        const lockedRows = await (tx as any).$queryRaw<Array<{ id: number; quantity: number; reservedQuantity: number }>>`
          SELECT id, quantity, reservedQuantity
          FROM inventory_balances
          WHERE warehouseId = ${stockTake.warehouseId}
            AND stockItemId = ${item.stockItemId}
          FOR UPDATE
        `;
        const lockedBalance = lockedRows[0];
        const beforeQuantity = lockedBalance ? Number(lockedBalance.quantity) : 0;
        const reservedQuantity = lockedBalance ? Number(lockedBalance.reservedQuantity) : 0;
        const afterQuantity = item.countedQuantity;
        const delta = afterQuantity - beforeQuantity;

        if (reservedQuantity > afterQuantity) {
          throw new ConflictError(
            `Counted quantity for stockItemId ${item.stockItemId} cannot be below reserved quantity`
          );
        }

        await tx.inventoryBalance.update({
          where: {
            warehouseId_stockItemId: {
              warehouseId: stockTake.warehouseId,
              stockItemId: item.stockItemId,
            },
          },
          data: { quantity: afterQuantity },
        });

        if (delta === 0) {
          await tx.stockTakeItem.update({
            where: { id: item.id },
            data: { adjustmentMovementId: null },
          });
          continue;
        }

        const movement = await tx.stockMovement.create({
          data: {
            storeId,
            warehouseId: stockTake.warehouseId,
            stockItemId: item.stockItemId,
            type: MovementType.AUDIT_ADJUSTMENT,
            delta,
            beforeQuantity,
            afterQuantity,
            referenceType: 'STOCK_TAKE',
            referenceId: `STOCK_TAKE-${id}`,
            idempotencyKey: idempotencyKey ? `${idempotencyKey}:${item.stockItemId}` : undefined,
            note: `Stock take #${id} adjustment: ${delta >= 0 ? '+' : ''}${delta}`,
            createdById: userId,
          },
        });

        await tx.stockTakeItem.update({
          where: { id: item.id },
          data: { adjustmentMovementId: movement.id },
        });
        movementIds.push(movement.id);
      }

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'STOCK_TAKE_COMPLETED',
        entityType: 'STOCK_TAKE',
        entityId: id,
        afterJson: {
          stockTakeId: id,
          warehouseId: stockTake.warehouseId,
          movementIds,
        },
      });

      return this.getStockTakeOrThrow(storeId, id, tx);
    });
  }

  async cancel(storeId: number, userId: number, id: number) {
    return this.prisma.$transaction(async (tx) => {
      const stockTake = await tx.stockTake.findFirst({ where: { id, storeId } });
      if (!stockTake) throw new NotFoundError('Stock take not found');
      if (stockTake.status !== StockTakeStatus.DRAFT && stockTake.status !== StockTakeStatus.IN_PROGRESS) {
        throw new ConflictError('Only DRAFT or IN_PROGRESS stock takes can be canceled');
      }

      const transition = await tx.stockTake.updateMany({
        where: { id, storeId, status: { in: [StockTakeStatus.DRAFT, StockTakeStatus.IN_PROGRESS] } },
        data: { status: StockTakeStatus.CANCELED },
      });
      if (transition.count !== 1) {
        throw new ConflictError('Stock take state changed while canceling');
      }

      await AuditLogService.create(tx, {
        storeId,
        userId,
        action: 'STOCK_TAKE_CANCELED',
        entityType: 'STOCK_TAKE',
        entityId: id,
        beforeJson: { status: stockTake.status },
        afterJson: {
          stockTakeId: id,
          warehouseId: stockTake.warehouseId,
          status: StockTakeStatus.CANCELED,
        },
      });

      return this.getStockTakeOrThrow(storeId, id, tx);
    });
  }
}
