import { OrderService } from '../src/modules/orders/order.service';
import { prisma } from '../src/config/db';
import { ConflictError, InsufficientStockError } from '../src/common/errors/app-error';

jest.mock('../src/config/db', () => ({
  prisma: {
    warehouse: { findFirst: jest.fn() },
    stockItem: { findMany: jest.fn() },
    order: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    inventoryBalance: { findUnique: jest.fn(), update: jest.fn() },
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

  it('Xác nhận đơn (CONFIRM) phải trừ tồn kho và ghi StockMovement ORDER_FULFILL trong transaction', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      orderNumber: 'ORD-TEST-01',
      status: 'DRAFT',
      items: [{ stockItemId: 10, skuSnapshot: 'SKU-01', quantity: 3 }],
    });
    (prisma.inventoryBalance.findUnique as jest.Mock).mockResolvedValue({ id: 1, quantity: 10 });
    (prisma.inventoryBalance.update as jest.Mock).mockResolvedValue({ id: 1, quantity: 7 });
    (prisma.order.update as jest.Mock).mockResolvedValue({ id: 50, status: 'CONFIRMED' });

    const result = await orderService.confirmOrder(1, 100, 50);

    expect(prisma.inventoryBalance.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { quantity: 7 },
    });
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
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      orderNumber: 'ORD-TEST-01',
      status: 'DRAFT',
      items: [{ stockItemId: 10, skuSnapshot: 'SKU-01', quantity: 5 }],
    });
    (prisma.inventoryBalance.findUnique as jest.Mock).mockResolvedValue({ id: 1, quantity: 2 }); // Chỉ có 2

    await expect(orderService.confirmOrder(1, 100, 50)).rejects.toThrow(InsufficientStockError);
  });

  it('Không cho phép hủy trực tiếp đơn hàng đã hoàn thành (FULFILLED)', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true });
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
