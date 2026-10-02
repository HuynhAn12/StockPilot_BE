import { PrismaClient, Role } from '@prisma/client';
import { InsufficientStockError, NotFoundError } from '../../src/common/errors/app-error';
import { PosService } from '../../src/modules/pos/pos.service';

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

(isLiveDb ? describe : describe.skip)('MySQL POS sale and payment foundation', () => {
  let prisma: PrismaClient;
  let service: PosService;
  const createdStoreIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
    service = new PosService(prisma);
  });

  afterAll(async () => {
    for (const storeId of createdStoreIds.reverse()) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  async function createStoreFixture(prefix: string, quantity = 10) {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const store = await prisma.store.create({
      data: {
        name: `${prefix} Store ${suffix}`,
        code: `${prefix.toLowerCase()}-${suffix}`.replace(/_/g, '-'),
      },
    });
    createdStoreIds.push(store.id);

    const user = await prisma.user.create({
      data: {
        storeId: store.id,
        email: `${prefix.toLowerCase()}-${suffix}@example.test`,
        passwordHash: 'test-hash',
        fullName: `${prefix} User`,
        role: Role.WAREHOUSE_STAFF,
      },
    });
    const warehouse = await prisma.warehouse.create({
      data: {
        storeId: store.id,
        name: `${prefix} Default Warehouse`,
        isDefault: true,
      },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: `${prefix} Product`,
        code: `PRD_${suffix}`,
      },
    });
    const stockItem = await prisma.stockItem.create({
      data: {
        storeId: store.id,
        productId: product.id,
        sku: `SKU_${suffix}`,
        name: `${prefix} SKU`,
        costPrice: 10000,
        sellingPrice: 15000,
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        storeId: store.id,
        warehouseId: warehouse.id,
        stockItemId: stockItem.id,
        quantity,
        reservedQuantity: 0,
      },
    });

    return { store, user, warehouse, product, stockItem, suffix };
  }

  it('creates a cash POS sale, deducts stock, creates PAID payment, and writes audit atomically', async () => {
    const fixture = await createStoreFixture('PosCash', 10);
    const result = await service.createCashSale(
      fixture.store.id,
      fixture.user.id,
      {
        paymentMethod: 'CASH',
        items: [{ stockItemId: fixture.stockItem.id, quantity: 2 }],
        discountAmount: 1000,
      },
      `POS_SALE_CREATE:${fixture.store.id}:cash-${fixture.suffix}`
    );

    expect(result.order.status).toBe('FULFILLED');
    expect(result.payment.status).toBe('PAID');
    expect(result.payment.method).toBe('CASH');
    expect(result.receipt.total.toString()).toBe('29000');

    const [balance, movementCount, auditEvents, payment] = await Promise.all([
      prisma.inventoryBalance.findUnique({
        where: {
          warehouseId_stockItemId: {
            warehouseId: fixture.warehouse.id,
            stockItemId: fixture.stockItem.id,
          },
        },
      }),
      prisma.stockMovement.count({ where: { storeId: fixture.store.id, referenceType: 'POS_SALE' } }),
      prisma.auditLog.findMany({
        where: { storeId: fixture.store.id },
        orderBy: { id: 'asc' },
        select: { action: true },
      }),
      prisma.payment.findFirst({ where: { storeId: fixture.store.id, orderId: result.order.id } }),
    ]);

    expect(balance?.quantity).toBe(8);
    expect(movementCount).toBe(1);
    expect(auditEvents.map((event) => event.action)).toEqual([
      'ORDER_CREATED',
      'POS_SALE_CREATED',
      'PAYMENT_CREATED',
      'PAYMENT_PAID',
      'ORDER_CONFIRMED',
      'ORDER_FULFILLED',
    ]);
    expect(payment?.amount.toString()).toBe('29000');
  });

  it('rolls back order, payment, movement, and audit when stock is insufficient', async () => {
    const fixture = await createStoreFixture('PosRollback', 1);
    const key = `POS_SALE_CREATE:${fixture.store.id}:rollback-${fixture.suffix}`;

    await expect(
      service.createCashSale(
        fixture.store.id,
        fixture.user.id,
        {
          paymentMethod: 'CASH',
          items: [{ stockItemId: fixture.stockItem.id, quantity: 2 }],
        },
        key
      )
    ).rejects.toThrow(InsufficientStockError);

    const [orderCount, paymentCount, movementCount, auditCount, balance] = await Promise.all([
      prisma.order.count({ where: { storeId: fixture.store.id, clientRequestKey: key } }),
      prisma.payment.count({ where: { storeId: fixture.store.id } }),
      prisma.stockMovement.count({ where: { storeId: fixture.store.id } }),
      prisma.auditLog.count({ where: { storeId: fixture.store.id } }),
      prisma.inventoryBalance.findUnique({
        where: {
          warehouseId_stockItemId: {
            warehouseId: fixture.warehouse.id,
            stockItemId: fixture.stockItem.id,
          },
        },
      }),
    ]);

    expect(orderCount).toBe(0);
    expect(paymentCount).toBe(0);
    expect(movementCount).toBe(0);
    expect(auditCount).toBe(0);
    expect(balance?.quantity).toBe(1);
  });

  it('rejects cross-store stock items without mutation or audit', async () => {
    const left = await createStoreFixture('PosLeft', 5);
    const right = await createStoreFixture('PosRight', 5);

    await expect(
      service.createCashSale(
        right.store.id,
        right.user.id,
        {
          paymentMethod: 'CASH',
          items: [{ stockItemId: left.stockItem.id, quantity: 1 }],
        },
        `POS_SALE_CREATE:${right.store.id}:xstore-${right.suffix}`
      )
    ).rejects.toThrow(NotFoundError);

    const [rightOrderCount, rightPaymentCount, rightAuditCount, leftBalance] = await Promise.all([
      prisma.order.count({ where: { storeId: right.store.id } }),
      prisma.payment.count({ where: { storeId: right.store.id } }),
      prisma.auditLog.count({ where: { storeId: right.store.id } }),
      prisma.inventoryBalance.findUnique({
        where: {
          warehouseId_stockItemId: {
            warehouseId: left.warehouse.id,
            stockItemId: left.stockItem.id,
          },
        },
      }),
    ]);

    expect(rightOrderCount).toBe(0);
    expect(rightPaymentCount).toBe(0);
    expect(rightAuditCount).toBe(0);
    expect(leftBalance?.quantity).toBe(5);
  });
});
