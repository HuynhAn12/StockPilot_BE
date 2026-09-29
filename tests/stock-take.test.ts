import { StockTakeStatus } from '@prisma/client';
import { ConflictError, NotFoundError } from '../src/common/errors/app-error';
import { StockTakeService } from '../src/modules/stock-takes/stock-take.service';

function createMockPrisma() {
  const prisma: any = {
    warehouse: { findFirst: jest.fn() },
    stockTake: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), updateMany: jest.fn() },
    stockTakeItem: { createMany: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    inventoryBalance: { findMany: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    stockMovement: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn((callback) => callback(prisma));
  return prisma;
}

describe('StockTakeService', () => {
  let prisma: any;
  let service: StockTakeService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new StockTakeService(prisma);
  });

  it('creates a DRAFT stock take only for an active warehouse in the same store', async () => {
    prisma.warehouse.findFirst.mockResolvedValue({ id: 5, storeId: 1, isActive: true });
    prisma.stockTake.create.mockResolvedValue({ id: 10, status: StockTakeStatus.DRAFT, warehouseId: 5 });

    const result = await service.create(1, 99, { warehouseId: 5, note: 'cycle count' });

    expect(prisma.warehouse.findFirst).toHaveBeenCalledWith({
      where: { id: 5, storeId: 1, isActive: true },
    });
    expect(prisma.stockTake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storeId: 1, warehouseId: 5, createdById: 99 }),
      })
    );
    expect(result.status).toBe(StockTakeStatus.DRAFT);
  });

  it('rejects creating a stock take for a foreign or inactive warehouse', async () => {
    prisma.warehouse.findFirst.mockResolvedValue(null);

    await expect(service.create(1, 99, { warehouseId: 5 })).rejects.toThrow(NotFoundError);
  });

  it('starts a DRAFT stock take by snapshotting current warehouse balances', async () => {
    prisma.stockTake.findFirst.mockResolvedValueOnce({ id: 10, storeId: 1, warehouseId: 5, status: StockTakeStatus.DRAFT });
    prisma.stockTake.updateMany.mockResolvedValue({ count: 1 });
    prisma.inventoryBalance.findMany.mockResolvedValue([
      { stockItemId: 7, quantity: 12 },
      { stockItemId: 8, quantity: 0 },
    ]);
    prisma.stockTakeItem.createMany.mockResolvedValue({ count: 2 });
    prisma.stockTake.findFirst.mockResolvedValueOnce({ id: 10, status: StockTakeStatus.IN_PROGRESS, items: [] });

    await service.start(1, 10);

    expect(prisma.stockTake.updateMany).toHaveBeenCalledWith({
      where: { id: 10, storeId: 1, status: StockTakeStatus.DRAFT },
      data: { status: StockTakeStatus.IN_PROGRESS, startedAt: expect.any(Date) },
    });
    expect(prisma.stockTakeItem.createMany).toHaveBeenCalledWith({
      data: [
        { storeId: 1, stockTakeId: 10, stockItemId: 7, expectedQuantity: 12, countedQuantity: 12, varianceQuantity: 0 },
        { storeId: 1, stockTakeId: 10, stockItemId: 8, expectedQuantity: 0, countedQuantity: 0, varianceQuantity: 0 },
      ],
      skipDuplicates: true,
    });
  });

  it('updates counts only while IN_PROGRESS and derives variance server-side', async () => {
    prisma.stockTake.findFirst.mockResolvedValueOnce({ id: 10, storeId: 1, warehouseId: 5, status: StockTakeStatus.IN_PROGRESS });
    prisma.stockTakeItem.findFirst.mockResolvedValue({ id: 33, expectedQuantity: 12 });
    prisma.stockTakeItem.update.mockResolvedValue({ id: 33 });
    prisma.stockTake.findFirst.mockResolvedValueOnce({ id: 10, status: StockTakeStatus.IN_PROGRESS, items: [] });

    await service.updateCounts(1, 10, { items: [{ stockItemId: 7, countedQuantity: 9, note: 'short' }] });

    expect(prisma.stockTakeItem.update).toHaveBeenCalledWith({
      where: { id: 33 },
      data: {
        countedQuantity: 9,
        varianceQuantity: -3,
        note: 'short',
      },
    });
  });

  it('completes atomically, updates balance, creates movement and links it to the stock take item', async () => {
    prisma.stockTake.findFirst.mockResolvedValueOnce({ id: 10, storeId: 1, warehouseId: 5, status: StockTakeStatus.IN_PROGRESS });
    prisma.stockTake.updateMany.mockResolvedValue({ count: 1 });
    prisma.stockTakeItem.findMany.mockResolvedValue([
      { id: 33, stockItemId: 7, countedQuantity: 9, expectedQuantity: 12 },
    ]);
    prisma.inventoryBalance.upsert.mockResolvedValue({});
    prisma.$queryRaw.mockResolvedValue([{ id: 1, quantity: 12, reservedQuantity: 2 }]);
    prisma.inventoryBalance.update.mockResolvedValue({ id: 1, quantity: 9 });
    prisma.stockMovement.create.mockResolvedValue({ id: 44, delta: -3 });
    prisma.stockTakeItem.update.mockResolvedValue({ id: 33 });
    prisma.stockTake.findFirst.mockResolvedValueOnce({ id: 10, status: StockTakeStatus.COMPLETED, items: [] });

    await service.complete(1, 99, 10, 'STOCK_TAKE_COMPLETE:1:key');

    expect(prisma.inventoryBalance.update).toHaveBeenCalledWith({
      where: { warehouseId_stockItemId: { warehouseId: 5, stockItemId: 7 } },
      data: { quantity: 9 },
    });
    expect(prisma.stockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'AUDIT_ADJUSTMENT',
        delta: -3,
        beforeQuantity: 12,
        afterQuantity: 9,
        referenceType: 'STOCK_TAKE',
        referenceId: 'STOCK_TAKE-10',
        createdById: 99,
      }),
    });
    expect(prisma.stockTakeItem.update).toHaveBeenCalledWith({
      where: { id: 33 },
      data: { adjustmentMovementId: 44 },
    });
  });

  it('rejects completion when counted quantity is below reserved quantity', async () => {
    prisma.stockTake.findFirst.mockResolvedValueOnce({ id: 10, storeId: 1, warehouseId: 5, status: StockTakeStatus.IN_PROGRESS });
    prisma.stockTake.updateMany.mockResolvedValue({ count: 1 });
    prisma.stockTakeItem.findMany.mockResolvedValue([
      { id: 33, stockItemId: 7, countedQuantity: 1, expectedQuantity: 12 },
    ]);
    prisma.inventoryBalance.upsert.mockResolvedValue({});
    prisma.$queryRaw.mockResolvedValue([{ id: 1, quantity: 12, reservedQuantity: 2 }]);

    await expect(service.complete(1, 99, 10)).rejects.toThrow(ConflictError);
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('cancels only non-terminal stock takes without inventory mutation', async () => {
    prisma.stockTake.findFirst.mockResolvedValueOnce({ id: 10, storeId: 1, status: StockTakeStatus.IN_PROGRESS });
    prisma.stockTake.updateMany.mockResolvedValue({ count: 1 });
    prisma.stockTake.findFirst.mockResolvedValueOnce({ id: 10, status: StockTakeStatus.CANCELED, items: [] });

    await service.cancel(1, 10);

    expect(prisma.stockTake.updateMany).toHaveBeenCalledWith({
      where: { id: 10, storeId: 1, status: { in: [StockTakeStatus.DRAFT, StockTakeStatus.IN_PROGRESS] } },
      data: { status: StockTakeStatus.CANCELED },
    });
    expect(prisma.inventoryBalance.update).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });
});
