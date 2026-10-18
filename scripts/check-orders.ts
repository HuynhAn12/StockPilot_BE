import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const cnt = await p.order.count({ where: { storeId: 4 } });
  console.log('Orders remaining:', cnt);
  const today = await p.order.count({ where: { storeId: 4, status: 'FULFILLED', fulfilledAt: { gte: new Date('2026-10-17T00:00:00+07:00'), lte: new Date('2026-10-17T23:59:59+07:00') } } });
  console.log('Orders today (17/10):', today);
  const may = await p.order.count({ where: { storeId: 4, status: 'FULFILLED', fulfilledAt: { gte: new Date('2026-05-01'), lte: new Date('2026-05-31T23:59:59') } } });
  console.log('Orders May:', may);
  const future = await p.order.count({ where: { storeId: 4, fulfilledAt: { gt: new Date('2026-10-17T16:59:59Z') } } });
  console.log('Future orders (>17/10):', future);
}
main().catch(console.error).finally(() => p.$disconnect());
