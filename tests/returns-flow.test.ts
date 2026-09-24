import { ReturnService } from '../src/modules/returns/return.service';
import { prisma } from '../src/config/db';
import { ConflictError, ValidationError } from '../src/common/errors/app-error';

jest.mock('../src/config/db', () => ({
  prisma: {
    warehouse: { findFirst: jest.fn() },
    order: { findFirst: jest.fn() },
    orderItem: { updateMany: jest.fn() },
    stockItem: { findFirst: jest.fn() },
    inventoryBalance: { findUnique: jest.fn(), update: jest.fn(), upsert: jest.fn() },
    stockMovement: { create: jest.fn() },
    returnOrder: { create: jest.fn() },
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

describe('ReturnService - Trả hàng, hoàn tiền & nhập kho có điều kiện', () => {
  let returnService: ReturnService;

  beforeEach(() => {
    jest.clearAllMocks();
    returnService = new ReturnService();
  });

  it('Chỉ cho phép trả hàng trên đơn đã FULFILLED', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      status: 'CONFIRMED', // Chưa FULFILLED
      items: [],
      returns: [],
    });

    await expect(
      returnService.createReturn(1, 100, {
        orderId: 50,
        reason: 'Khách đổi ý',
        items: [{ orderItemId: 1, quantity: 1, isRestockable: true }],
      })
    ).rejects.toThrow(ConflictError);
  });

  it('Từ chối nếu số lượng trả vượt quá số lượng có thể trả (atomic update count = 0)', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      orderNumber: 'ORD-50',
      status: 'FULFILLED',
      items: [{ id: 1, stockItemId: 10, skuSnapshot: 'SKU-01', quantity: 2, unitPriceSnapshot: 100000 }],
      returns: [],
    });
    // Giả lập atomic updateMany thất bại do điều kiện lte: quantity - requested không thỏa mãn
    (prisma.orderItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(
      returnService.createReturn(1, 100, {
        orderId: 50,
        reason: 'Khách trả tiếp',
        items: [{ orderItemId: 1, quantity: 5, isRestockable: true }],
      })
    ).rejects.toThrow(ConflictError);
  });

  it('Hàng lỗi/hỏng (isRestockable = false) không được nhập lại vào kho', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      orderNumber: 'ORD-50',
      status: 'FULFILLED',
      items: [{ id: 1, stockItemId: 10, skuSnapshot: 'SKU-01', quantity: 2, unitPriceSnapshot: 100000 }],
      returns: [],
    });
    (prisma.orderItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    (prisma.returnOrder.create as jest.Mock).mockResolvedValue({
      id: 1,
      returnNumber: 'RET-01',
      status: 'COMPLETED',
      totalRefundAmount: 100000,
    });

    const result = await returnService.createReturn(1, 100, {
      orderId: 50,
      reason: 'Hàng bị vỡ hỏng do vận chuyển',
      items: [{ orderItemId: 1, quantity: 1, isRestockable: false }],
    });

    // Không cập nhật balance và không tạo movement RETURN_RESTOCK
    expect(prisma.inventoryBalance.upsert).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(result.status).toBe('COMPLETED');
  });

  it('rejects duplicate return payload lines with conflicting restock policy', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      orderNumber: 'ORD-50',
      status: 'FULFILLED',
      items: [{ id: 1, stockItemId: 10, skuSnapshot: 'SKU-01', quantity: 2, unitPriceSnapshot: 100000 }],
      returns: [],
    });

    await expect(
      returnService.createReturn(1, 100, {
        orderId: 50,
        reason: 'Partial return',
        items: [
          { orderItemId: 1, quantity: 1, isRestockable: true },
          { orderItemId: 1, quantity: 1, isRestockable: false },
        ],
      })
    ).rejects.toThrow(ValidationError);
  });
});
