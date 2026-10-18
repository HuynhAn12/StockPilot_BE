/**
 * seed_orders_may_oct.ts
 * Tạo đơn hàng lịch sử từ tháng 5 đến tháng 10 (năm 2026) cho store ID 4.
 * Mỗi tháng: 1200–2000 đơn ngẫu nhiên, tổng giá trị mỗi đơn ≤ 1.200.000 VND.
 * Đồng bộ đầy đủ: Order, OrderItem, Payment, StockMovement (OUTFLOW), InventoryBalance, DailySalesSummary.
 *
 * Chạy: npx tsx scripts/seed_orders_may_oct.ts
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const STORE_ID = 4;
const WAREHOUSE_ID = 4;
const MAX_ORDER_VALUE = 1_200_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randDate(year: number, month: number): Date {
  // month is 1-indexed
  const daysInMonth = new Date(year, month, 0).getDate();
  const day = randInt(1, daysInMonth);
  const hour = randInt(7, 21);
  const minute = randInt(0, 59);
  const second = randInt(0, 59);
  // Create date in local time then treat as UTC for storage
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute, second)); // offset for UTC+7
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface StockItemInfo {
  id: number;
  sku: string;
  name: string;
  sellingPrice: number;
  costPrice: number;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== BẮT ĐẦU SEED ĐƠN HÀNG LỊCH SỬ (Tháng 5 -> 10/2026) ===\n');

  // 1. Load all active stock items for store 4
  const rawItems = await prisma.stockItem.findMany({
    where: { storeId: STORE_ID, isActive: true },
    select: { id: true, sku: true, name: true, sellingPrice: true, costPrice: true },
  });

  const stockItems: StockItemInfo[] = rawItems.map(item => ({
    id: item.id,
    sku: item.sku,
    name: item.name,
    sellingPrice: Number(item.sellingPrice),
    costPrice: Number(item.costPrice),
  }));

  console.log(`Tim thay ${stockItems.length} san pham active trong store ${STORE_ID}\n`);
  if (stockItems.length === 0) throw new Error('Khong co san pham nao!');

  // 2. Load inventory balances (to track stock during seeding)
  const balanceMap = new Map<number, number>(); // stockItemId -> quantity

  const balances = await prisma.inventoryBalance.findMany({
    where: { storeId: STORE_ID, warehouseId: WAREHOUSE_ID },
    select: { id: true, stockItemId: true, quantity: true },
  });
  for (const b of balances) {
    balanceMap.set(b.stockItemId, b.quantity);
  }

  // 3. Monthly config
  const months = [
    { year: 2026, month: 5 },
    { year: 2026, month: 6 },
    { year: 2026, month: 7 },
    { year: 2026, month: 8 },
    { year: 2026, month: 9 },
    { year: 2026, month: 10 },
  ];

  let totalOrdersCreated = 0;
  let globalOrderCounter = 100000;

  // Maps for DailySalesSummary accumulation
  const dailyMap = new Map<string, {
    storeId: number;
    stockItemId: number;
    summaryDate: Date;
    grossSoldQty: number;
    grossRevenue: number;
    cogs: number;
    orderCount: number;
  }>();

  // All stock movements to insert in bulk
  const movementsToInsert: Prisma.StockMovementCreateManyInput[] = [];

  // 5. Process each month
  for (const { year, month } of months) {
    const monthLabel = `${year}-${String(month).padStart(2, '0')}`;
    const ordersThisMonth = randInt(1200, 2000);
    console.log(`[${monthLabel}] Tao ${ordersThisMonth} don hang...`);

    let monthTotal = 0;

    for (let i = 0; i < ordersThisMonth; i++) {
      globalOrderCounter++;
      const orderDate = randDate(year, month);
      const dateKey = orderDate.toISOString().slice(0, 10);
      const orderNumber = `ORD-${year}${String(month).padStart(2, '0')}-${String(globalOrderCounter).padStart(6, '0')}`;

      // Build order items
      const shuffled = shuffle([...stockItems]);
      const pickedItems: Array<{ item: StockItemInfo; qty: number; subtotal: number }> = [];
      let remainingBudget = MAX_ORDER_VALUE;
      const maxItems = randInt(1, Math.min(8, shuffled.length));

      for (const item of shuffled) {
        if (pickedItems.length >= maxItems) break;
        if (remainingBudget <= 0) break;
        if (item.sellingPrice > remainingBudget) continue;

        const maxQtyByBudget = Math.floor(remainingBudget / item.sellingPrice);
        const qty = randInt(1, Math.min(maxQtyByBudget, 10));
        const subtotal = qty * item.sellingPrice;

        pickedItems.push({ item, qty, subtotal });
        remainingBudget -= subtotal;
      }

      if (pickedItems.length === 0) continue;

      const subtotalAmount = pickedItems.reduce((sum, p) => sum + p.subtotal, 0);
      const totalAmount = subtotalAmount;

      try {
        const order = await prisma.order.create({
          data: {
            storeId: STORE_ID,
            orderNumber,
            status: 'FULFILLED',
            subtotalAmount,
            discountAmount: 0,
            taxAmount: 0,
            totalAmount,
            confirmedAt: orderDate,
            fulfilledAt: orderDate,
            createdAt: orderDate,
            updatedAt: orderDate,
            items: {
              create: pickedItems.map(({ item, qty, subtotal }) => ({
                storeId: STORE_ID,
                stockItemId: item.id,
                skuSnapshot: item.sku,
                nameSnapshot: item.name,
                unitPriceSnapshot: item.sellingPrice,
                costPriceSnapshot: item.costPrice,
                quantity: qty,
                refundableAmount: subtotal,
                refundedAmount: 0,
                returnedQuantity: 0,
                subtotal,
                createdAt: orderDate,
              })),
            },
            payments: {
              create: {
                storeId: STORE_ID,
                provider: 'CASH',
                method: 'CASH',
                amount: totalAmount,
                currency: 'VND',
                status: 'PAID',
                paidAt: orderDate,
                createdAt: orderDate,
                updatedAt: orderDate,
              },
            },
          },
        });

        // Prepare stock movements and accumulate daily summaries
        for (const { item, qty, subtotal } of pickedItems) {
          const beforeQty = balanceMap.get(item.id) ?? 500;
          const afterQty = Math.max(0, beforeQty - qty);
          balanceMap.set(item.id, afterQty);

          movementsToInsert.push({
            storeId: STORE_ID,
            warehouseId: WAREHOUSE_ID,
            stockItemId: item.id,
            type: 'ORDER_FULFILL',
            delta: -qty,
            beforeQuantity: beforeQty,
            afterQuantity: afterQty,
            referenceType: 'order',
            referenceId: String(order.id),
            note: `Ban hang don ${orderNumber}`,
            createdAt: orderDate,
          });

          // DailySalesSummary accumulation
          const summaryKey = `${item.id}_${dateKey}`;
          const existing = dailyMap.get(summaryKey);
          const itemCogs = item.costPrice * qty;
          if (existing) {
            existing.grossSoldQty += qty;
            existing.grossRevenue += subtotal;
            existing.cogs += itemCogs;
            existing.orderCount += 1;
          } else {
            const [y, m, d] = dateKey.split('-').map(Number);
            dailyMap.set(summaryKey, {
              storeId: STORE_ID,
              stockItemId: item.id,
              summaryDate: new Date(Date.UTC(y, m - 1, d)),
              grossSoldQty: qty,
              grossRevenue: subtotal,
              cogs: itemCogs,
              orderCount: 1,
            });
          }
        }

        monthTotal += totalAmount;
        totalOrdersCreated++;
      } catch (err: any) {
        if (err.code === 'P2002') continue;
        throw err;
      }
    }

    console.log(`  OK ${monthLabel}: Tong doanh thu ~${(monthTotal / 1_000_000).toFixed(1)}M VND`);
  }

  console.log(`\nTong don da tao: ${totalOrdersCreated}`);

  // 6. Bulk insert stock movements
  console.log(`\nChen ${movementsToInsert.length} stock movements...`);
  const BATCH = 500;
  for (let i = 0; i < movementsToInsert.length; i += BATCH) {
    await prisma.stockMovement.createMany({
      data: movementsToInsert.slice(i, i + BATCH),
      skipDuplicates: true,
    });
  }
  console.log('  OK Stock movements xong');

  // 7. Update InventoryBalance
  console.log('\nCap nhat InventoryBalance...');
  let updatedBalances = 0;
  for (const [stockItemId, newQty] of balanceMap.entries()) {
    await prisma.inventoryBalance.updateMany({
      where: { storeId: STORE_ID, warehouseId: WAREHOUSE_ID, stockItemId },
      data: { quantity: Math.max(0, newQty) },
    });
    updatedBalances++;
  }
  console.log(`  OK Cap nhat ${updatedBalances} inventory balances`);

  // 8. Upsert DailySalesSummary
  console.log(`\nCap nhat DailySalesSummary (${dailyMap.size} ban ghi)...`);
  let dssCount = 0;
  for (const entry of dailyMap.values()) {
    const netRevenue = entry.grossRevenue;
    const grossProfit = netRevenue - entry.cogs;

    await prisma.dailySalesSummary.upsert({
      where: {
        storeId_stockItemId_summaryDate: {
          storeId: entry.storeId,
          stockItemId: entry.stockItemId,
          summaryDate: entry.summaryDate,
        },
      },
      update: {
        grossSoldQty: { increment: entry.grossSoldQty },
        netSoldQty: { increment: entry.grossSoldQty },
        grossRevenue: { increment: entry.grossRevenue },
        netRevenue: { increment: netRevenue },
        cogs: { increment: entry.cogs },
        grossProfit: { increment: grossProfit },
        orderCount: { increment: entry.orderCount },
      },
      create: {
        storeId: entry.storeId,
        stockItemId: entry.stockItemId,
        summaryDate: entry.summaryDate,
        grossSoldQty: entry.grossSoldQty,
        returnQty: 0,
        netSoldQty: entry.grossSoldQty,
        grossRevenue: entry.grossRevenue,
        refundAmount: 0,
        netRevenue,
        cogs: entry.cogs,
        grossProfit,
        historicalCostMissingQty: 0,
        orderCount: entry.orderCount,
      },
    });
    dssCount++;
    if (dssCount % 1000 === 0) {
      console.log(`  ... ${dssCount}/${dailyMap.size} DSS upserted`);
    }
  }
  console.log(`  OK DailySalesSummary xong: ${dssCount} ban ghi`);

  console.log('\n=== SEED HOAN TAT! ===\n');
  console.log(`Tong don hang da tao: ${totalOrdersCreated}`);
  console.log(`Stock movements:       ${movementsToInsert.length}`);
  console.log(`Inventory balances:    ${updatedBalances}`);
  console.log(`Daily sales summaries: ${dssCount}`);
}

main()
  .catch(err => {
    console.error('LOI:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
