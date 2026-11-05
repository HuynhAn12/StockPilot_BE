/**
 * seed_orders_2025_to_apr2026.ts
 * T?o don hàng l?ch s? t? Tháng 1/2025 d?n Tháng 4/2026 (16 tháng) cho Store 1.
 * Ð?m b?o d?ng b? Order, OrderItem, Payment, DailySalesSummary.
 * Gi? nguyên t?n kho hi?n t?i (InventoryBalance) c?a c?a hàng.
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
  // UTC+7 offset for Vietnam time
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
  console.log('=== B?T Ð?U T?O D? LI?U ÐON HÀNG T? THÁNG 1/2025 Ð?N THÁNG 4/2026 ===\n');

  // 1. Ki?m tra s?n ph?m
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

  console.log(`Ðã t?i ${stockItems.length} s?n ph?m dang bán c?a Store ID ${STORE_ID}`);
  if (stockItems.length === 0) throw new Error('Không tìm th?y s?n ph?m!');

  // 2. Tìm ID l?n nh?t hi?n t?i
  const maxOrder = await prisma.order.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
  const maxItem = await prisma.orderItem.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
  const maxPay = await prisma.payment.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });

  let curOrderId = (maxOrder?.id ?? 0) + 1;
  let curItemId = (maxItem?.id ?? 0) + 1;
  let curPayId = (maxPay?.id ?? 0) + 1;
  let orderNumberCounter = 1000;

  console.log(`B?t d?u ID: Order = ${curOrderId}, OrderItem = ${curItemId}, Payment = ${curPayId}\n`);

  // 3. Danh sách 16 tháng: t? 01/2025 -> 04/2026
  const months: Array<{ year: number; month: number }> = [];
  // Nam 2025: tháng 1 d?n 12
  for (let m = 1; m <= 12; m++) {
    months.push({ year: 2025, month: m });
  }
  // Nam 2026: tháng 1 d?n 4
  for (let m = 1; m <= 4; m++) {
    months.push({ year: 2026, month: m });
  }

  // Map t?ng h?p DailySalesSummary
  // Key: `${stockItemId}_${dateKey}` (dateKey: YYYY-MM-DD)
  const dailyMap = new Map<string, {
    storeId: number;
    stockItemId: number;
    summaryDate: Date;
    grossSoldQty: number;
    grossRevenue: number;
    cogs: number;
    orderCount: number;
  }>();

  let totalOrders = 0;
  let totalRevenueAll = 0;

  // 4. Sinh d? li?u theo t?ng tháng
  for (const { year, month } of months) {
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const daysInMonth = new Date(year, month, 0).getDate();

    const ordersToInsert: Prisma.OrderCreateManyInput[] = [];
    const itemsToInsert: Prisma.OrderItemCreateManyInput[] = [];
    const paymentsToInsert: Prisma.PaymentCreateManyInput[] = [];

    let monthRevenue = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      const dayOfWeek = new Date(year, month - 1, day).getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      
      // S? don hàng m?i ngày: ngày thu?ng 20-30 don, cu?i tu?n 28-42 don
      const dailyOrdersCount = isWeekend ? randInt(28, 42) : randInt(20, 30);

      for (let o = 0; o < dailyOrdersCount; o++) {
        const orderId = curOrderId++;
        const orderDate = randDate(year, month, day);
        const dateKey = orderDate.toISOString().slice(0, 10);
        orderNumberCounter++;
        const orderNumber = `ORD-${year}${String(month).padStart(2, '0')}-${String(orderNumberCounter).padStart(6, '0')}`;

        // Ch?n 1-5 s?n ph?m ng?u nhiên cho don
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
        totalOrders++;
      }
    }

    totalRevenueAll += monthRevenue;

    // Chèn theo lô cho t?ng tháng
    const BATCH_SIZE = 500;

    for (let i = 0; i < ordersToInsert.length; i += BATCH_SIZE) {
      await prisma.order.createMany({
        data: ordersToInsert.slice(i, i + BATCH_SIZE),
        skipDuplicates: true,
      });
    }

    for (let i = 0; i < itemsToInsert.length; i += BATCH_SIZE) {
      await prisma.orderItem.createMany({
        data: itemsToInsert.slice(i, i + BATCH_SIZE),
        skipDuplicates: true,
      });
    }

    for (let i = 0; i < paymentsToInsert.length; i += BATCH_SIZE) {
      await prisma.payment.createMany({
        data: paymentsToInsert.slice(i, i + BATCH_SIZE),
        skipDuplicates: true,
      });
    }

    console.log(`[Thành công] Tháng ${monthStr}: dã t?o ${ordersToInsert.length} don hàng | Doanh thu: ${(monthRevenue / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tri?u VNÐ`);
  }

  console.log(`\nT?ng s? don hàng dã t?o: ${totalOrders.toLocaleString('vi-VN')}`);
  console.log(`T?ng doanh thu 16 tháng: ${(totalRevenueAll / 1_000_000_000).toFixed(2)} t? VNÐ\n`);

  // 5. C?p nh?t b?ng DailySalesSummary theo lô nh? 100 d? tránh quá t?i connection pool
  console.log(`B?t d?u d?ng b? DailySalesSummary (${dailyMap.size.toLocaleString('vi-VN')} b?n ghi ngày)...`);
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

  console.log('\n=== HOÀN T?T Ð?NG B? D? LI?U ÐON HÀNG 2025 -> 04/2026 ===');
}

main()
  .catch((e) => {
    console.error('L?I KHI T?O ÐON:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
