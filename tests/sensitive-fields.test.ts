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

  it('Shop Owner và Admin được phép xem đầy đủ giá vốn', () => {
    const ownerView = maskSensitiveFields(sampleProduct, 'SHOP_OWNER');
    expect(ownerView.stockItems[0].costPrice).toBe(100000);

    const adminView = maskSensitiveFields(sampleProduct, 'ADMIN');
    expect(adminView.stockItems[0].costPrice).toBe(100000);
  });

  it('Warehouse Staff tuyệt đối không thấy costPrice và costPriceSnapshot', () => {
    const staffProductView = maskSensitiveFields(sampleProduct, 'WAREHOUSE_STAFF');
    expect(staffProductView.stockItems[0].sellingPrice).toBe(250000);
    expect(staffProductView.stockItems[0].costPrice).toBeUndefined();

    const staffOrderView = maskSensitiveFields(sampleOrderItem, 'WAREHOUSE_STAFF');
    expect(staffOrderView.unitPriceSnapshot).toBe(250000);
    expect(staffOrderView.costPriceSnapshot).toBeUndefined();
  });
});
