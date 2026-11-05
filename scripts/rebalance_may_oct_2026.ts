/**
 * rebalance_may_oct_2026.ts
 * Ði?u ch?nh gi?m d? li?u Tháng 5 -> Tháng 10/2026 v? m?c h?p lý, d?ng b? v?i 2025 và d?u 2026.
 * Thay th? 9.440 don cu giá tr? ?o (~1-1.2 t?/tháng) b?ng ~800-850 don/tháng (~250-265 tri?u/tháng).
 * Gi? nguyên các don POS th?c t? và t?n kho hi?n t?i.
 */

import { PrismaClient, Prisma, PaymentMethod, PaymentProvider } from '@prisma/client';

const prisma = new PrismaClient();
const STORE_ID = 1;

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randDate(year: number, month: number, day: number): Date {
  const hour = randInt(7, 21);
  const minute = randInt(0, 59);
  const second = randInt(0, 59);
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute, second));
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface StockItemInfo {
  id: number;
  sku: string;
  name: string;
  sellingPrice: number;
  costPrice: number;
}

async function main() {
  console.log('=== B?T Ð?U ÐI?U CH?NH L?I D? LI?U THÁNG 5 -> 10/2026 ===\n');

  // 1. T?i danh sách s?n ph?m
  const rawItems = await prisma.stockItem.findMany({
    where: { storeId: STORE_ID, isActive: true },
    select: { id: true, sku: true, name: true, sellingPrice: true, costPrice: true },
  });

  const stockItems: StockItemInfo[] = rawItems.map(item => ({
    id: item.id,
    sku: item.sku,
    name: item.name,
    sellingPrice: Number(item.sellingPrice) || 10000,
    costPrice: Number(item.costPrice) || 7000,
  }));

  // 2. Tìm các don ORD cu t? T05 -> T10/2026
  console.log('Tìm các don hàng ORD cu t? tháng 5 d?n tháng 10/2026...');
  const oldOrders = await prisma.order.findMany({
    where: {
      storeId: STORE_ID,
      OR: [
        { orderNumber: { startsWith: 'ORD-202605' } },
        { orderNumber: { startsWith: 'ORD-202606' } },
        { orderNumber: { startsWith: 'ORD-202607' } },
        { orderNumber: { startsWith: 'ORD-202608' } },
        { orderNumber: { startsWith: 'ORD-202609' } },
        { orderNumber: { startsWith: 'ORD-202610' } },
      ]
    },
    select: { id: true }
  });

  const oldOrderIds = oldOrders.map(o => o.id);
  console.log(`Tìm th?y ${oldOrderIds.length} don ORD cu c?n thay th?.`);

  // 3. Xóa các don ORD cu (xóa theo lô)
  if (oldOrderIds.length > 0) {
    console.log('Ðang xóa orderItem, payment và order cu...');
    const CHUNK = 1000;
    for (let i = 0; i < oldOrderIds.length; i += CHUNK) {
      const ids = oldOrderIds.slice(i, i + CHUNK);
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.order.deleteMany({ where: { id: { in: ids } } });
    }
    console.log('Ðã xóa toàn b? don ORD cu thành công.');

    // Xóa stock movements tuong ?ng
    await prisma.stockMovement.deleteMany({
      where: {
        storeId: STORE_ID,
        OR: [
          { note: { startsWith: 'Ban hang don ORD-202605' } },
          { note: { startsWith: 'Ban hang don ORD-202606' } },
          { note: { startsWith: 'Ban hang don ORD-202607' } },
          { note: { startsWith: 'Ban hang don ORD-202608' } },
          { note: { startsWith: 'Ban hang don ORD-202609' } },
          { note: { startsWith: 'Ban hang don ORD-202610' } },
        ]
      }
    });
  }

  // 4. Xóa DailySalesSummary trong kho?ng 2026-05-01 d?n 2026-10-31
  console.log('Xóa DailySalesSummary cu giai do?n 2026-05 d?n 2026-10...');
  const delDss = await prisma.dailySalesSummary.deleteMany({
    where: {
      storeId: STORE_ID,
      summaryDate: {
        gte: new Date('2026-05-01T00:00:00Z'),
        lte: new Date('2026-10-31T23:59:59Z')
      }
    }
  });
  console.log(`Ðã xóa ${delDss.count} b?n ghi DailySalesSummary cu.`);

  // 5. Xác d?nh ID b?t d?u
  const maxOrder = await prisma.order.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
  const maxItem = await prisma.orderItem.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
  const maxPay = await prisma.payment.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });

  let curOrderId = (maxOrder?.id ?? 0) + 1;
  let curItemId = (maxItem?.id ?? 0) + 1;
  let curPayId = (maxPay?.id ?? 0) + 1;
  let orderNumberCounter = 20000;

  console.log(`ID m?i b?t d?u: Order = ${curOrderId}, OrderItem = ${curItemId}, Payment = ${curPayId}\n`);

  // 6. Map t?ng h?p DailySalesSummary
  const dailyMap = new Map<string, {
    storeId: number;
    stockItemId: number;
    summaryDate: Date;
    grossSoldQty: number;
    grossRevenue: number;
    cogs: number;
    orderCount: number;
  }>();

  // Ð?c l?i các don POS th?c t? trong T05 -> T10 n?u có d? dua vào dailyMap
  const existingPosOrders = await prisma.order.findMany({
    where: {
      storeId: STORE_ID,
      createdAt: { gte: new Date('2026-05-01T00:00:00Z'), lte: new Date('2026-10-31T23:59:59Z') }
    },
    include: { items: true }
  });

  for (const posOrder of existingPosOrders) {
    const dateKey = posOrder.createdAt.toISOString().slice(0, 10);
    const [y, m, d] = dateKey.split('-').map(Number);
    for (const item of posOrder.items) {
      const sumKey = `${item.stockItemId}_${dateKey}`;
      const qty = item.quantity;
      const subtotal = Number(item.subtotal || 0);
      const costTotal = qty * Number(item.costPriceSnapshot || 0);

      const existing = dailyMap.get(sumKey);
      if (existing) {
        existing.grossSoldQty += qty;
        existing.grossRevenue += subtotal;
        existing.cogs += costTotal;
        existing.orderCount += 1;
      } else {
        dailyMap.set(sumKey, {
          storeId: STORE_ID,
          stockItemId: item.stockItemId,
          summaryDate: new Date(Date.UTC(y, m - 1, d)),
          grossSoldQty: qty,
          grossRevenue: subtotal,
          cogs: costTotal,
          orderCount: 1,
        });
      }
    }
  }

  // 7. T?o don hàng m?i h?p lý cho Tháng 5 -> 10/2026
  const months = [5, 6, 7, 8, 9, 10];
  let totalNewOrders = 0;
  let totalNewRevenue = 0;

  for (const month of months) {
    const year = 2026;
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const daysInMonth = new Date(year, month, 0).getDate();

    const ordersToInsert: Prisma.OrderCreateManyInput[] = [];
    const itemsToInsert: Prisma.OrderItemCreateManyInput[] = [];
    const paymentsToInsert: Prisma.PaymentCreateManyInput[] = [];

    let monthRevenue = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      const dayOfWeek = new Date(year, month - 1, day).getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

      // M?i ngày: ngày thu?ng 20-30 don, cu?i tu?n 28-42 don
      const dailyCount = isWeekend ? randInt(28, 42) : randInt(20, 30);

      for (let o = 0; o < dailyCount; o++) {
        const orderId = curOrderId++;
        const orderDate = randDate(year, month, day);
        const dateKey = orderDate.toISOString().slice(0, 10);
        orderNumberCounter++;
        const orderNumber = `ORD-${year}${String(month).padStart(2, '0')}-${String(orderNumberCounter).padStart(6, '0')}`;

        // 1-5 s?n ph?m
        const numItems = randInt(1, Math.min(5, stockItems.length));
        const shuffled = shuffle([...stockItems]);
        const chosen = shuffled.slice(0, numItems);

        let orderSubtotal = 0;

        for (const item of chosen) {
          const itemId = curItemId++;
          const qty = randInt(1, 4);
          const subtotal = qty * item.sellingPrice;
          const costTotal = qty * item.costPrice;
          orderSubtotal += subtotal;

          itemsToInsert.push({
            id: itemId,
            storeId: STORE_ID,
            orderId,
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
          });

          // Tích luy DailySalesSummary
          const sumKey = `${item.id}_${dateKey}`;
          const existing = dailyMap.get(sumKey);
          if (existing) {
            existing.grossSoldQty += qty;
            existing.grossRevenue += subtotal;
            existing.cogs += costTotal;
            existing.orderCount += 1;
          } else {
            const [y, m, d] = dateKey.split('-').map(Number);
            dailyMap.set(sumKey, {
              storeId: STORE_ID,
              stockItemId: item.id,
              summaryDate: new Date(Date.UTC(y, m - 1, d)),
              grossSoldQty: qty,
              grossRevenue: subtotal,
              cogs: costTotal,
              orderCount: 1,
            });
          }
        }

        const isBankTransfer = Math.random() < 0.35;
        const method: PaymentMethod = isBankTransfer ? 'BANK_TRANSFER' : 'CASH';
        const provider: PaymentProvider = isBankTransfer ? 'PAYOS' : 'CASH';

        ordersToInsert.push({
          id: orderId,
          storeId: STORE_ID,
          orderNumber,
          status: 'FULFILLED',
          subtotalAmount: orderSubtotal,
          discountAmount: 0,
          taxAmount: 0,
          totalAmount: orderSubtotal,
          confirmedAt: orderDate,
          fulfilledAt: orderDate,
          createdAt: orderDate,
          updatedAt: orderDate,
        });

        paymentsToInsert.push({
          id: curPayId++,
          storeId: STORE_ID,
          orderId,
          provider,
          method,
          amount: orderSubtotal,
          currency: 'VND',
          status: 'PAID',
          paidAt: orderDate,
          createdAt: orderDate,
          updatedAt: orderDate,
        });

        monthRevenue += orderSubtotal;
        totalNewOrders++;
      }
    }

    totalNewRevenue += monthRevenue;

    const BATCH_SIZE = 500;
    for (let i = 0; i < ordersToInsert.length; i += BATCH_SIZE) {
      await prisma.order.createMany({ data: ordersToInsert.slice(i, i + BATCH_SIZE), skipDuplicates: true });
    }
    for (let i = 0; i < itemsToInsert.length; i += BATCH_SIZE) {
      await prisma.orderItem.createMany({ data: itemsToInsert.slice(i, i + BATCH_SIZE), skipDuplicates: true });
    }
    for (let i = 0; i < paymentsToInsert.length; i += BATCH_SIZE) {
      await prisma.payment.createMany({ data: paymentsToInsert.slice(i, i + BATCH_SIZE), skipDuplicates: true });
    }

    console.log(`[Thành công] Tháng ${monthStr}: dã t?o ${ordersToInsert.length} don | Doanh thu: ${(monthRevenue / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tri?u VNÐ`);
  }

  console.log(`\nT?ng don m?i t?o (T05 -> T10): ${totalNewOrders.toLocaleString('vi-VN')} don`);
  console.log(`T?ng doanh thu m?i: ${(totalNewRevenue / 1_000_000_000).toFixed(2)} t? VNÐ\n`);

  // 8. C?p nh?t b?ng DailySalesSummary theo lô
  console.log(`Ðang d?ng b? DailySalesSummary (${dailyMap.size.toLocaleString('vi-VN')} b?n ghi)...`);
  const dailyEntries = Array.from(dailyMap.values());
  const DSS_BATCH = 100;

  for (let i = 0; i < dailyEntries.length; i += DSS_BATCH) {
    const chunk = dailyEntries.slice(i, i + DSS_BATCH);
    await Promise.all(chunk.map(entry => {
      const netRevenue = entry.grossRevenue;
      const grossProfit = netRevenue - entry.cogs;

      return prisma.dailySalesSummary.upsert({
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
          orderCount: entry.orderCount,
        },
      });
    }));

    if ((i + DSS_BATCH) % 2000 === 0 || i + DSS_BATCH >= dailyEntries.length) {
      console.log(`  Ðã x? lý ${Math.min(i + DSS_BATCH, dailyEntries.length)} / ${dailyEntries.length} b?n ghi DailySalesSummary...`);
    }
  }

  console.log('\n=== HOÀN T?T ÐI?U CH?NH & Ð?NG B? D? LI?U ===');
}

main()
  .catch(e => {
    console.error('L?I:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
