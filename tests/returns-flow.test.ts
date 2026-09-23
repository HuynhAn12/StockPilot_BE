import { ReturnService } from '../src/modules/returns/return.service';
import { prisma } from '../src/config/db';
import { ConflictError, ValidationError } from '../src/common/errors/app-error';

jest.mock('../src/config/db', () => ({
  prisma: {
    warehouse: { findFirst: jest.fn() },
    order: { findFirst: jest.fn() },
    inventoryBalance: { findUnique: jest.fn(), update: jest.fn() },
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
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true });
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

  it('Từ chối nếu số lượng trả vượt quá số lượng đã mua hoặc chưa hoàn trả', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      status: 'FULFILLED',
      items: [{ id: 1, stockItemId: 10, skuSnapshot: 'SKU-01', quantity: 2, unitPriceSnapshot: 100000 }],
      returns: [
        { items: [{ orderItemId: 1, quantity: 1 }] }, // Đã trả 1 cái trước đó
      ],
    });

    await expect(
      returnService.createReturn(1, 100, {
        orderId: 50,
        reason: 'Khách trả tiếp',
        items: [{ orderItemId: 1, quantity: 2, isRestockable: true }], // Muốn trả 2 -> Tổng là 3 > 2 (Mua)
      })
    ).rejects.toThrow(ValidationError);
  });

  it('Hàng lỗi/hỏng (isRestockable = false) không được nhập lại vào kho', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true });
    (prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 50,
      storeId: 1,
      status: 'FULFILLED',
      items: [{ id: 1, stockItemId: 10, skuSnapshot: 'SKU-01', quantity: 2, unitPriceSnapshot: 100000 }],
      returns: [],
    });

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
    expect(prisma.inventoryBalance.update).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(result.status).toBe('COMPLETED');
  });
});
