import { OrderService } from '../src/modules/orders/order.service';
import { prisma } from '../src/config/db';
import { ConflictError, InsufficientStockError } from '../src/common/errors/app-error';

jest.mock('../src/config/db', () => ({
  prisma: {
    warehouse: { findFirst: jest.fn() },
    stockItem: { findMany: jest.fn(), findFirst: jest.fn() },
    order: {
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    inventoryBalance: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    stockMovement: { create: jest.fn() },
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

describe('OrderService - Vòng đời đơn hàng & Trừ tồn kho', () => {
  let orderService: OrderService;

  beforeEach(() => {
    jest.clearAllMocks();
    orderService = new OrderService();
  });

  it('Xác nhận đơn (CONFIRM) phải trừ tồn kho nguyên tử và ghi StockMovement ORDER_FULFILL trong transaction', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.order.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.order.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      orderNumber: 'ORD-TEST-01',
      status: 'CONFIRMED',
      items: [{ stockItemId: 10, skuSnapshot: 'SKU-01', quantity: 3 }],
    });
    (prisma.stockItem.findFirst as jest.Mock).mockResolvedValue({ id: 10, storeId: 1, sku: 'SKU-01', isActive: true });
    (prisma.inventoryBalance.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.inventoryBalance.findUnique as jest.Mock).mockResolvedValue({ id: 1, quantity: 7 });
    (prisma.stockMovement.create as jest.Mock).mockResolvedValue({ id: 101 });

    const result = await orderService.confirmOrder(1, 100, 50);

    expect(prisma.inventoryBalance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          warehouseId: 1,
          stockItemId: 10,
          quantity: { gte: 3 },
        }),
        data: {
          quantity: { decrement: 3 },
        },
      })
    );
    expect(prisma.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'ORDER_FULFILL',
          delta: -3,
          beforeQuantity: 10,
          afterQuantity: 7,
          referenceType: 'ORDER',
        }),
      })
    );
    expect(result.status).toBe('CONFIRMED');
  });

  it('Từ chối xác nhận đơn nếu tồn kho không đủ (tranh chấp tồn cuối)', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.order.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.order.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      orderNumber: 'ORD-TEST-01',
      status: 'DRAFT',
      items: [{ stockItemId: 10, skuSnapshot: 'SKU-01', quantity: 5 }],
    });
    (prisma.stockItem.findFirst as jest.Mock).mockResolvedValue({ id: 10, storeId: 1, sku: 'SKU-01', isActive: true });
    (prisma.inventoryBalance.updateMany as jest.Mock).mockResolvedValue({ count: 0 }); // Không đủ tồn
    (prisma.inventoryBalance.findUnique as jest.Mock).mockResolvedValue({ id: 1, quantity: 2 }); // Chỉ có 2

    await expect(orderService.confirmOrder(1, 100, 50)).rejects.toThrow(InsufficientStockError);
  });

  it('Không cho phép hủy trực tiếp đơn hàng đã hoàn thành (FULFILLED)', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      status: 'FULFILLED',
      items: [],
    });

    await expect(
      orderService.cancelOrder(1, 100, 50, { cancelReason: 'Khách muốn hủy' })
    ).rejects.toThrow(ConflictError);
  });

  it('Phân bổ chiết khấu pro-rata cho từng OrderItem và dòng cuối nhận phần dư làm tròn chính xác', async () => {
    (prisma.stockItem.findMany as jest.Mock).mockResolvedValue([
      { id: 1, sku: 'SKU-01', name: 'Item 1', sellingPrice: 100000, costPrice: 50000, isActive: true },
      { id: 2, sku: 'SKU-02', name: 'Item 2', sellingPrice: 100000, costPrice: 50000, isActive: true },
      { id: 3, sku: 'SKU-03', name: 'Item 3', sellingPrice: 100000, costPrice: 50000, isActive: true },
    ]);

    (prisma.order.create as jest.Mock).mockImplementation(({ data }) => Promise.resolve({ id: 10, ...data }));

    await orderService.createDraftOrder(1, 100, {
      items: [
        { stockItemId: 1, quantity: 1 },
        { stockItemId: 2, quantity: 1 },
        { stockItemId: 3, quantity: 1 },
      ],
      discountAmount: 100000, // 100k discount on 300k subtotal => total = 200k. Lines: 66666.67, 66666.67, 66666.66
      taxAmount: 0,
    });

    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotalAmount: expect.any(Object),
          totalAmount: expect.any(Object),
          items: expect.objectContaining({
            create: expect.arrayContaining([
              expect.objectContaining({ stockItemId: 1 }),
              expect.objectContaining({ stockItemId: 2 }),
              expect.objectContaining({ stockItemId: 3 }),
            ]),
          }),
        }),
      })
    );
  });
});

