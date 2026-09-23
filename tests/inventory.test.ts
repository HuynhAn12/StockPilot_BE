import { InventoryService } from '../src/modules/inventory/inventory.service';
import { prisma } from '../src/config/db';
import { InsufficientStockError } from '../src/common/errors/app-error';

jest.mock('../src/config/db', () => ({
  prisma: {
    warehouse: { findFirst: jest.fn() },
    stockItem: { findFirst: jest.fn() },
    inventoryBalance: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
      create: jest.fn(),
    },
    stockMovement: { create: jest.fn() },
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

describe('InventoryService - Nhập xuất kho & Kiểm toán nguyên tử', () => {
  let inventoryService: InventoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    inventoryService = new InventoryService();
  });

  it('Nhập kho (Inflow) phải tăng balance nguyên tử qua upsert và ghi StockMovement INFLOW', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.stockItem.findFirst as jest.Mock).mockResolvedValue({ id: 10, storeId: 1, sku: 'SKU-01', isActive: true });
    (prisma.inventoryBalance.upsert as jest.Mock).mockResolvedValue({ id: 5, quantity: 30 });
    (prisma.stockMovement.create as jest.Mock).mockResolvedValue({
      id: 1,
      type: 'INFLOW',
      delta: 10,
      beforeQuantity: 20,
      afterQuantity: 30,
    });

    const result = await inventoryService.inflow(1, 100, {
      items: [{ stockItemId: 10, quantity: 10 }],
      note: 'Nhập hàng đầu ngày',
    });

    expect(prisma.inventoryBalance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          warehouseId_stockItemId: {
            warehouseId: 1,
            stockItemId: 10,
          },
        },
        update: {
          quantity: { increment: 10 },
        },
      })
    );
    expect(result.movements[0].type).toBe('INFLOW');
    expect(result.movements[0].delta).toBe(10);
  });

  it('Xuất kho (Outflow) phải ném InsufficientStockError nếu updateMany trả về count 0 (chống tồn âm & race condition)', async () => {
    (prisma.warehouse.findFirst as jest.Mock).mockResolvedValue({ id: 1, storeId: 1, isDefault: true, isActive: true });
    (prisma.stockItem.findFirst as jest.Mock).mockResolvedValue({ id: 10, storeId: 1, sku: 'SKU-01', isActive: true });
    (prisma.inventoryBalance.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.inventoryBalance.findUnique as jest.Mock).mockResolvedValue({ id: 5, quantity: 5 }); // Chỉ có 5

    await expect(
      inventoryService.outflow(1, 100, {
        items: [{ stockItemId: 10, quantity: 15 }], // Muốn xuất 15
      })
    ).rejects.toThrow(InsufficientStockError);
  });
});
