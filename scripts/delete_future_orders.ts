/**
 * delete_future_orders.ts
 * Xóa tất cả đơn hàng có fulfilledAt/createdAt sau ngày 17/10/2026 (cuối ngày UTC+7)
 * Đồng thời rollback InventoryBalance và xóa DailySalesSummary liên quan.
 *
 * Chạy: npx tsx scripts/delete_future_orders.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const STORE_ID = 4;
const WAREHOUSE_ID = 4;

// Cutoff: end of 2026-10-17 in UTC+7 = 2026-10-17T23:59:59+07:00 = 2026-10-17T16:59:59Z
const CUTOFF_DATE = new Date('2026-10-17T16:59:59.999Z');

async function main() {
  console.log(`=== XÓA ĐƠN HÀNG SAU ${CUTOFF_DATE.toISOString()} ===\n`);

  // 1. Tìm các đơn cần xóa
  const futureOrders = await prisma.order.findMany({
    where: {
      storeId: STORE_ID,
      OR: [
        { fulfilledAt: { gt: CUTOFF_DATE } },
        { createdAt: { gt: CUTOFF_DATE } },
      ],
    },
    select: {
      id: true,
      orderNumber: true,
      fulfilledAt: true,
      createdAt: true,
      items: {
        select: {
          stockItemId: true,
          quantity: true,
          subtotal: true,
          unitPriceSnapshot: true,
          costPriceSnapshot: true,
        }
      }
    },
  });

  console.log(`Tìm thấy ${futureOrders.length} đơn hàng cần xóa\n`);

  if (futureOrders.length === 0) {
    console.log('Không có đơn nào cần xóa!');
    return;
  }

  // 2. Tính lượng tồn kho cần hoàn lại (INFLOW back)
  const restoreMap = new Map<number, number>(); // stockItemId -> qty to restore
  for (const order of futureOrders) {
    for (const item of order.items) {
      restoreMap.set(item.stockItemId, (restoreMap.get(item.stockItemId) ?? 0) + item.quantity);
    }
  }

  // 3. Lấy số lượng tồn kho hiện tại
  const balances = await prisma.inventoryBalance.findMany({
    where: { storeId: STORE_ID, warehouseId: WAREHOUSE_ID },
    select: { stockItemId: true, quantity: true },
  });
  const balanceMap = new Map(balances.map(b => [b.stockItemId, b.quantity]));

  const orderIds = futureOrders.map(o => o.id);

  // 4. Xóa theo thứ tự: payments -> stockMovements -> orderItems -> orders
  console.log('Xóa payments...');
  const delPayments = await prisma.payment.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  console.log(`  ✓ Đã xóa ${delPayments.count} payments`);

  console.log('Xóa stock movements...');
  const delMov = await prisma.stockMovement.deleteMany({
    where: {
      storeId: STORE_ID,
      referenceType: 'order',
      referenceId: { in: orderIds.map(String) },
    },
  });
  console.log(`  ✓ Đã xóa ${delMov.count} stock movements`);

  console.log('Xóa order items...');
  const delItems = await prisma.orderItem.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  console.log(`  ✓ Đã xóa ${delItems.count} order items`);

  console.log('Xóa orders...');
  const delOrders = await prisma.order.deleteMany({
    where: { id: { in: orderIds } },
  });
  console.log(`  ✓ Đã xóa ${delOrders.count} orders`);

  // 5. Xóa DailySalesSummary cho các ngày > CUTOFF
  const cutoffDateOnly = new Date('2026-10-18T00:00:00.000Z'); // UTC date for 18/10+
  console.log('\nXóa DailySalesSummary sau ngày 17/10...');
  const delDSS = await prisma.dailySalesSummary.deleteMany({
    where: {
      storeId: STORE_ID,
      summaryDate: { gt: new Date('2026-10-17T00:00:00.000Z') },
    },
  });
  console.log(`  ✓ Đã xóa ${delDSS.count} daily summaries`);

  // 6. Hoàn lại tồn kho
  console.log('\nHoàn lại tồn kho (inventory restore)...');
  let restored = 0;
  for (const [stockItemId, qty] of restoreMap.entries()) {
    const current = balanceMap.get(stockItemId) ?? 0;
    await prisma.inventoryBalance.updateMany({
      where: { storeId: STORE_ID, warehouseId: WAREHOUSE_ID, stockItemId },
      data: { quantity: current + qty },
    });
    restored++;
  }
  console.log(`  ✓ Đã hoàn lại tồn kho cho ${restored} sản phẩm`);

  console.log('\n=== HOÀN TẤT ===');
  console.log(`Orders đã xóa:          ${delOrders.count}`);
  console.log(`Order items đã xóa:     ${delItems.count}`);
  console.log(`Payments đã xóa:        ${delPayments.count}`);
  console.log(`Stock movements xóa:    ${delMov.count}`);
  console.log(`Daily summaries xóa:    ${delDSS.count}`);
  console.log(`Inventory đã restore:   ${restored} sản phẩm`);
}

main()
  .catch(err => {
    console.error('LỖI:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
