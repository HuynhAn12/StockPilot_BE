import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    warehouse: { findFirst: jest.fn() },
    stockItem: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    product: { findMany: jest.fn() },
    order: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    orderItem: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    returnOrder: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    inventoryBalance: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    stockMovement: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    alert: { findMany: jest.fn() },
    pricingRecommendation: { findMany: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

describe('RBAC integration - store APIs', () => {
  const app = createApp();

  const ownerToken = generateAccessToken({
    userId: 1,
    email: 'owner@store-a.test',
    role: 'SHOP_OWNER',
    storeId: 1,
  });
  const staffToken = generateAccessToken({
    userId: 2,
    email: 'staff@store-a.test',
    role: 'WAREHOUSE_STAFF',
    storeId: 1,
  });
  const adminToken = generateAccessToken({
    userId: 3,
    email: 'admin@stockpilot.test',
    role: 'ADMIN',
    storeId: null,
  });
  const ownerStoreBToken = generateAccessToken({
    userId: 4,
    email: 'owner@store-b.test',
    role: 'SHOP_OWNER',
    storeId: 2,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }) => {
      const users: Record<number, any> = {
        1: { id: 1, email: 'owner@store-a.test', role: 'SHOP_OWNER', storeId: 1, isActive: true, store: { isActive: true } },
        2: { id: 2, email: 'staff@store-a.test', role: 'WAREHOUSE_STAFF', storeId: 1, isActive: true, store: { isActive: true } },
        3: { id: 3, email: 'admin@stockpilot.test', role: 'ADMIN', storeId: null, isActive: true, store: null },
        4: { id: 4, email: 'owner@store-b.test', role: 'SHOP_OWNER', storeId: 2, isActive: true, store: { isActive: true } },
      };
      return Promise.resolve(users[where.id] ?? null);
    });
    (prisma.auditLog.create as jest.Mock).mockResolvedValue({ id: 1n });
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function mockOrderCreate() {
    (prisma.stockItem.findMany as jest.Mock).mockResolvedValue([
      { id: 10, sku: 'SKU-10', name: 'Item 10', sellingPrice: 100, costPrice: 50, isActive: true },
    ]);
    (prisma.order.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: 100, orderNumber: 'ORD-100', status: data.status, items: data.items.create })
    );
  }

  function mockOrderConfirm() {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.order.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.order.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: 100,
      orderNumber: 'ORD-100',
      status: 'CONFIRMED',
      items: [{ stockItemId: 10, quantity: 1 }],
    });
    (prisma.stockItem.findFirst as jest.Mock).mockResolvedValue({ id: 10, storeId: 1, sku: 'SKU-10', isActive: true });
    (prisma.inventoryBalance.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.inventoryBalance.findUnique as jest.Mock).mockResolvedValue({ quantity: 9 });
    (prisma.stockMovement.create as jest.Mock).mockResolvedValue({ id: 1, stockItemId: 10, delta: -1 });
  }

  function mockOrderFulfill() {
    (prisma.order.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.order.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: 100,
      orderNumber: 'ORD-100',
      status: 'FULFILLED',
      fulfilledAt: new Date(),
      items: [],
    });
  }

  function mockOrderCancel() {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 100,
      orderNumber: 'ORD-100',
      status: 'DRAFT',
      items: [],
    });
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 100, status: 'DRAFT' }]);
    (prisma.order.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.order.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: 100,
      orderNumber: 'ORD-100',
      status: 'CANCELED',
      items: [],
    });
  }

  function mockInventoryMutation() {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.stockItem.findFirst as jest.Mock).mockResolvedValue({ id: 10, storeId: 1, sku: 'SKU-10', isActive: true });
    (prisma.inventoryBalance.upsert as jest.Mock).mockResolvedValue({ id: 1, quantity: 6, reservedQuantity: 0 });
    (prisma.inventoryBalance.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.inventoryBalance.findUnique as jest.Mock).mockResolvedValue({ id: 1, quantity: 4, reservedQuantity: 0 });
    (prisma.inventoryBalance.update as jest.Mock).mockResolvedValue({ id: 1, quantity: 7, reservedQuantity: 0 });
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 1, quantity: 5 }]);
    (prisma.stockMovement.create as jest.Mock).mockResolvedValue({
      id: 1,
      stockItemId: 10,
      delta: 1,
      beforeQuantity: 5,
      afterQuantity: 6,
    });
  }

  function mockReturnCreate() {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 100,
      storeId: 1,
      orderNumber: 'ORD-100',
      status: 'FULFILLED',
      items: [
        {
          id: 200,
          orderId: 100,
          storeId: 1,
          stockItemId: 10,
          skuSnapshot: 'SKU-10',
          unitPriceSnapshot: 100,
          quantity: 1,
          subtotal: 100,
          refundableAmount: 100,
          refundedAmount: 0,
          returnedQuantity: 0,
        },
      ],
      returns: [],
    });
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([
      {
        id: 200,
        orderId: 100,
        storeId: 1,
        stockItemId: 10,
        skuSnapshot: 'SKU-10',
        unitPriceSnapshot: 100,
        quantity: 1,
        subtotal: 100,
        refundableAmount: 100,
        refundedAmount: 0,
        returnedQuantity: 0,
      },
    ]);
    (prisma.orderItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.returnOrder.create as jest.Mock).mockResolvedValue({
      id: 300,
      returnNumber: 'RET-300',
      status: 'COMPLETED',
      totalRefundAmount: 100,
      items: [],
    });
  }

  it('enforces order roles for create, confirm, fulfill, cancel, admin, and cross-store detail', async () => {
    mockOrderCreate();
    await expect(
      request(app).post('/api/v1/orders').set(auth(ownerToken)).send({ items: [{ stockItemId: 10, quantity: 1 }] })
    ).resolves.toMatchObject({ status: 201 });

    await expect(
      request(app).post('/api/v1/orders').set(auth(staffToken)).send({ items: [{ stockItemId: 10, quantity: 1 }] })
    ).resolves.toMatchObject({ status: 403 });

    mockOrderConfirm();
    await expect(request(app).post('/api/v1/orders/100/confirm').set(auth(ownerToken))).resolves.toMatchObject({ status: 200 });
    await expect(request(app).post('/api/v1/orders/100/confirm').set(auth(staffToken))).resolves.toMatchObject({ status: 403 });

    mockOrderFulfill();
    await expect(request(app).post('/api/v1/orders/100/fulfill').set(auth(ownerToken))).resolves.toMatchObject({ status: 200 });
    mockOrderFulfill();
    await expect(request(app).post('/api/v1/orders/100/fulfill').set(auth(staffToken))).resolves.toMatchObject({ status: 200 });

    mockOrderCancel();
    await expect(
      request(app).post('/api/v1/orders/100/cancel').set(auth(ownerToken)).send({ cancelReason: 'customer request' })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      request(app).post('/api/v1/orders/100/cancel').set(auth(staffToken)).send({ cancelReason: 'customer request' })
    ).resolves.toMatchObject({ status: 403 });

    await expect(request(app).get('/api/v1/orders').set(auth(adminToken))).resolves.toMatchObject({ status: 403 });
    await expect(request(app).post('/api/v1/orders/100/fulfill').set(auth(adminToken))).resolves.toMatchObject({ status: 403 });

    (prisma.order.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(request(app).get('/api/v1/orders/100').set(auth(ownerStoreBToken))).resolves.toMatchObject({ status: 404 });
    expect(prisma.order.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 100, storeId: 2 } })
    );
  });

  it('allows inventory operations for owner and warehouse staff while blocking admin', async () => {
    (prisma.inventoryBalance.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.inventoryBalance.count as jest.Mock).mockResolvedValue(0);
    await expect(request(app).get('/api/v1/inventory/balances').set(auth(ownerToken))).resolves.toMatchObject({ status: 200 });
    await expect(request(app).get('/api/v1/inventory/balances').set(auth(staffToken))).resolves.toMatchObject({ status: 200 });

    mockInventoryMutation();
    await expect(
      request(app).post('/api/v1/inventory/inflow').set(auth(ownerToken)).send({ items: [{ stockItemId: 10, quantity: 1 }] })
    ).resolves.toMatchObject({ status: 200 });
    mockInventoryMutation();
    await expect(
      request(app).post('/api/v1/inventory/outflow').set(auth(staffToken)).send({ items: [{ stockItemId: 10, quantity: 1 }] })
    ).resolves.toMatchObject({ status: 200 });
    mockInventoryMutation();
    await expect(
      request(app).post('/api/v1/inventory/audit').set(auth(staffToken)).send({ items: [{ stockItemId: 10, countedQuantity: 7 }], note: 'counted shelf A' })
    ).resolves.toMatchObject({ status: 200 });

    await expect(request(app).get('/api/v1/inventory/movements').set(auth(adminToken))).resolves.toMatchObject({ status: 403 });
    await expect(
      request(app).post('/api/v1/inventory/audit').set(auth(adminToken)).send({ items: [{ stockItemId: 10, countedQuantity: 7 }] })
    ).resolves.toMatchObject({ status: 403 });
  });

  it('restricts return creation to owners while allowing return reads for store operators', async () => {
    (prisma.returnOrder.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.returnOrder.count as jest.Mock).mockResolvedValue(0);
    await expect(request(app).get('/api/v1/returns').set(auth(ownerToken))).resolves.toMatchObject({ status: 200 });
    await expect(request(app).get('/api/v1/returns').set(auth(staffToken))).resolves.toMatchObject({ status: 200 });

    mockReturnCreate();
    await expect(
      request(app).post('/api/v1/returns').set(auth(ownerToken)).send({
        orderId: 100,
        reason: 'customer returned item',
        items: [{ orderItemId: 200, quantity: 1, isRestockable: false }],
      })
    ).resolves.toMatchObject({ status: 201 });

    await expect(
      request(app).post('/api/v1/returns').set(auth(staffToken)).send({
        orderId: 100,
        reason: 'customer returned item',
        items: [{ orderItemId: 200, quantity: 1, isRestockable: false }],
      })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      request(app).post('/api/v1/returns').set(auth(adminToken)).send({
        orderId: 100,
        reason: 'customer returned item',
        items: [{ orderItemId: 200, quantity: 1, isRestockable: false }],
      })
    ).resolves.toMatchObject({ status: 403 });
  });

  it('enforces export RBAC based on exposed CSV fields', async () => {
    (prisma.product.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.inventoryBalance.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.alert.findMany as jest.Mock).mockResolvedValue([]);

    await expect(request(app).get('/api/v1/export/products').set(auth(staffToken))).resolves.toMatchObject({ status: 200 });
    await expect(request(app).get('/api/v1/export/inventory').set(auth(staffToken))).resolves.toMatchObject({ status: 200 });
    await expect(request(app).get('/api/v1/export/alerts').set(auth(staffToken))).resolves.toMatchObject({ status: 200 });

    for (const path of [
      '/api/v1/export/orders',
      '/api/v1/export/sales',
      '/api/v1/export/returns',
      '/api/v1/export/decision-report',
      '/api/v1/export/recommendations',
    ]) {
      await expect(request(app).get(path).set(auth(staffToken))).resolves.toMatchObject({ status: 403 });
      await expect(request(app).get(path).set(auth(adminToken))).resolves.toMatchObject({ status: 403 });
    }
  });
});
