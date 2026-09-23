import { maskSensitiveFields } from '../src/common/middleware/sensitive-fields';

describe('Data Masking - Ẩn trường nhạy cảm cho Warehouse Staff', () => {
  const sampleProduct = {
    id: 1,
    name: 'Áo Thun Cao Cấp',
    stockItems: [
      {
        id: 10,
        sku: 'AT-01',
        sellingPrice: 250000,
        costPrice: 100000, // Nhạy cảm
      },
    ],
  };

  const sampleOrderItem = {
    id: 100,
    skuSnapshot: 'AT-01',
    unitPriceSnapshot: 250000,
    costPriceSnapshot: 100000, // Nhạy cảm
    quantity: 2,
    subtotal: 500000,
  };

  const sampleBalanceWithSingularStockItem = {
    id: 50,
    warehouseId: 1,
    quantity: 20,
    stockItem: {
      id: 10,
      sku: 'AT-01',
      costPrice: 100000, // Nhạy cảm
      sellingPrice: 250000,
      product: {
        id: 1,
        name: 'Áo Thun Cao Cấp',
      },
    },
  };

  const sampleMovementWithDeepNesting = {
    id: 99,
    type: 'INFLOW',
    delta: 10,
    stockItem: {
      sku: 'AT-01',
      costPrice: 100000, // Nhạy cảm
    },
  };

  it('Shop Owner và Admin được phép xem đầy đủ giá vốn', () => {
    const ownerView = maskSensitiveFields(sampleProduct, 'SHOP_OWNER');
    expect(ownerView.stockItems[0].costPrice).toBe(100000);

    const adminView = maskSensitiveFields(sampleProduct, 'ADMIN');
    expect(adminView.stockItems[0].costPrice).toBe(100000);

    const ownerBalanceView = maskSensitiveFields(sampleBalanceWithSingularStockItem, 'SHOP_OWNER');
    expect(ownerBalanceView.stockItem.costPrice).toBe(100000);
  });

  it('Warehouse Staff tuyệt đối không thấy costPrice và costPriceSnapshot ở danh sách', () => {
    const staffProductView = maskSensitiveFields(sampleProduct, 'WAREHOUSE_STAFF');
    expect(staffProductView.stockItems[0].sellingPrice).toBe(250000);
    expect(staffProductView.stockItems[0].costPrice).toBeUndefined();

    const staffOrderView = maskSensitiveFields(sampleOrderItem, 'WAREHOUSE_STAFF');
    expect(staffOrderView.unitPriceSnapshot).toBe(250000);
    expect(staffOrderView.costPriceSnapshot).toBeUndefined();
  });

  it('Warehouse Staff bị ẩn costPrice trên object stockItem đơn lẻ và cấu trúc lồng sâu', () => {
    const staffBalanceView = maskSensitiveFields(sampleBalanceWithSingularStockItem, 'WAREHOUSE_STAFF');
    expect(staffBalanceView.quantity).toBe(20);
    expect(staffBalanceView.stockItem.sellingPrice).toBe(250000);
    expect(staffBalanceView.stockItem.costPrice).toBeUndefined();

    const staffMovementView = maskSensitiveFields(sampleMovementWithDeepNesting, 'WAREHOUSE_STAFF');
    expect(staffMovementView.type).toBe('INFLOW');
    expect(staffMovementView.stockItem.sku).toBe('AT-01');
    expect(staffMovementView.stockItem.costPrice).toBeUndefined();
  });
});
