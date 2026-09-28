import { PrismaClient } from '@prisma/client';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { StockTakeService } from '../../src/modules/stock-takes/stock-take.service';

const rawDbUrl = process.env.TEST_DATABASE_URL;

function isSafeTestDatabase(url?: string): boolean {
  if (!url) return false;
  try {
    const sanitized = url.replace(/^mysql:\/\//, 'http://');
    const parsed = new URL(sanitized);
    const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();

    if (
      dbName.includes('production') ||
      dbName.includes('prod') ||
      dbName.includes('_dev') ||
      dbName.includes('dev_')
    ) {
      return false;
    }

    return (
      dbName.includes('_test') ||
      dbName.includes('test_') ||
      dbName.includes('_ci') ||
      dbName.includes('ci_')
    );
  } catch {
    return false;
  }
}

const isLiveDb = Boolean(rawDbUrl && isSafeTestDatabase(rawDbUrl));

(isLiveDb ? describe : describe.skip)('MySQL 8.4 StockTake workflow integration', () => {
  let prisma: PrismaClient;
  let stockTakeService: StockTakeService;
  let inventoryService: InventoryService;
  let storeId: number;
  let warehouseId: number;
  let userId: number;
  let stockItemId: number;
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
    stockTakeService = new StockTakeService(prisma);
    inventoryService = new InventoryService(prisma);

    const store = await prisma.store.create({
      data: {
        name: `StockTake Store ${suffix}`,
        code: `STK_STORE_${suffix}`,
      },
    });
    storeId = store.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId,
        name: `StockTake Warehouse ${suffix}`,
        isDefault: true,
      },
    });
    warehouseId = warehouse.id;

    const user = await prisma.user.create({
      data: {
        email: `stocktake-${suffix}@example.com`,
        passwordHash: 'hashed-password',
        fullName: 'StockTake Tester',
        role: 'SHOP_OWNER',
        storeId,
      },
    });
    userId = user.id;

    const product = await prisma.product.create({
      data: {
        storeId,
        name: `StockTake Product ${suffix}`,
        code: `STK_PRODUCT_${suffix}`,
      },
    });

    const stockItem = await prisma.stockItem.create({
      data: {
        storeId,
        productId: product.id,
        sku: `STK-SKU-${suffix}`,
        name: `StockTake SKU ${suffix}`,
        costPrice: 100,
        sellingPrice: 150,
      },
    });
    stockItemId = stockItem.id;
  });

  beforeEach(async () => {
    await prisma.stockMovement.deleteMany({
      where: { storeId, stockItemId, referenceType: { in: ['STOCK_TAKE', 'MANUAL_OUTFLOW'] } },
    });
    await prisma.stockTake.deleteMany({ where: { storeId } });
    await prisma.inventoryBalance.upsert({
      where: {
        warehouseId_stockItemId: {
          warehouseId,
          stockItemId,
        },
      },
      create: {
        storeId,
        warehouseId,
        stockItemId,
        quantity: 10,
        reservedQuantity: 0,
      },
      update: {
        quantity: 10,
        reservedQuantity: 0,
      },
    });
  });

  afterAll(async () => {
    if (storeId) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  async function createStartedStockTake(countedQuantity: number) {
    const created = await stockTakeService.create(storeId, userId, { warehouseId });
    await stockTakeService.start(storeId, created.id);
    await stockTakeService.updateCounts(storeId, created.id, {
      items: [{ stockItemId, countedQuantity }],
    });
    return created.id;
  }

  it('completes against real rows and atomically links balance, movement, item and status', async () => {
    await prisma.inventoryBalance.update({
      where: { warehouseId_stockItemId: { warehouseId, stockItemId } },
      data: { quantity: 12, reservedQuantity: 2 },
    });

    const stockTakeId = await createStartedStockTake(9);
    const completed = await stockTakeService.complete(storeId, userId, stockTakeId);

    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_stockItemId: { warehouseId, stockItemId } },
    });
    const item = await prisma.stockTakeItem.findFirstOrThrow({ where: { stockTakeId, stockItemId } });
    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { id: item.adjustmentMovementId || 0 },
    });

    expect(completed.status).toBe('COMPLETED');
    expect(balance.quantity).toBe(9);
    expect(item.varianceQuantity).toBe(-3);
    expect(movement.type).toBe('AUDIT_ADJUSTMENT');
    expect(movement.delta).toBe(-3);
    expect(movement.beforeQuantity).toBe(12);
    expect(movement.afterQuantity).toBe(9);
    expect(movement.referenceType).toBe('STOCK_TAKE');
    expect(movement.referenceId).toBe(`STOCK_TAKE-${stockTakeId}`);
  });

  it('rolls back completion when counted quantity is below reserved quantity', async () => {
    await prisma.inventoryBalance.update({
      where: { warehouseId_stockItemId: { warehouseId, stockItemId } },
      data: { quantity: 12, reservedQuantity: 2 },
    });

    const stockTakeId = await createStartedStockTake(1);

    await expect(stockTakeService.complete(storeId, userId, stockTakeId)).rejects.toThrow();

    const stockTake = await prisma.stockTake.findUniqueOrThrow({ where: { id: stockTakeId } });
    const item = await prisma.stockTakeItem.findFirstOrThrow({ where: { stockTakeId, stockItemId } });
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_stockItemId: { warehouseId, stockItemId } },
    });
    const movements = await prisma.stockMovement.findMany({
      where: { storeId, stockItemId, referenceId: `STOCK_TAKE-${stockTakeId}` },
    });

    expect(stockTake.status).toBe('IN_PROGRESS');
    expect(item.adjustmentMovementId).toBeNull();
    expect(balance.quantity).toBe(12);
    expect(balance.reservedQuantity).toBe(2);
    expect(movements).toHaveLength(0);
  });

  it('allows only one concurrent completion to apply the adjustment', async () => {
    const stockTakeId = await createStartedStockTake(7);

    const results = await Promise.allSettled([
      stockTakeService.complete(storeId, userId, stockTakeId),
      stockTakeService.complete(storeId, userId, stockTakeId),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_stockItemId: { warehouseId, stockItemId } },
    });
    const movements = await prisma.stockMovement.findMany({
      where: { storeId, stockItemId, referenceId: `STOCK_TAKE-${stockTakeId}` },
    });
    const stockTake = await prisma.stockTake.findUniqueOrThrow({ where: { id: stockTakeId } });

    expect(stockTake.status).toBe('COMPLETED');
    expect(balance.quantity).toBe(7);
    expect(movements).toHaveLength(1);
  });

  it('serializes StockTake completion with a competing outflow while preserving movement chain invariants', async () => {
    const stockTakeId = await createStartedStockTake(15);

    const [completeResult, outflowResult] = await Promise.allSettled([
      stockTakeService.complete(storeId, userId, stockTakeId),
      inventoryService.outflow(storeId, userId, {
        warehouseId,
        items: [{ stockItemId, quantity: 3 }],
        note: 'Concurrent outflow during StockTake',
      }),
    ]);

    expect(completeResult.status).toBe('fulfilled');
    expect(outflowResult.status).toBe('fulfilled');

    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { warehouseId_stockItemId: { warehouseId, stockItemId } },
    });
    const movements = await prisma.stockMovement.findMany({
      where: {
        storeId,
        stockItemId,
        OR: [
          { referenceId: `STOCK_TAKE-${stockTakeId}`, type: 'AUDIT_ADJUSTMENT' },
          { note: 'Concurrent outflow during StockTake', type: 'OUTFLOW' },
        ],
      },
      orderBy: { id: 'asc' },
    });

    expect([12, 15]).toContain(balance.quantity);
    expect(balance.quantity).toBeGreaterThanOrEqual(0);
    expect(balance.reservedQuantity).toBeLessThanOrEqual(balance.quantity);
    expect(movements.filter((movement) => movement.type === 'AUDIT_ADJUSTMENT')).toHaveLength(1);
    expect(movements.filter((movement) => movement.type === 'OUTFLOW')).toHaveLength(1);
  });
});
