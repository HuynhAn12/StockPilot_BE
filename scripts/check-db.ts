import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const stores = await p.store.findMany({ select: { id: true, name: true, code: true } });
  console.log('STORES:', JSON.stringify(stores, null, 2));
  const warehouses = await p.warehouse.findMany({ select: { id: true, storeId: true, name: true, isDefault: true } });
  console.log('WAREHOUSES:', JSON.stringify(warehouses, null, 2));
  const cnt = await p.stockItem.count({ where: { storeId: 4 } });
  console.log('TOTAL ITEMS store 4:', cnt);
  const sample = await p.stockItem.findMany({ where: { storeId: 4 }, select: { id: true, sku: true, name: true, sellingPrice: true }, take: 5 });
  console.log('SAMPLE:', JSON.stringify(sample, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
