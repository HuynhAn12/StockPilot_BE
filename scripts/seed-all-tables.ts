import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function seedAll() {
  console.log('=== Bat dau bo sung du lieu toan dien cho tat ca cac bang ===');

  let store = await prisma.store.findFirst({ where: { code: 'SP-001' } });
  if (!store) {
    store = await prisma.store.findFirst({ where: { isActive: true } });
  }
  if (!store) {
    console.error('Khong tim thay store! Vui long chay seed.ts truoc.');
    return;
  }
  const owner = await prisma.user.findFirst({ where: { storeId: store.id, role: 'SHOP_OWNER' } });
  const warehouse = await prisma.warehouse.findFirst({ where: { storeId: store.id, isDefault: true } });
  const stockItems = await prisma.stockItem.findMany({ where: { storeId: store.id } });

  if (!stockItems || stockItems.length === 0) {
    console.error('Khong tim thay stock items!');
    return;
  }
  console.log(`Store: ${store.name} (ID: ${store.id}), Warehouse: ${warehouse?.name}, Items: ${stockItems.length}`);

  // 1. ORDERS FOR PAST 6 MONTHS (T5, T6, T7, T8)
  console.log('1. Tao don hang cho cac thang truoc (T5, T6, T7, T8)...');
  const now = new Date();
  const pastMonths = [5, 4, 3, 2]; // 5 months ago, 4 months ago, etc.
  let newOrdersCount = 0;

  for (const mOffset of pastMonths) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - mOffset, 15);
    const mNum = monthDate.getMonth() + 1;
    // create 8-12 orders per month
    const ordersInMonth = 8;
    for (let k = 1; k <= ordersInMonth; k++) {
      const ordNum = `ORD-T${mNum}-${String(k).padStart(3, '0')}`;
      const exist = await prisma.order.findUnique({
        where: { storeId_orderNumber: { storeId: store.id, orderNumber: ordNum } },
      });
      if (exist) continue;

      const orderDay = new Date(now.getFullYear(), now.getMonth() - mOffset, 2 + k * 3, 10, 30);
      const si1 = stockItems[(k * 3) % stockItems.length];
      const si2 = stockItems[(k * 7 + 1) % stockItems.length];
      const q1 = Math.floor(Math.random() * 3) + 1;
      const q2 = Math.floor(Math.random() * 2) + 1;

      const sub1 = Number(si1.sellingPrice) * q1;
      const sub2 = Number(si2.sellingPrice) * q2;
      const total = sub1 + sub2;

      const order = await prisma.order.create({
        data: {
          storeId: store.id,
          orderNumber: ordNum,
          status: 'FULFILLED',
          customerName: `Khach hang T${mNum} #${k}`,
          customerPhone: `0912${mNum}${k}123`,
          subtotalAmount: total,
          discountAmount: 0,
          taxAmount: 0,
          totalAmount: total,
          confirmedAt: orderDay,
          fulfilledAt: orderDay,
          createdById: owner?.id,
          createdAt: orderDay,
          updatedAt: orderDay,
        },
      });

      await prisma.orderItem.createMany({
        data: [
          {
            storeId: store.id,
            orderId: order.id,
            stockItemId: si1.id,
            skuSnapshot: si1.sku,
            nameSnapshot: si1.name,
            unitPriceSnapshot: si1.sellingPrice,
            costPriceSnapshot: si1.costPrice,
            quantity: q1,
            refundableAmount: sub1,
            refundedAmount: 0,
            returnedQuantity: 0,
            subtotal: sub1,
            createdAt: orderDay,
          },
          {
            storeId: store.id,
            orderId: order.id,
            stockItemId: si2.id,
            skuSnapshot: si2.sku,
            nameSnapshot: si2.name,
            unitPriceSnapshot: si2.sellingPrice,
            costPriceSnapshot: si2.costPrice,
            quantity: q2,
            refundableAmount: sub2,
            refundedAmount: 0,
            returnedQuantity: 0,
            subtotal: sub2,
            createdAt: orderDay,
          },
        ],
      });

      await prisma.payment.create({
        data: {
          storeId: store.id,
          orderId: order.id,
          provider: k % 2 === 0 ? 'PAYOS' : 'CASH',
          method: k % 2 === 0 ? 'BANK_TRANSFER' : 'CASH',
          amount: total,
          currency: 'VND',
          status: 'PAID',
          paidAt: orderDay,
          createdAt: orderDay,
          updatedAt: orderDay,
        },
      });

      newOrdersCount++;
    }
  }
  console.log(`-> Tao thanh cong ${newOrdersCount} don hang lich su!`);

  // 2. DAILY SALES SUMMARIES
  console.log('2. Tao du lieu daily_sales_summaries...');
  const existingSummaryCount = await prisma.dailySalesSummary.count({ where: { storeId: store.id } });
  if (existingSummaryCount > 0) {
    console.log(`-> daily_sales_summaries da co ${existingSummaryCount} ban ghi, bo qua.`);
  } else {
    let summaryCount = 0;
    for (let d = 1; d <= 14; d++) {
      const sDate = new Date();
      sDate.setDate(sDate.getDate() - d);
      sDate.setHours(0, 0, 0, 0);

      for (let sIdx = 0; sIdx < 5; sIdx++) {
        const item = stockItems[sIdx];
        const qty = Math.floor(Math.random() * 10) + 2;
        const rev = qty * Number(item.sellingPrice);
        const cogs = qty * Number(item.costPrice);
        const prof = rev - cogs;

        try {
          await prisma.dailySalesSummary.create({
            data: {
              storeId: store.id,
              stockItemId: item.id,
              summaryDate: sDate,
              grossSoldQty: qty,
              returnQty: 0,
              netSoldQty: qty,
              grossRevenue: rev,
              refundAmount: 0,
              netRevenue: rev,
              cogs,
              grossProfit: prof,
              historicalCostMissingQty: 0,
              orderCount: Math.max(1, Math.floor(qty / 2)),
            },
          });
          summaryCount++;
        } catch {
          // ignore duplicate
        }
      }
    }
    console.log(`-> daily_sales_summaries OK: ${summaryCount} ban ghi.`);
  }

  // 3. HISTORICAL SALES
  console.log('3. Tao du lieu historical_sales (AI / Forecasting)...');
  let histCount = 0;
  for (let i = 0; i < 30; i++) {
    const item = stockItems[i % stockItems.length];
    const daysAgo = i * 3 + 10;
    const soldDate = new Date();
    soldDate.setDate(soldDate.getDate() - daysAgo);

    const qty = Math.floor(Math.random() * 8) + 1;
    const unitPrice = Number(item.sellingPrice);
    const total = qty * unitPrice;
    const hash = crypto.createHash('sha256').update(`hist-${store.id}-${item.sku}-${soldDate.toISOString()}-${i}`).digest('hex');

    await prisma.historicalSale.upsert({
      where: {
        storeId_sourceRowHash: {
          storeId: store.id,
          sourceRowHash: hash,
        },
      },
      update: {},
      create: {
        storeId: store.id,
        stockItemId: item.id,
        externalSku: item.sku,
        quantity: qty,
        unitPrice,
        totalAmount: total,
        costPriceSnapshot: item.costPrice,
        soldAt: soldDate,
        source: 'POS_LEGACY',
        externalOrderId: `LEGACY-ORD-${1000 + i}`,
        sourceRowHash: hash,
      },
    });
    histCount++;
  }
  console.log(`-> historical_sales OK: ${histCount} ban ghi.`);

  // 4. PRICING RECOMMENDATIONS & PRICE HISTORIES & DECISION SNAPSHOTS
  console.log('4. Tao pricing_recommendations, price_histories & decision_snapshots...');
  const existingRecs = await prisma.pricingRecommendation.count({ where: { storeId: store.id } });
  if (existingRecs > 0) {
    console.log(`-> pricing_recommendations da co ${existingRecs} ban ghi, bo qua.`);
  } else {
    for (let i = 0; i < 6; i++) {
      const item = stockItems[i];
      const curP = Number(item.sellingPrice);
      const isDiscount = i % 2 === 0;
      const recP = isDiscount ? Math.round(curP * 0.9) : Math.round(curP * 1.08);
      const discPct = isDiscount ? 10.00 : 0.00;
      const action = isDiscount ? 'DECREASE' : 'INCREASE';

    const rec = await prisma.pricingRecommendation.create({
      data: {
        storeId: store.id,
        stockItemId: item.id,
        currentPrice: curP,
        recommendedPrice: recP,
        discountPct: discPct,
        action,
        riskScore: 25.5,
        confidence: 94.0,
        status: i === 0 ? 'ACCEPTED' : 'PENDING',
        reasonJson: {
          rule: isDiscount ? 'XU_LY_HANG_TON_CHAM' : 'TOI_UU_BIEN_LOI_NHUAN',
          elasticity: 1.35,
          marketPriceAvg: recP,
        },
        decidedById: i === 0 ? owner?.id : null,
        decidedAt: i === 0 ? new Date() : null,
      },
    });

    // Price history for accepted recommendation
    if (i === 0) {
      await prisma.priceHistory.create({
        data: {
          storeId: store.id,
          stockItemId: item.id,
          oldPrice: curP,
          newPrice: recP,
          source: 'RECOMMENDATION',
          recommendationId: rec.id,
          reason: 'Chap nhan de xuat toi uu bien loi nhuan tu AI Engine',
          changedById: owner?.id,
        },
      });
    }

    // Decision snapshot
    await prisma.decisionSnapshot.create({
      data: {
        storeId: store.id,
        stockItemId: item.id,
        inputJson: { currentStock: 50, avgDailyDemand: 2.3, leadTime: 5 },
        metricsJson: { reorderPoint: 15, safetyStock: 8, optimalPrice: recP },
        risksJson: { stockoutRisk: 'LOW', marginCompressionRisk: 'LOW' },
      },
    });
  }
  console.log('-> pricing_recommendations, price_histories & decision_snapshots OK!');
}

  // 5. RETURN ORDERS & RETURN ITEMS
  console.log('5. Tao return_orders & return_items...');
  const anyOrder = await prisma.order.findFirst({
    where: { storeId: store.id, status: 'FULFILLED' },
    include: { items: true },
  });

  if (anyOrder && anyOrder.items.length > 0) {
    const retNumber = 'RET-0001';
    const existRet = await prisma.returnOrder.findUnique({
      where: { storeId_returnNumber: { storeId: store.id, returnNumber: retNumber } },
    });
    if (!existRet) {
      const retItem = anyOrder.items[0];
      const retQty = 1;
      const refAmt = Number(retItem.unitPriceSnapshot) * retQty;

      const retOrder = await prisma.returnOrder.create({
        data: {
          storeId: store.id,
          orderId: anyOrder.id,
          returnNumber: retNumber,
          status: 'COMPLETED',
          totalRefundAmount: refAmt,
          reason: 'Khach hang doi y, bao bi con nguyen ven',
          clientRequestKey: `ret-req-${anyOrder.id}`,
          createdById: owner?.id,
        },
      });

      await prisma.returnItem.create({
        data: {
          storeId: store.id,
          returnOrderId: retOrder.id,
          orderItemId: retItem.id,
          stockItemId: retItem.stockItemId,
          quantity: retQty,
          refundPrice: retItem.unitPriceSnapshot,
          isRestockable: true,
          restockWarehouseId: warehouse?.id,
          note: 'Nhap lai kho chinh theo quy trinh',
        },
      });
      console.log('-> return_orders & return_items OK!');
    }
  }

  // 6. STOCK TAKES & STOCK TAKE ITEMS
  console.log('6. Tao stock_takes & stock_take_items...');
  const existingStockTake = await prisma.stockTake.findFirst({ where: { storeId: store.id } });
  if (!existingStockTake && warehouse) {
    const st = await prisma.stockTake.create({
      data: {
        storeId: store.id,
        warehouseId: warehouse.id,
        status: 'COMPLETED',
        startedAt: new Date(Date.now() - 3600000 * 24 * 7),
        completedAt: new Date(Date.now() - 3600000 * 24 * 7 + 7200000),
        note: 'Kiem ke dinh ky dau thang - Kho Chinh',
        createdById: owner?.id,
      },
    });

    for (let idx = 0; idx < Math.min(8, stockItems.length); idx++) {
      const si = stockItems[idx];
      const exp = 50;
      const count = idx % 3 === 0 ? 49 : 50;
      await prisma.stockTakeItem.create({
        data: {
          storeId: store.id,
          stockTakeId: st.id,
          stockItemId: si.id,
          expectedQuantity: exp,
          countedQuantity: count,
          varianceQuantity: count - exp,
          note: count !== exp ? 'Hao hut van chuyen 1 sp' : 'Khop so luong',
        },
      });
    }
    console.log('-> stock_takes & stock_take_items OK!');
  }

  // 7. STORE PAYMENT CONFIG (PAYOS)
  console.log('7. Tao store_payment_configs...');
  await prisma.storePaymentConfig.upsert({
    where: {
      storeId_provider: {
        storeId: store.id,
        provider: 'PAYOS',
      },
    },
    update: {},
    create: {
      storeId: store.id,
      provider: 'PAYOS',
      clientIdEncrypted: 'demo-client-id-stockpilot',
      apiKeyEncrypted: 'demo-api-key-stockpilot-sec',
      checksumKeyEncrypted: 'demo-checksum-key-stockpilot-sec',
      isActive: true,
      configuredAt: new Date(),
    },
  });
  console.log('-> store_payment_configs OK!');

  // 8. SYSTEM SETTINGS
  console.log('8. Tao system_settings...');
  const settings = [
    { key: 'APP_NAME', valueJson: 'StockPilot Pro', desc: 'Ten he thong', isPublic: true },
    { key: 'STORE_CURRENCY', valueJson: 'VND', desc: 'Don vi tien te mac dinh', isPublic: true },
    { key: 'DEFAULT_TIMEZONE', valueJson: 'Asia/Ho_Chi_Minh', desc: 'Mui gio mac dinh', isPublic: false },
    { key: 'AUTO_BACKUP_ENABLED', valueJson: true, desc: 'Tu dong sao luu co so du lieu hang ngay', isPublic: false },
    { key: 'ALERT_LOW_STOCK_THRESHOLD_PCT', valueJson: 20, desc: 'Nguong canh bao ton kho toi thieu (%)', isPublic: false },
  ];

  for (const s of settings) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      update: {},
      create: {
        key: s.key,
        valueJson: s.valueJson,
        description: s.desc,
        isPublic: s.isPublic,
        updatedById: owner?.id,
      },
    });
  }
  console.log('-> system_settings OK!');

  // 9. AI INTERACTIONS
  console.log('9. Tao ai_interactions...');
  const aiLogs = [
    {
      q: 'Top 3 san pham ban chay nhat tuan qua la gi?',
      r: 'Top 3 san pham ban chay gom: Banh mi que Da Lat (12 sp), Ca phe Arabica Da Lat (12 sp), Khau trang y te 4 lop (12 sp).',
      tokensIn: 85,
      tokensOut: 120,
    },
    {
      q: 'Co mat hang nao bi ton kho lau khong ban duoc?',
      r: 'Hien co san pham Trung ga sach Ba Huan (40 sp ton, 26 ngay khong ban) va O cam dien 6 lo (10 sp ton, 19 ngay khong ban). De xuat ap dung combo khuyen mai.',
      tokensIn: 92,
      tokensOut: 145,
    },
  ];

  for (let idx = 0; idx < aiLogs.length; idx++) {
    const l = aiLogs[idx];
    const reqId = `ai-req-${store.id}-${Date.now()}-${idx}`;
    await prisma.aiInteraction.upsert({
      where: { requestId: reqId },
      update: {},
      create: {
        storeId: store.id,
        userId: owner?.id,
        conversationId: `conv-demo-${store.id}`,
        requestId: reqId,
        model: 'gemini-1.5-pro',
        questionText: l.q,
        responseText: l.r,
        contextSummaryJson: { role: 'SHOP_OWNER', totalProducts: stockItems.length },
        inputTokens: l.tokensIn,
        outputTokens: l.tokensOut,
        latencyMs: 620,
        status: 'SUCCESS',
      },
    });
  }
  console.log('-> ai_interactions OK!');

  // 10. IMPORT JOBS & IMPORT JOB ITEMS
  console.log('10. Tao import_jobs & import_job_items...');
  const importJobId = `job-seed-import-${store.id}`;
  const existJob = await prisma.importJob.findUnique({ where: { id: importJobId } });
  if (!existJob) {
    const job = await prisma.importJob.create({
      data: {
        id: importJobId,
        storeId: store.id,
        createdById: owner?.id,
        type: 'PRODUCTS_EXCEL',
        payloadHash: crypto.createHash('sha256').update(importJobId).digest('hex'),
        payloadJson: { filename: 'Danh_sach_hang_hoa_Thang10.xlsx', totalRows: 5 },
        status: 'COMPLETED',
        totalRows: 5,
        validRows: 5,
        invalidRows: 0,
        warningRows: 0,
        resultJson: { importedSkus: 5, message: 'Nhap khau 5 san pham thanh cong' },
        expiresAt: new Date(Date.now() + 86400000 * 30),
      },
    });

    for (let r = 1; r <= 5; r++) {
      const si = stockItems[r];
      await prisma.importJobItem.create({
        data: {
          importJobId: job.id,
          rowNumber: r,
          stockItemId: si.id,
          sku: si.sku,
          status: 'COMPLETED',
          resultJson: { action: 'CREATED_OR_UPDATED', sku: si.sku },
        },
      });
    }
    console.log('-> import_jobs & import_job_items OK!');
  }

  console.log('\n=== HOAN TAT SEED DU LIEU TOAN BO 30 BANG CHO STOCKPILOT ===');
}

seedAll()
  .catch((e) => {
    console.error('Loi khi seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
