import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { canonicalJsonStringify, idempotency } from '../../src/common/middleware/idempotency';
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

(isLiveDb ? describe : describe.skip)('MySQL 8.4 Real Idempotency Unknown Outcome Recovery', () => {
  let prisma: PrismaClient;
  const createdStoreIds: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const storeId of createdStoreIds.reverse()) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('recovers expired PROCESSING ORDER_CREATE from durable clientRequestKey without rerunning handler', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const key = `idem-order-create-${suffix}`;

    const store = await prisma.store.create({
      data: {
        name: `Idempotency Store ${suffix}`,
        code: `IDEM_STORE_${suffix}`,
      },
    });
    createdStoreIds.push(store.id);

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: `Idem Product ${suffix}`,
        code: `IDEM_PRD_${suffix}`,
      },
    });
    const stockItem = await prisma.stockItem.create({
      data: {
        storeId: store.id,
        productId: product.id,
        sku: `SKU-IDEM-${suffix}`,
        name: `Idem StockItem ${suffix}`,
        costPrice: 10000,
        sellingPrice: 20000,
      },
    });

    const effectKey = `ORDER_CREATE:${store.id}:${key}`;
    const body = { items: [{ stockItemId: stockItem.id, quantity: 1 }] };
    const requestHash = crypto
      .createHash('sha256')
      .update(
        canonicalJsonStringify({
          method: 'POST',
          path: '/orders',
          params: {},
          query: {},
          body,
        })
      )
      .digest('hex');

    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        orderNumber: `ORD-IDEM-${suffix}`,
        status: 'DRAFT',
        subtotalAmount: 20000,
        discountAmount: 0,
        taxAmount: 0,
        totalAmount: 20000,
        clientRequestKey: effectKey,
        items: {
          create: {
            storeId: store.id,
            stockItemId: stockItem.id,
            skuSnapshot: stockItem.sku,
            nameSnapshot: stockItem.name,
            unitPriceSnapshot: 20000,
            costPriceSnapshot: 10000,
            quantity: 1,
            refundableAmount: 20000,
            refundedAmount: 0,
            subtotal: 20000,
          },
        },
      },
    });

    await prisma.idempotencyRequest.create({
      data: {
        storeId: store.id,
        operation: 'ORDER_CREATE',
        key,
        requestHash,
        status: 'PROCESSING',
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const handler = jest.fn((_req, res) => res.status(500).json({ success: false }));
    const app = express();
    app.set('prisma', prisma);
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { storeId: store.id, userId: 1 };
      next();
    });
    app.post('/orders', idempotency({ operation: 'ORDER_CREATE' }), handler);

    const response = await request(app)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(body);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.id).toBe(order.id);
    expect(handler).not.toHaveBeenCalled();

    const idem = await prisma.idempotencyRequest.findUniqueOrThrow({
      where: {
        storeId_operation_key: {
          storeId: store.id,
          operation: 'ORDER_CREATE',
          key,
        },
      },
    });
    expect(idem.status).toBe('COMPLETED');
  });

  it('recovers expired PROCESSING POS_SALE_CREATE with full receipt contract and no duplicate mutations', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const key = `idem-pos-sale-${suffix}`;

    const store = await prisma.store.create({
      data: {
        name: `Idempotency POS Store ${suffix}`,
        code: `idem-pos-${suffix}`.replace(/_/g, '-'),
      },
    });
    createdStoreIds.push(store.id);

    const user = await prisma.user.create({
      data: {
        storeId: store.id,
        email: `idem-pos-${suffix}@example.test`,
        passwordHash: 'test-hash',
        fullName: 'POS Idempotency User',
        role: 'WAREHOUSE_STAFF',
      },
    });
    const warehouse = await prisma.warehouse.create({
      data: { storeId: store.id, name: `POS Warehouse ${suffix}`, isDefault: true },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: `POS Product ${suffix}`,
        code: `POS_PRD_${suffix}`,
      },
    });
    const stockItem = await prisma.stockItem.create({
      data: {
        storeId: store.id,
        productId: product.id,
        sku: `SKU-POS-IDEM-${suffix}`,
        name: `POS StockItem ${suffix}`,
        costPrice: 10000,
        sellingPrice: 20000,
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        storeId: store.id,
        warehouseId: warehouse.id,
        stockItemId: stockItem.id,
        quantity: 5,
        reservedQuantity: 0,
      },
    });

    const effectKey = `POS_SALE_CREATE:${store.id}:${key}`;
    const body = { paymentMethod: 'CASH', items: [{ stockItemId: stockItem.id, quantity: 2 }] };
    const service = new PosService(prisma);
    const sale = await service.createCashSale(store.id, user.id, body as any, effectKey);

    const requestHash = crypto
      .createHash('sha256')
      .update(
        canonicalJsonStringify({
          method: 'POST',
          path: '/pos/sales',
          params: {},
          query: {},
          body,
        })
      )
      .digest('hex');

    await prisma.idempotencyRequest.create({
      data: {
        storeId: store.id,
        operation: 'POS_SALE_CREATE',
        key,
        requestHash,
        status: 'PROCESSING',
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const beforeCounts = await Promise.all([
      prisma.order.count({ where: { storeId: store.id } }),
      prisma.payment.count({ where: { storeId: store.id } }),
      prisma.stockMovement.count({ where: { storeId: store.id } }),
      prisma.auditLog.count({ where: { storeId: store.id } }),
    ]);

    const handler = jest.fn((_req, res) => res.status(500).json({ success: false }));
    const app = express();
    app.set('prisma', prisma);
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { storeId: store.id, userId: user.id };
      next();
    });
    app.post('/pos/sales', idempotency({ operation: 'POS_SALE_CREATE' }), handler);

    const response = await request(app)
      .post('/pos/sales')
      .set('Idempotency-Key', key)
      .send(body);

    const afterCounts = await Promise.all([
      prisma.order.count({ where: { storeId: store.id } }),
      prisma.payment.count({ where: { storeId: store.id } }),
      prisma.stockMovement.count({ where: { storeId: store.id } }),
      prisma.auditLog.count({ where: { storeId: store.id } }),
    ]);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.order.id).toBe(sale.order.id);
    expect(response.body.data.payment.id).toBe(sale.payment.id);
    expect(response.body.data.warehouse.id).toBe(warehouse.id);
    expect(response.body.data.receipt.orderId).toBe(sale.order.id);
    expect(response.body.data.receipt.payment.status).toBe('PAID');
    expect(handler).not.toHaveBeenCalled();
    expect(afterCounts).toEqual(beforeCounts);
  });
});
