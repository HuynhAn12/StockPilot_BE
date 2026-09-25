import { PrismaClient } from '@prisma/client';

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

(isLiveDb ? describe : describe.skip)('MySQL 8.4 Database Design v1.1 core alignment', () => {
  let prisma: PrismaClient;
  let storeId: number;
  let userId: number;
  let warehouseId: number;
  let productId: number;
  let stockItemId: number;
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();

    const store = await prisma.store.create({
      data: {
        name: `Schema Alignment Store ${suffix}`,
        code: `SCHEMA_ALIGN_${suffix}`,
      },
    });
    storeId = store.id;

    const user = await prisma.user.create({
      data: {
        email: `schema-align-${suffix}@example.com`,
        passwordHash: 'hashed-password',
        fullName: 'Schema Alignment User',
        role: 'SHOP_OWNER',
        storeId,
      },
    });
    userId = user.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId,
        name: `Schema Alignment Warehouse ${suffix}`,
        isDefault: true,
      },
    });
    warehouseId = warehouse.id;

    const product = await prisma.product.create({
      data: {
        storeId,
        name: `Schema Alignment Product ${suffix}`,
        code: `SCHEMA_PRD_${suffix}`,
      },
    });
    productId = product.id;

    const stockItem = await prisma.stockItem.create({
      data: {
        storeId,
        productId,
        sku: `SCHEMA-SKU-${suffix}`,
        name: `Schema Alignment SKU ${suffix}`,
        costPrice: 100,
        sellingPrice: 150,
      },
    });
    stockItemId = stockItem.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { action: { startsWith: `SCHEMA_ALIGN_${suffix}` } } }).catch(() => {});
    await prisma.systemSetting.deleteMany({ where: { key: { startsWith: `schema.align.${suffix}` } } }).catch(() => {});
    if (storeId) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('accepts the Database Design v1.1 AlertType taxonomy', async () => {
    const alertTypes = ['LOW_STOCK', 'STOCKOUT', 'OVERSTOCK', 'SLOW_MOVING', 'DEAD_STOCK', 'UNUSUAL_DEMAND'] as const;

    await Promise.all(
      alertTypes.map((type) =>
        prisma.alert.create({
          data: {
            storeId,
            stockItemId,
            type,
            severity: 'INFO',
            title: `${type} ${suffix}`,
            message: `${type} alert`,
            reasonJson: { type },
            fingerprint: `${type}_${suffix}`,
          },
        })
      )
    );

    await expect(
      prisma.alert.findMany({
        where: { storeId, type: { in: ['OVERSTOCK', 'SLOW_MOVING', 'DEAD_STOCK'] } },
      })
    ).resolves.toHaveLength(3);
  });

  it('rejects inventory balances with reservedQuantity greater than quantity', async () => {
    await expect(
      prisma.inventoryBalance.create({
        data: {
          storeId,
          warehouseId,
          stockItemId,
          quantity: 1,
          reservedQuantity: 2,
        },
      })
    ).rejects.toThrow();
  });

  it('rejects stock take item variance mismatches and accepts valid stock take relations', async () => {
    const stockTake = await prisma.stockTake.create({
      data: {
        storeId,
        warehouseId,
        status: 'IN_PROGRESS',
        createdById: userId,
      },
    });

    await expect(
      prisma.stockTakeItem.create({
        data: {
          storeId,
          stockTakeId: stockTake.id,
          stockItemId,
          expectedQuantity: 5,
          countedQuantity: 3,
          varianceQuantity: 1,
        },
      })
    ).rejects.toThrow();

    const validItem = await prisma.stockTakeItem.create({
      data: {
        storeId,
        stockTakeId: stockTake.id,
        stockItemId,
        expectedQuantity: 5,
        countedQuantity: 3,
        varianceQuantity: -2,
      },
    });

    const withItems = await prisma.stockTake.findUniqueOrThrow({
      where: { id: stockTake.id },
      include: { items: true },
    });

    expect(validItem.stockTakeId).toBe(stockTake.id);
    expect(withItems.items).toHaveLength(1);
  });

  it('rejects invalid foreign keys added for returns, import items, and idempotency requests', async () => {
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: `SCHEMA-ORD-${suffix}`,
        subtotalAmount: 150,
        totalAmount: 150,
        items: {
          create: {
            storeId,
            stockItemId,
            skuSnapshot: `SCHEMA-SKU-${suffix}`,
            nameSnapshot: `Schema Alignment SKU ${suffix}`,
            unitPriceSnapshot: 150,
            costPriceSnapshot: 100,
            quantity: 1,
            refundableAmount: 150,
            subtotal: 150,
          },
        },
      },
      include: { items: true },
    });

    const returnOrder = await prisma.returnOrder.create({
      data: {
        storeId,
        orderId: order.id,
        returnNumber: `SCHEMA-RET-${suffix}`,
        totalRefundAmount: 150,
      },
    });

    await expect(
      prisma.returnItem.create({
        data: {
          storeId,
          returnOrderId: returnOrder.id,
          orderItemId: order.items[0].id,
          stockItemId,
          quantity: 1,
          refundPrice: 150,
          restockWarehouseId: 987654321,
        },
      })
    ).rejects.toThrow();

    const importJob = await prisma.importJob.create({
      data: {
        storeId,
        createdById: userId,
        type: 'PRODUCTS',
        payloadHash: `schema${suffix}`.slice(0, 64),
        payloadJson: { rows: [] },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      prisma.importJobItem.create({
        data: {
          importJobId: importJob.id,
          rowNumber: 1,
          sku: `MISSING-${suffix}`,
          stockItemId: 987654321,
        },
      })
    ).rejects.toThrow();

    await expect(
      prisma.idempotencyRequest.create({
        data: {
          storeId: 987654321,
          operation: 'SCHEMA_ALIGNMENT',
          key: `missing-store-${suffix}`,
          requestHash: '0'.repeat(64),
          status: 'PROCESSING',
          expiresAt: new Date(Date.now() + 60_000),
        },
      })
    ).rejects.toThrow();
  });

  it('creates basic Notification, AuditLog, AiInteraction, and enforces SystemSetting key uniqueness', async () => {
    const notification = await prisma.notification.create({
      data: {
        storeId,
        userId,
        type: 'SCHEMA_ALIGNMENT',
        title: 'Schema alignment notification',
        message: 'Notification foundation works',
        entityType: 'StockItem',
        entityId: String(stockItemId),
      },
    });
    expect(notification.isRead).toBe(false);

    const auditLog = await prisma.auditLog.create({
      data: {
        storeId,
        userId,
        action: `SCHEMA_ALIGN_${suffix}_CREATE`,
        entityType: 'StockItem',
        entityId: String(stockItemId),
        beforeJson: { before: null },
        afterJson: { stockItemId },
      },
    });
    expect(auditLog.id).toBeTruthy();

    const aiInteraction = await prisma.aiInteraction.create({
      data: {
        storeId,
        userId,
        requestId: `schema-ai-${suffix}`,
        model: 'test-model',
        questionText: 'Summarize stock risk',
        responseText: 'No production AI call is made in this test.',
        contextSummaryJson: { stockItemId },
        status: 'SUCCESS',
      },
    });
    expect(aiInteraction.status).toBe('SUCCESS');

    await prisma.systemSetting.create({
      data: {
        key: `schema.align.${suffix}.retention`,
        valueJson: { days: 30 },
        description: 'Schema alignment uniqueness test',
        updatedById: userId,
      },
    });

    await expect(
      prisma.systemSetting.create({
        data: {
          key: `schema.align.${suffix}.retention`,
          valueJson: { days: 60 },
        },
      })
    ).rejects.toThrow();
  });
});
