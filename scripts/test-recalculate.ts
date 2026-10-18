import { DecisionEngineService } from '../src/modules/decision-engine/decision-engine.service';
import { prisma } from '../src/config/db';

async function main() {
  try {
    const service = new DecisionEngineService();
    const stockItems = await prisma.stockItem.findMany({
      where: { storeId: 4 },
      include: { balances: true },
    });

    for (const item of stockItems) {
      console.log('--- SKU:', item.sku, item.name, '---');
      console.log('Balances:', item.balances);
      console.log('Cost:', item.costPrice, 'Sell:', item.sellingPrice, 'min:', item.minStockLevel, 'max:', item.maxStockLevel);
      const res = await service.analyzeSku(4, item.id, { persist: false });
      console.log('Available:', res.inventory.available, 'ReorderPoint:', res.coverage.reorderPoint);
      console.log('Risk:', JSON.stringify(res.risk, null, 2));
      console.log('Demand:', res.demand);
    }
  } catch (err: any) {
    console.error('Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
