import { AssistantService, FINANCIAL_DATA_RESTRICTED_MESSAGE } from '../../src/modules/assistant/assistant.service';

const ITEMS = [
  { id: 1, sku: 'AO-01', name: 'Áo thun', costPrice: 80_000, sellingPrice: 150_000 },
  { id: 2, sku: 'QJ-01', name: 'Quần jean', costPrice: 200_000, sellingPrice: 350_000 },
  { id: 3, sku: 'NON-01', name: 'Nón', costPrice: 0, sellingPrice: 90_000 },
  { id: 4, sku: 'HET-01', name: 'Hết hàng', costPrice: 50_000, sellingPrice: 70_000 },
];
const BALANCES = [
  { stockItemId: 1, quantity: 10 }, // 800.000
  { stockItemId: 2, quantity: 3 }, // 600.000
  { stockItemId: 2, quantity: 2 }, // second warehouse → 1.000.000 total
  { stockItemId: 3, quantity: 4 }, // no cost price
  { stockItemId: 4, quantity: 0 },
];

function makeService(items = ITEMS, balances = BALANCES) {
  const prisma = {
    stockItem: {
      findMany: jest.fn(({ select }) =>
        Promise.resolve(select?.costPrice ? items : items.map(({ id, sku, name }) => ({ id, sku, name })))
      ),
    },
    inventoryBalance: { findMany: jest.fn().mockResolvedValue(balances) },
  };
  return { service: new AssistantService(prisma as any, { getSkuDecision: jest.fn() } as any), prisma };
}

describe('AssistantService cost-price intent', () => {
  it.each(['giá vốn hiện tại là bao nhiêu', 'Tổng giá trị tồn kho', 'giá nhập hàng hiện nay', 'vốn hàng trong kho còn bao nhiêu'])(
    'answers the owner with the inventory value at cost: "%s"',
    async (question) => {
      const { service } = makeService();
      const res = await service.answerQuestion(1, question, undefined, 'SHOP_OWNER');

      expect(res.answer).toContain('GIÁ VỐN & GIÁ TRỊ TỒN KHO HIỆN TẠI');
      expect(res.dataSnapshot).toMatchObject({
        totalInventoryCostValue: 1_800_000,
        totalQuantity: 19,
        stockedSkus: 3,
        missingCostSkus: ['NON-01'],
      });
      // Quần jean (1.000.000) ranks above Áo thun (800.000); out-of-stock items are left out.
      expect(res.dataSnapshot.topByCapital.map((i: { sku: string }) => i.sku)).toEqual(['QJ-01', 'AO-01', 'NON-01']);
      expect(res.answer).toContain('chưa nhập giá vốn');
      expect(res.answer).not.toContain('HET-01');
    }
  );

  it('refuses warehouse staff without reading cost data', async () => {
    const { service, prisma } = makeService();
    const res = await service.answerQuestion(1, 'giá vốn hiện tại là bao nhiêu', undefined, 'WAREHOUSE_STAFF');

    expect(res.answer).toBe(FINANCIAL_DATA_RESTRICTED_MESSAGE);
    expect(prisma.inventoryBalance.findMany).not.toHaveBeenCalled();
  });

  it('reports a zero value when nothing is in stock', async () => {
    const { service } = makeService(ITEMS, []);
    const res = await service.answerQuestion(1, 'giá vốn hiện tại', undefined, 'SHOP_OWNER');
    expect(res.answer).toContain('không còn hàng tồn');
    expect(res.dataSnapshot.totalInventoryCostValue).toBe(0);
  });

  it('leaves "dưới giá vốn" to the loss-making intent', async () => {
    const { service } = makeService();
    const res = await service.answerQuestion(1, 'hàng nào bán dưới giá vốn', undefined, 'SHOP_OWNER');
    expect(res.answer).not.toContain('GIÁ VỐN & GIÁ TRỊ TỒN KHO');
  });
});
