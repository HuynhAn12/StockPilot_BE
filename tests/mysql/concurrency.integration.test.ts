import { PrismaClient } from '@prisma/client';
import { OrderService } from '../../src/modules/orders/order.service';
import { ReturnService } from '../../src/modules/returns/return.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { ImportExportService } from '../../src/modules/import-export/import-export.service';

/**
 * Real MySQL 8.4 Concurrency & Transaction Integration Test Suite (V5 Hardened)
 *
 * Exercises real production services against live MySQL database.
 * Safety rules:
 * - Only executes when TEST_DATABASE_URL or valid database connection is available.
 * - Enforces DB Name Safety Guard to prevent production data mutation.
 * - Injects the same test PrismaClient into all services to guarantee zero DB mismatch.
 */

const rawDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

function isSafeTestDatabase(url?: string): boolean {
  if (!url) return false;
  try {
    const sanitized = url.replace(/^mysql:\/\//, 'http://');
    const parsed = new URL(sanitized);
    const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();
    return (
      dbName.includes('_test') ||
      dbName.includes('test_') ||
      dbName.includes('_ci') ||
      dbName.includes('ci_') ||
      dbName.includes('_dev') ||
      dbName.includes('dev_')
    );
  } catch {
    return false;
  }
}

const isLiveDb = Boolean(rawDbUrl && isSafeTestDatabase(rawDbUrl));

(isLiveDb ? describe : describe.skip)('MySQL 8.4 Real Services Concurrency Integration Suite', () => {
  let prisma: PrismaClient;
  let orderService: OrderService;
  let returnService: ReturnService;
  let inventoryService: InventoryService;
  let authService: AuthService;
  let importExportService: ImportExportService;

  let testStoreId: number;
  let testWarehouseId: number;
  let testUserId: number;
  let testStockItemId: number;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();

    // Dependency Injection: Ensure all services use the test database instance
    orderService = new OrderService(prisma);
    returnService = new ReturnService(prisma);
    inventoryService = new InventoryService(prisma);
    authService = new AuthService(prisma);
    importExportService = new ImportExportService(prisma);

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

  it('Test C (Concurrent Return Over-Return & Exact Refund Cap Guard): 2 concurrent returns of 2 units on order of 2 units => exactly 1 succeeds, returnedQuantity = 2', async () => {
    const draftOrder = await orderService.createDraftOrder(testStoreId, testUserId, {
      items: [{ stockItemId: testStockItemId, quantity: 2 }],
      discountAmount: 20000, // 20k discount on 200k subtotal => refundableAmount = 180,000
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
    expect(Number((updatedOrderItem as any)?.returnedQuantity)).toBe(2);
    expect(Number((updatedOrderItem as any)?.refundedAmount)).toBe(180000);
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

  it('Test E (Audit vs Outflow Concurrency): Concurrent physical audit (15) and manual outflow (-3) on balance (10) => consistent balance and no lost updates', async () => {
    // Reset balance to 10
    await prisma.inventoryBalance.update({
      where: {
        warehouseId_stockItemId: {
          warehouseId: testWarehouseId,
          stockItemId: testStockItemId,
        },
      },
      data: { quantity: 10 },
    });

    const [auditRes, outflowRes] = await Promise.allSettled([
      inventoryService.audit(testStoreId, testUserId, {
        warehouseId: testWarehouseId,
        items: [{ stockItemId: testStockItemId, countedQuantity: 15 }],
        note: 'Concurrent Audit 15',
      }),
      inventoryService.outflow(testStoreId, testUserId, {
        warehouseId: testWarehouseId,
        items: [{ stockItemId: testStockItemId, quantity: 3 }],
        note: 'Concurrent Outflow 3',
      }),
    ]);

    expect(auditRes.status).toBe('fulfilled');
    expect(outflowRes.status).toBe('fulfilled');

    const finalBalance = await prisma.inventoryBalance.findUnique({
      where: {
        warehouseId_stockItemId: {
          warehouseId: testWarehouseId,
          stockItemId: testStockItemId,
        },
      },
    });

    // Valid serializable outcomes:
    // 1. Audit then Outflow: 10 -> 15 -> 12
    // 2. Outflow then Audit: 10 -> 7 -> 15
    expect([12, 15]).toContain(finalBalance?.quantity);
  });

  it('Test F (Concurrent Refresh Token Rotation Race): 2 concurrent refreshes with the same token => exactly 1 succeeds, 1 rejected', async () => {
    const uniqueEmail = `race_user_${Date.now()}@test.com`;
    const regResult = await authService.registerOwner({
      email: uniqueEmail,
      password: 'StrongPassword123!',
      fullName: 'Race Auth User',
      storeName: `Race Store ${Date.now()}`,
      storeCode: `RACE_${Date.now()}`,
    });

    const initialRefreshToken = regResult.tokens.refreshToken;

    const results = await Promise.allSettled([
      authService.refreshToken(initialRefreshToken),
      authService.refreshToken(initialRefreshToken),
    ]);

    const successful = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(successful.length).toBe(1);
    expect(failed.length).toBe(1);
  });

  it('Test G (Import Job Idempotency & Replay Guard): Duplicate commits on same ImportJob do not duplicate inventory stock', async () => {
    const importSku = `SKU_IMPORT_JOB_${Date.now()}`;
    const previewRes = await importExportService.previewImport(testStoreId, testUserId, {
      items: [
        {
          categoryName: 'Import Cat',
          categoryCode: `CAT_IMP_${Date.now()}`,
          productName: 'Import Prod',
          productCode: `PROD_IMP_${Date.now()}`,
          sku: importSku,
          costPrice: 30000,
          sellingPrice: 60000,
          initialQuantity: 8,
          minStockLevel: 2,
          maxStockLevel: 50,
        },
      ],
      warehouseId: testWarehouseId,
    });

    const jobId = previewRes.jobId;

    // Concurrently commit the exact same ImportJob twice
    const [commit1, commit2] = await Promise.allSettled([
      importExportService.commitImport(testStoreId, testUserId, { jobId }),
      importExportService.commitImport(testStoreId, testUserId, { jobId }),
    ]);

    // At least one fulfilled; if both resolved, both return identical summary
    const fulfilledResults = [commit1, commit2].filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(fulfilledResults.length).toBeGreaterThanOrEqual(1);

    // Verify stock item created
    const createdItem = await prisma.stockItem.findUnique({
      where: { storeId_sku: { storeId: testStoreId, sku: importSku } },
    });
    expect(createdItem).not.toBeNull();

    // Verify initial stock was added ONCE (quantity = 8, not 16)
    const importedBalance = await prisma.inventoryBalance.findUnique({
      where: {
        warehouseId_stockItemId: {
          warehouseId: testWarehouseId,
          stockItemId: createdItem!.id,
        },
      },
    });
    expect(importedBalance?.quantity).toBe(8);
  });
});

