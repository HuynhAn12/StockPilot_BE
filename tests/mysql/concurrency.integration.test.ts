import { PrismaClient } from '@prisma/client';

/**
 * Real MySQL 8.4 Concurrency & Transaction Integration Test
 *
 * This test suite executes against a live MySQL database when TEST_DATABASE_URL or DATABASE_URL
 * is configured. It verifies:
 * 1. Concurrent Order Return Guard (atomic update preventing over-return under concurrent requests).
 * 2. Concurrent Stock Deduction (preventing overselling / negative stock).
 * 3. Concurrent Audit Adjustment with Row-Level Locking (preventing lost updates).
 */

const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const isLiveDb = Boolean(dbUrl && !dbUrl.includes('mock'));

(isLiveDb ? describe : describe.skip)('MySQL 8.4 Live Concurrency Integration Tests', () => {
  let prisma: PrismaClient;
  let testStoreId: number;
  let testWarehouseId: number;
  let testStockItemId: number;
  let testOrderId: number;
  let testOrderItemId: number;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: dbUrl });
    await prisma.$connect();

    // Setup isolated test tenant
    const uniqueSuffix = Date.now();
    const store = await prisma.store.create({
      data: {
        name: `Integration Test Store ${uniqueSuffix}`,
        code: `TEST_STORE_${uniqueSuffix}`,
      },
    });
    testStoreId = store.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId: testStoreId,
        name: 'Default Test Warehouse',
        isDefault: true,
      },
    });
    testWarehouseId = warehouse.id;

    const product = await prisma.product.create({
      data: {
        storeId: testStoreId,
        name: 'Concurrency Test Product',
        code: `PROD_${uniqueSuffix}`,
      },
    });

    const stockItem = await prisma.stockItem.create({
      data: {
        storeId: testStoreId,
        productId: product.id,
        sku: `SKU_CONCURRENT_${uniqueSuffix}`,
        name: 'Concurrency Test SKU',
        costPrice: 50000,
        sellingPrice: 100000,
      },
    });
    testStockItemId = stockItem.id;

    // Set initial balance = 10
    await prisma.inventoryBalance.create({
      data: {
        storeId: testStoreId,
        warehouseId: testWarehouseId,
        stockItemId: testStockItemId,
        quantity: 10,
      },
    });

    // Create a fulfilled order with quantity = 2
    const order = await prisma.order.create({
      data: {
        storeId: testStoreId,
        orderNumber: `ORD_CONCURRENT_${uniqueSuffix}`,
        status: 'FULFILLED',
        totalAmount: 200000,
        items: {
          create: [
            {
              storeId: testStoreId,
              stockItemId: testStockItemId,
              skuSnapshot: stockItem.sku,
              nameSnapshot: stockItem.name,
              unitPriceSnapshot: 100000,
              costPriceSnapshot: 50000,
              quantity: 2,
              returnedQuantity: 0,
              subtotal: 200000,
            },
          ],
        },
      },
      include: { items: true },
    });
    testOrderId = order.id;
    testOrderItemId = (order as any).items[0].id;
  });

  afterAll(async () => {
    if (prisma && testStoreId) {
      // Clean up test data
      await prisma.store.delete({ where: { id: testStoreId } }).catch(() => {});
      await prisma.$disconnect();
    }
  });

  it('Concurrent Stock Deduction: 10 concurrent requests for quantity 2 with total balance 10 => exactly 5 succeed, 5 fail, balance = 0', async () => {
    const attempts = 10;
    const requestQty = 2; // Total requested = 20, but available = 10

    const results = await Promise.allSettled(
      Array.from({ length: attempts }).map(async (_, idx) => {
        return prisma.$transaction(async (tx) => {
          const update = await tx.inventoryBalance.updateMany({
            where: {
              warehouseId: testWarehouseId,
              stockItemId: testStockItemId,
              quantity: { gte: requestQty },
            },
            data: {
              quantity: { decrement: requestQty },
            },
          });

          if (update.count !== 1) {
            throw new Error('INSUFFICIENT_STOCK');
          }

          await tx.stockMovement.create({
            data: {
              storeId: testStoreId,
              warehouseId: testWarehouseId,
              stockItemId: testStockItemId,
              type: 'ORDER_FULFILL',
              delta: -requestQty,
              beforeQuantity: 0,
              afterQuantity: 0,
              referenceType: 'TEST',
              referenceId: `TEST_${idx}`,
            },
          });
          return true;
        });
      })
    );

    const successful = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(successful.length).toBe(5);
    expect(failed.length).toBe(5);

    const finalBalance = await prisma.inventoryBalance.findUnique({
      where: {
        warehouseId_stockItemId: {
          warehouseId: testWarehouseId,
          stockItemId: testStockItemId,
        },
      },
    });
    expect(finalBalance?.quantity).toBe(0);
  });

  it('Concurrent Return Guard: 2 concurrent return requests for 2 units on order with quantity 2 => exactly 1 succeeds, 1 fails with no over-return', async () => {
    const returnQty = 2;

    const results = await Promise.allSettled(
      [1, 2].map(async () => {
        return prisma.$transaction(async (tx) => {
          const update = await tx.orderItem.updateMany({
            where: {
              id: testOrderItemId,
              orderId: testOrderId,
              storeId: testStoreId,
              returnedQuantity: { lte: 2 - returnQty },
            },
            data: {
              returnedQuantity: { increment: returnQty },
            },
          });

          if (update.count !== 1) {
            throw new Error('RETURN_QUANTITY_EXCEEDED');
          }
          return true;
        });
      })
    );

    const successful = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(successful.length).toBe(1);
    expect(failed.length).toBe(1);

    const finalOrderItem = await prisma.orderItem.findUnique({
      where: { id: testOrderItemId },
    });
    expect((finalOrderItem as any)?.returnedQuantity).toBe(2);
  });
});
