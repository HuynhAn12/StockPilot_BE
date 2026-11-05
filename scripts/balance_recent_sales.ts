/**
 * balance_recent_sales.ts
 * Bổ sung dữ liệu đơn hàng 30 ngày gần nhất (từ 18/10/2026 đến 03/11/2026) cho Cửa hàng 1
 * để biểu đồ doanh thu và hoạt động kinh doanh cân bằng, sống động, thực tế như đang hoạt động.
 *
 * Chạy: cd backend && npx tsx scripts/balance_recent_sales.ts
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const STORE_ID = 1;
const WAREHOUSE_ID = 1;

// Staff IDs for store 1
const STAFF_IDS = [1, 2, 4, 5];

// Realistic customer pool
const CUSTOMERS = [
  'Khách lẻ',
  'Khách lẻ',
  'Khách lẻ',
  'Khách lẻ',
  'Khách lẻ',
  'Nguyễn Văn Hùng',
  'Lê Thị Thu Thảo',
  'Phạm Minh Tuấn',
  'Hoàng Thị Yến',
  'Đỗ Quốc Bảo',
  'Vũ Mai Phương',
  'Trần Đình Trọng',
  'Bùi Thị Bích Ngọc',
  'Phan Thanh Tùng',
  'Ngô Thùy Dung',
  'Đặng Hoàng Nam',
  'Hồ Khánh Linh',
  'Lương Văn Đạt',
  'Dương Thúy Quỳnh',
  'Trịnh Tuấn Anh',
  'Võ Thị Hồng Vân',
  'Nguyễn Đức Thắng',
  'Lê Kim Oanh',
  'Hoàng Gia Bảo',
  'Đoàn Thu Hà',
];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

interface StockItemInfo {
  id: number;
  sku: string;
  name: string;
  sellingPrice: number;
  costPrice: number;
}

interface DayTarget {
  year: number;
  month: number;
  day: number;
  orderCount: number;
  targetRevenue: number;
  maxHour?: number; // for today (03/11), cut off before current time
}

const TARGET_DAYS: DayTarget[] = [
  { year: 2026, month: 10, day: 18, orderCount: 58, targetRevenue: 42_000_000 },
  { year: 2026, month: 10, day: 19, orderCount: 38, targetRevenue: 31_000_000 }, // bổ sung thêm để cộng dồn với 42 đơn cũ (~10.5M) thành ~41.5M
  { year: 2026, month: 10, day: 20, orderCount: 58, targetRevenue: 41_000_000 },
  { year: 2026, month: 10, day: 21, orderCount: 60, targetRevenue: 43_000_000 },
  { year: 2026, month: 10, day: 22, orderCount: 56, targetRevenue: 40_000_000 },
  { year: 2026, month: 10, day: 23, orderCount: 62, targetRevenue: 45_000_000 },
  { year: 2026, month: 10, day: 24, orderCount: 74, targetRevenue: 54_000_000 }, // Thứ 7
  { year: 2026, month: 10, day: 25, orderCount: 78, targetRevenue: 58_000_000 }, // Chủ nhật
  { year: 2026, month: 10, day: 26, orderCount: 57, targetRevenue: 41_000_000 },
  { year: 2026, month: 10, day: 27, orderCount: 58, targetRevenue: 42_000_000 },
  { year: 2026, month: 10, day: 28, orderCount: 61, targetRevenue: 44_000_000 },
  { year: 2026, month: 10, day: 29, orderCount: 58, targetRevenue: 42_000_000 },
  { year: 2026, month: 10, day: 30, orderCount: 65, targetRevenue: 47_000_000 },
  { year: 2026, month: 10, day: 31, orderCount: 75, targetRevenue: 55_000_000 }, // Thứ 7
  { year: 2026, month: 11, day: 1, orderCount: 76, targetRevenue: 57_000_000 }, // Chủ nhật
  { year: 2026, month: 11, day: 2, orderCount: 59, targetRevenue: 43_000_000 },
  { year: 2026, month: 11, day: 3, orderCount: 48, targetRevenue: 35_000_000, maxHour: 19 }, // Hôm nay (đến 19:05)
];

async function main() {
  console.log('=== BẮT ĐẦU CÂN BẰNG DOANH THU & ĐƠN HÀNG 30 NGÀY QUA ===\n');

  // 1. Tải danh sách sản phẩm active của Store 1
  // QUAN TRỌNG: Không bao gồm SP30 (Hết hàng - 0 tồn) và SP31 (Sắp hết hàng - 1 tồn)
  const rawItems = await prisma.stockItem.findMany({
    where: {
      storeId: STORE_ID,
      isActive: true,
      sku: { notIn: ['SP30', 'SP31'] },
    },
    select: { id: true, sku: true, name: true, sellingPrice: true, costPrice: true },
  });

  const stockItems: StockItemInfo[] = rawItems.map((item) => ({
    id: item.id,
    sku: item.sku,
    name: item.name,
    sellingPrice: Number(item.sellingPrice),
    costPrice: Number(item.costPrice),
  }));

  console.log(`Tìm thấy ${stockItems.length} sản phẩm khả dụng (đã bảo vệ SP30 & SP31).`);

  // Lưu trữ DailySalesSummary tạm thời
  const dailyMap = new Map<
    string,
    {
      storeId: number;
      stockItemId: number;
      summaryDate: Date;
      grossSoldQty: number;
      grossRevenue: number;
      cogs: number;
      orderCount: number;
    }
  >();

  // Lưu các StockMovement để chèn hàng loạt
  const movementsToInsert: Prisma.StockMovementCreateManyInput[] = [];

  let grandTotalOrders = 0;
  let grandTotalRevenue = 0;

  for (const target of TARGET_DAYS) {
    const { year, month, day, orderCount, targetRevenue, maxHour } = target;
    const dateLabel = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    console.log(`\n[${dateLabel}] Đang tạo ~${orderCount} đơn hàng (Mục tiêu: ~${(targetRevenue / 1_000_000).toFixed(1)} tr đ)...`);

    const avgOrderBudget = Math.round(targetRevenue / orderCount);
    let dayActualRevenue = 0;
    let dayOrdersCreated = 0;

    for (let i = 1; i <= orderCount; i++) {
      // Giờ ngẫu nhiên trong ngày theo giờ VN
      const endHour = maxHour ?? 21;
      const startHour = 7;
      const hourVN = randInt(startHour, endHour);
      const minuteVN = hourVN === endHour && maxHour === 19 ? randInt(0, 5) : randInt(0, 59);
      const secondVN = randInt(0, 59);

      // Chuyển sang Date UTC lưu trữ
      const orderDateUTC = new Date(Date.UTC(year, month - 1, day, hourVN - 7, minuteVN, secondVN));
      const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      // Mã đơn hàng độc nhất
      const seqStr = String(1000 + i);
      const orderNumber = `ORD-${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}-${seqStr}`;

      // Nhân viên phụ trách
      const createdById = STAFF_IDS[randInt(0, STAFF_IDS.length - 1)];

      // Khách hàng
      const customerName = CUSTOMERS[randInt(0, CUSTOMERS.length - 1)];

      // Ngân sách của đơn này (biến thiên quanh giá trị trung bình)
      const orderBudget = randInt(Math.round(avgOrderBudget * 0.55), Math.round(avgOrderBudget * 1.45));

      // Chọn 2 đến 7 mặt hàng phù hợp ngân sách
      const shuffled = shuffle(stockItems);
      const pickedItems: Array<{ item: StockItemInfo; qty: number; subtotal: number }> = [];
      let remBudget = orderBudget;
      const maxLines = randInt(2, Math.min(6, shuffled.length));

      for (const item of shuffled) {
        if (pickedItems.length >= maxLines) break;
        if (remBudget <= 0) break;
        if (item.sellingPrice > remBudget && pickedItems.length > 0) continue;

        const maxQty = Math.max(1, Math.min(5, Math.floor(remBudget / item.sellingPrice)));
        const qty = randInt(1, Math.max(1, maxQty));
        const subtotal = qty * item.sellingPrice;

        pickedItems.push({ item, qty, subtotal });
        remBudget -= subtotal;
      }

      if (pickedItems.length === 0) {
        // Fallback chọn 1 món
        const fallbackItem = shuffled[0];
        pickedItems.push({ item: fallbackItem, qty: 1, subtotal: fallbackItem.sellingPrice });
      }

      const totalAmount = pickedItems.reduce((sum, p) => sum + p.subtotal, 0);

      // Phương thức thanh toán (55% Tiền mặt, 35% Chuyển khoản, 10% PayOS)
      const payRand = Math.random();
      let paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'PAYOS' = 'CASH';
      let paymentProvider: 'CASH' | 'PAYOS' = 'CASH';

      if (payRand < 0.55) {
        paymentMethod = 'CASH';
        paymentProvider = 'CASH';
      } else if (payRand < 0.90) {
        paymentMethod = 'BANK_TRANSFER';
        paymentProvider = 'CASH';
      } else {
        paymentMethod = 'PAYOS';
        paymentProvider = 'PAYOS';
      }

      try {
        const order = await prisma.order.create({
          data: {
            storeId: STORE_ID,
            orderNumber,
            status: 'FULFILLED',
            customerName: customerName === 'Khách lẻ' ? null : customerName,
            customerPhone: customerName === 'Khách lẻ' ? null : `09${randInt(10000000, 99999999)}`,
            subtotalAmount: totalAmount,
            discountAmount: 0,
            taxAmount: 0,
            totalAmount,
            note: customerName === 'Khách lẻ' ? null : 'Khách mua trực tiếp tại quầy',
            confirmedAt: orderDateUTC,
            fulfilledAt: orderDateUTC,
            createdAt: orderDateUTC,
            updatedAt: orderDateUTC,
            createdById,
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
                createdAt: orderDateUTC,
              })),
            },
            payments: {
              create: {
                storeId: STORE_ID,
                provider: paymentProvider,
                method: paymentMethod,
                amount: totalAmount,
                currency: 'VND',
                status: 'PAID',
                paidAt: orderDateUTC,
                createdAt: orderDateUTC,
                updatedAt: orderDateUTC,
              },
            },
          },
        });

        // Gom StockMovement & DailySalesSummary
        for (const { item, qty, subtotal } of pickedItems) {
          movementsToInsert.push({
            storeId: STORE_ID,
            warehouseId: WAREHOUSE_ID,
            stockItemId: item.id,
            type: 'ORDER_FULFILL',
            delta: -qty,
            beforeQuantity: 100, // giá trị tượng trưng ghi log ledger
            afterQuantity: 100 - qty,
            referenceType: 'order',
            referenceId: String(order.id),
            note: `Bán hàng đơn ${orderNumber}`,
            createdAt: orderDateUTC,
          });

          // DailySalesSummary tích lũy
          const summaryKey = `${item.id}_${dateKey}`;
          const existing = dailyMap.get(summaryKey);
          const itemCogs = item.costPrice * qty;

          if (existing) {
            existing.grossSoldQty += qty;
            existing.grossRevenue += subtotal;
            existing.cogs += itemCogs;
            existing.orderCount += 1;
          } else {
            dailyMap.set(summaryKey, {
              storeId: STORE_ID,
              stockItemId: item.id,
              summaryDate: new Date(Date.UTC(year, month - 1, day)),
              grossSoldQty: qty,
              grossRevenue: subtotal,
              cogs: itemCogs,
              orderCount: 1,
            });
          }
        }

        dayActualRevenue += totalAmount;
        dayOrdersCreated++;
        grandTotalOrders++;
        grandTotalRevenue += totalAmount;
      } catch (err: any) {
        if (err.code === 'P2002') {
          console.warn(`Trùng mã đơn ${orderNumber}, bỏ qua...`);
          continue;
        }
        throw err;
      }
    }

    console.log(
      `  -> Hoàn thành ${dateLabel}: ${dayOrdersCreated} đơn, Doanh thu: ${(dayActualRevenue / 1_000_000).toFixed(2)} tr đ`
    );
  }

  // 2. Chèn các StockMovement ghi log dòng chảy xuất bán
  console.log(`\nĐang chèn ${movementsToInsert.length} bản ghi StockMovement...`);
  const BATCH_SIZE = 500;
  for (let i = 0; i < movementsToInsert.length; i += BATCH_SIZE) {
    await prisma.stockMovement.createMany({
      data: movementsToInsert.slice(i, i + BATCH_SIZE),
      skipDuplicates: true,
    });
  }
  console.log('✓ Hoàn tất chèn StockMovement.');

  // 3. Cập nhật DailySalesSummary
  console.log(`\nĐang cập nhật DailySalesSummary (${dailyMap.size} dòng ngày-sản phẩm)...`);
  let dssDone = 0;
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

    dssDone++;
    if (dssDone % 500 === 0 || dssDone === dailyMap.size) {
      process.stdout.write(`  ... ${dssDone}/${dailyMap.size} DailySalesSummary\r`);
    }
  }
  console.log('\n✓ Hoàn tất cập nhật DailySalesSummary.');

  console.log('\n======================================================');
  console.log(`TỔNG KẾT:`);
  console.log(`- Tổng đơn hàng đã tạo: ${grandTotalOrders} đơn`);
  console.log(`- Tổng doanh thu bổ sung: ${(grandTotalRevenue / 1_000_000).toFixed(2)} tr đ`);
  console.log(`- Biểu đồ 30 ngày qua giờ đây đã hoàn toàn liên tục và cân bằng!`);
  console.log('======================================================\n');
}

main()
  .catch((err) => {
    console.error('LỖI:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

