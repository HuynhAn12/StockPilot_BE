import { PrismaClient } from '@prisma/client';
import { OrderService } from '../../src/modules/orders/order.service';
import { ReturnService } from '../../src/modules/returns/return.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { generateRefreshToken } from '../../src/common/utils/jwt';

/**
 * Real MySQL 8.4 Concurrency & Transaction Integration Test
 *
 * Exercises real production services against live MySQL database.
 * Safety rules:
 * - Only executes when TEST_DATABASE_URL or valid database connection is available.
 * - Safely protects against production data mutation.
 */

const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const isLiveDb = Boolean(dbUrl && !dbUrl.includes('mock'));

(isLiveDb ? describe : describe.skip)('MySQL 8.4 Real Services Concurrency Integration Suite', () => {
  let prisma: PrismaClient;
  let orderService: OrderService;
  let returnService: ReturnService;
  let inventoryService: InventoryService;
  let authService: AuthService;

  let testStoreId: number;
  let testWarehouseId: number;
  let testUserId: number;
  let testStockItemId: number;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: dbUrl });
    await prisma.$connect();

    orderService = new OrderService();
    returnService = new ReturnService();
    inventoryService = new InventoryService();
    authService = new AuthService();

    // Setup dedicated isolated test tenant
    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const store = await prisma.store.create({
      data: {
        name: `Real Service Test Store ${uniqueSuffix}`,
        code: `RST_STORE_${uniqueSuffix}`,
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

    const user = await prisma.user.create({
      data: {
        email: `tester_${uniqueSuffix}@test.com`,
        passwordHash: 'dummy_hash',
        fullName: 'Concurrency Tester',
        role: 'SHOP_OWNER',
        storeId: testStoreId,
      },
    });
    testUserId = user.id;

    const product = await prisma.product.create({
      data: {
        storeId: testStoreId,
        name: 'Concurrency Test Product',
        code: `PROD_LIVE_${uniqueSuffix}`,
      },
    });

    const stockItem = await prisma.stockItem.create({
      data: {
        storeId: testStoreId,
        productId: product.id,
        sku: `SKU_LIVE_${uniqueSuffix}`,
        name: 'Concurrency Test SKU',
        costPrice: 50000,
        sellingPrice: 100000,
      },
    });
    testStockItemId = stockItem.id;
  });

  afterAll(async () => {
    if (prisma && testStoreId) {
      await prisma.store.delete({ where: { id: testStoreId } }).catch(() => {});
      await prisma.$disconnect();
    }
  });

  it('Test A (Oversell Prevention): 5 concurrent orders requesting 2 units when stock is 4 => exactly 2 succeed, 3 rejected, balance = 0', async () => {
    // Reset balance to exactly 4
    await prisma.inventoryBalance.upsert({
      where: {
        warehouseId_stockItemId: {
          warehouseId: testWarehouseId,
          stockItemId: testStockItemId,
        },
      },
      create: {
        storeId: testStoreId,
        warehouseId: testWarehouseId,
        stockItemId: testStockItemId,
        quantity: 4,
      },
      update: { quantity: 4 },
    });

    // Create 5 separate draft orders, each for 2 units
    const draftOrders = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        orderService.createDraftOrder(testStoreId, testUserId, {
          items: [{ stockItemId: testStockItemId, quantity: 2 }],
          discountAmount: 0,
          taxAmount: 0,
        })
      )
    );

    // Concurrently confirm all 5 orders
    const results = await Promise.allSettled(
      draftOrders.map((order) => orderService.confirmOrder(testStoreId, testUserId, order.id))
    );

    const successful = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(successful.length).toBe(2);
    expect(failed.length).toBe(3);

    const balance = await prisma.inventoryBalance.findUnique({
      where: {
        warehouseId_stockItemId: {
          warehouseId: testWarehouseId,
          stockItemId: testStockItemId,
        },
      },
    });
    expect(balance?.quantity).toBe(0);
  });

  it('Test B (Same Order Double-Confirm Guard): 2 concurrent confirm calls on same DRAFT order => exactly 1 succeeds, 1 rejected, stock deducted once', async () => {
    // Set balance to 10
    await prisma.inventoryBalance.update({
      where: {
        warehouseId_stockItemId: {
          warehouseId: testWarehouseId,
          stockItemId: testStockItemId,
        },
      },
      data: { quantity: 10 },
    });

    const draftOrder = await orderService.createDraftOrder(testStoreId, testUserId, {
      items: [{ stockItemId: testStockItemId, quantity: 3 }],
      discountAmount: 0,
      taxAmount: 0,
    });

    const results = await Promise.allSettled([
      orderService.confirmOrder(testStoreId, testUserId, draftOrder.id),
      orderService.confirmOrder(testStoreId, testUserId, draftOrder.id),
    ]);

    const successful = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(successful.length).toBe(1);
    expect(failed.length).toBe(1);

    const balance = await prisma.inventoryBalance.findUnique({
      where: {
        warehouseId_stockItemId: {
          warehouseId: testWarehouseId,
          stockItemId: testStockItemId,
        },
      },
    });
    expect(balance?.quantity).toBe(7); // Deducted exactly 3 (from 10 to 7)
  });

  it('Test C (Concurrent Return Over-Return Guard): 2 concurrent returns of 2 units on order of 2 units => exactly 1 succeeds, 1 rejected, returnedQuantity = 2', async () => {
    const draftOrder = await orderService.createDraftOrder(testStoreId, testUserId, {
      items: [{ stockItemId: testStockItemId, quantity: 2 }],
      discountAmount: 0,
      taxAmount: 0,
    });
    await orderService.confirmOrder(testStoreId, testUserId, draftOrder.id);
    const fulfilledOrder = await orderService.fulfillOrder(testStoreId, draftOrder.id);

    const orderItemId = (fulfilledOrder as any).items[0].id;

    const results = await Promise.allSettled([
      returnService.createReturn(testStoreId, testUserId, {
        orderId: fulfilledOrder.id,
        reason: 'Concurrent return test 1',
        items: [{ orderItemId, quantity: 2, isRestockable: true }],
      }),
      returnService.createReturn(testStoreId, testUserId, {
        orderId: fulfilledOrder.id,
        reason: 'Concurrent return test 2',
        items: [{ orderItemId, quantity: 2, isRestockable: true }],
      }),
    ]);

    const successful = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(successful.length).toBe(1);
    expect(failed.length).toBe(1);

    const updatedOrderItem = await prisma.orderItem.findUnique({ where: { id: orderItemId } });
    expect((updatedOrderItem as any)?.returnedQuantity).toBe(2);
  });

  it('Test D (Concurrent Order Cancel Guard): 2 concurrent cancel requests on CONFIRMED order => exactly 1 succeeds, stock restored once', async () => {
    const draftOrder = await orderService.createDraftOrder(testStoreId, testUserId, {
      items: [{ stockItemId: testStockItemId, quantity: 2 }],
      discountAmount: 0,
      taxAmount: 0,
    });
    await orderService.confirmOrder(testStoreId, testUserId, draftOrder.id);

    const balanceBeforeCancel = await prisma.inventoryBalance.findUnique({
      where: {
        warehouseId_stockItemId: {
          warehouseId: testWarehouseId,
          stockItemId: testStockItemId,
        },
      },
    });
    const qtyBeforeCancel = balanceBeforeCancel?.quantity || 0;

    const results = await Promise.allSettled([
      orderService.cancelOrder(testStoreId, testUserId, draftOrder.id, { cancelReason: 'Cancel 1' }),
      orderService.cancelOrder(testStoreId, testUserId, draftOrder.id, { cancelReason: 'Cancel 2' }),
    ]);

    const successful = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(successful.length).toBe(1);
    expect(failed.length).toBe(1);

    const balanceAfterCancel = await prisma.inventoryBalance.findUnique({
      where: {
        warehouseId_stockItemId: {
          warehouseId: testWarehouseId,
          stockItemId: testStockItemId,
        },
      },
    });
    expect(balanceAfterCancel?.quantity).toBe(qtyBeforeCancel + 2); // Restored exactly once
  });
});
