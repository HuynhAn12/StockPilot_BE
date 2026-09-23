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
});
