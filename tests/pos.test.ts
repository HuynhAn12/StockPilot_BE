import { Prisma } from '@prisma/client';
import { NotFoundError } from '../src/common/errors/app-error';
import { PosService } from '../src/modules/pos/pos.service';

function createMockPrisma() {
  const prisma: any = {
    warehouse: { findFirst: jest.fn() },
    store: { findFirst: jest.fn() },
    stockItem: { findMany: jest.fn(), findFirst: jest.fn() },
    inventoryBalance: { updateMany: jest.fn(), findUnique: jest.fn() },
    stockMovement: { create: jest.fn() },
    order: { create: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn((callback) => callback(prisma)),
  };
  return prisma;
}

describe('PosService', () => {
  let prisma: any;
  let service: PosService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new PosService(prisma);
  });

  it('creates a cash POS sale with fulfilled order, stock movement, paid payment, and audit rows', async () => {
    prisma.warehouse.findFirst.mockResolvedValue({ id: 5, storeId: 1, isDefault: true, isActive: true });
    prisma.store.findFirst.mockResolvedValue({ id: 1, name: 'Demo Store', code: 'demo', phone: null, address: null });
    prisma.stockItem.findMany.mockResolvedValue([
      {
        id: 7,
        storeId: 1,
        sku: 'SKU-1',
        name: 'SKU One',
        sellingPrice: new Prisma.Decimal('15000'),
        costPrice: new Prisma.Decimal('9000'),
      },
    ]);
    prisma.order.create.mockResolvedValue({
      id: 10,
      storeId: 1,
      orderNumber: 'POS-1',
      status: 'DRAFT',
      subtotalAmount: new Prisma.Decimal('30000'),
      discountAmount: new Prisma.Decimal('1000'),
      taxAmount: new Prisma.Decimal('0'),
      totalAmount: new Prisma.Decimal('29000'),
      items: [
        {
          stockItemId: 7,
          skuSnapshot: 'SKU-1',
          nameSnapshot: 'SKU One',
          unitPriceSnapshot: new Prisma.Decimal('15000'),
          quantity: 2,
          subtotal: new Prisma.Decimal('30000'),
        },
      ],
    });
    prisma.order.update
      .mockResolvedValueOnce({ id: 10, status: 'CONFIRMED' })
      .mockResolvedValueOnce({
        id: 10,
        storeId: 1,
        orderNumber: 'POS-1',
        status: 'FULFILLED',
        subtotalAmount: new Prisma.Decimal('30000'),
        discountAmount: new Prisma.Decimal('1000'),
        taxAmount: new Prisma.Decimal('0'),
        totalAmount: new Prisma.Decimal('29000'),
        fulfilledAt: new Date('2026-10-02T00:00:00.000Z'),
        items: [
          {
            stockItemId: 7,
            skuSnapshot: 'SKU-1',
            nameSnapshot: 'SKU One',
            unitPriceSnapshot: new Prisma.Decimal('15000'),
            quantity: 2,
            subtotal: new Prisma.Decimal('30000'),
          },
        ],
      });
    prisma.stockItem.findFirst.mockResolvedValue({ id: 7, sku: 'SKU-1' });
    prisma.inventoryBalance.updateMany.mockResolvedValue({ count: 1 });
    prisma.inventoryBalance.findUnique.mockResolvedValue({ quantity: 8 });
    prisma.stockMovement.create.mockResolvedValue({ id: 44, stockItemId: 7, delta: -2, beforeQuantity: 10, afterQuantity: 8 });
    prisma.payment.create.mockResolvedValue({
      id: 20,
      provider: 'CASH',
      method: 'CASH',
      status: 'PAID',
      amount: new Prisma.Decimal('29000'),
      currency: 'VND',
      paidAt: new Date('2026-10-02T00:00:00.000Z'),
      providerReference: 'CASH-POS-1',
    });
    prisma.auditLog.create.mockResolvedValue({ id: 1n });

    const result = await service.createCashSale(
      1,
      99,
      { paymentMethod: 'CASH', discountAmount: 1000, items: [{ stockItemId: 7, quantity: 2 }] },
      'POS_SALE_CREATE:1:key'
    );

    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId: 1,
          status: 'DRAFT',
          clientRequestKey: 'POS_SALE_CREATE:1:key',
        }),
      })
    );
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: expect.objectContaining({ status: 'CONFIRMED' }),
    });
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: expect.objectContaining({ status: 'FULFILLED' }),
      include: { items: true },
    });
    expect(prisma.stockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'ORDER_FULFILL',
        referenceType: 'POS_SALE',
        idempotencyKey: 'POS_SALE_CREATE:1:key:STOCK',
      }),
    });
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'CASH',
        method: 'CASH',
        status: 'PAID',
        clientRequestKey: 'POS_SALE_CREATE:1:key:PAYMENT',
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'POS_SALE_CREATED', entityType: 'ORDER', entityId: '10' }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'PAYMENT_CREATED', entityType: 'PAYMENT', entityId: '20' }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'PAYMENT_PAID', entityType: 'PAYMENT', entityId: '20' }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'ORDER_CONFIRMED', entityType: 'ORDER', entityId: '10' }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'ORDER_FULFILLED', entityType: 'ORDER', entityId: '10' }),
    });
    expect(result.order.status).toBe('FULFILLED');
    expect(result.receipt.total.toString()).toBe('29000');
  });

  it('rejects inactive, missing, or cross-store POS items before creating order/payment/audit', async () => {
    prisma.warehouse.findFirst.mockResolvedValue({ id: 5, storeId: 1, isDefault: true, isActive: true });
    prisma.store.findFirst.mockResolvedValue({ id: 1, name: 'Demo Store', code: 'demo', phone: null, address: null });
    prisma.stockItem.findMany.mockResolvedValue([]);

    await expect(
      service.createCashSale(1, 99, { paymentMethod: 'CASH', items: [{ stockItemId: 999, quantity: 1 }] }, 'key')
    ).rejects.toThrow(NotFoundError);

    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
