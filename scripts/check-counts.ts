import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

async function main() {
  const t0 = Date.now();
  const storeId = 4;
  const where: any = { storeId, status: { notIn: ['CANCELED'] } };
  const [rev, items, pay] = await Promise.all([
    p.order.aggregate({ where, _sum: { totalAmount: true }, _count: { id: true } }),
    p.orderItem.aggregate({ where: { order: where }, _sum: { quantity: true } }),
    p.payment.groupBy({ by: ['method'], where: { order: where }, _count: { _all: true }, _sum: { amount: true } })
  ]);
  console.log('TIME MS:', Date.now() - t0);
  console.log('REVENUE:', rev);
  console.log('ITEMS SOLD:', items);
  console.log('PAYMENTS:', pay);
}

main().finally(() => p.$disconnect());
