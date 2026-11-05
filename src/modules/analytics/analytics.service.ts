import { prisma } from '../../config/db';
import { toNumber } from '../../common/utils/decimal';

export interface AnalyticsQueryOptions {
  timeRange?: string; // 'today' | '7d' | '30d' | 'month' | 'last_month' | 'year' | 'custom'
  from?: string;
  to?: string;
}

export class AnalyticsService {
  private parseDateRange(query: AnalyticsQueryOptions = {}) {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 3600000);
    const vnYear = vnNow.getUTCFullYear();
    const vnMonth = vnNow.getUTCMonth();
    const vnDate = vnNow.getUTCDate();

    let startDate: Date;
    let endDate: Date = new Date(Date.UTC(vnYear, vnMonth, vnDate, 16, 59, 59, 999));
    let prevStartDate: Date;
    let prevEndDate: Date;

    const range = query.timeRange || '30d';

    if (query.from && query.to) {
      const parseVnDateInput = (str: string, isEnd = false) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(str.trim())) {
          const [y, m, d] = str.trim().split('-').map(Number);
          return isEnd
            ? new Date(Date.UTC(y, m - 1, d, 16, 59, 59, 999))
            : new Date(Date.UTC(y, m - 1, d, -7, 0, 0, 0));
        }
        return new Date(str);
      };

      startDate = parseVnDateInput(query.from, false);
      endDate = parseVnDateInput(query.to, true);
      const diff = Math.max(86400000, endDate.getTime() - startDate.getTime());
      prevStartDate = new Date(startDate.getTime() - diff);
      prevEndDate = new Date(startDate.getTime());
    } else if (range === 'today') {
      startDate = new Date(Date.UTC(vnYear, vnMonth, vnDate, -7, 0, 0, 0));
      prevStartDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 1, -7, 0, 0, 0));
      prevEndDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 1, 16, 59, 59, 999));
    } else if (range === '3d') {
      startDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 2, -7, 0, 0, 0));
      prevStartDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 5, -7, 0, 0, 0));
      prevEndDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 3, 16, 59, 59, 999));
    } else if (range === '7d') {
      startDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 6, -7, 0, 0, 0));
      prevStartDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 13, -7, 0, 0, 0));
      prevEndDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 7, 16, 59, 59, 999));
    } else if (range === 'month' || range === 'this_month') {
      startDate = new Date(Date.UTC(vnYear, vnMonth, 1, -7, 0, 0, 0));
      endDate = new Date(Date.UTC(vnYear, vnMonth + 1, 0, 16, 59, 59, 999));
      prevStartDate = new Date(Date.UTC(vnYear, vnMonth - 1, 1, -7, 0, 0, 0));
      prevEndDate = new Date(Date.UTC(vnYear, vnMonth, 0, 16, 59, 59, 999));
    } else if (range === 'last_month') {
      startDate = new Date(Date.UTC(vnYear, vnMonth - 1, 1, -7, 0, 0, 0));
      endDate = new Date(Date.UTC(vnYear, vnMonth, 0, 16, 59, 59, 999));
      prevStartDate = new Date(Date.UTC(vnYear, vnMonth - 2, 1, -7, 0, 0, 0));
      prevEndDate = new Date(Date.UTC(vnYear, vnMonth - 1, 0, 16, 59, 59, 999));
    } else if (range === 'year' || range === 'this_year') {
      startDate = new Date(Date.UTC(vnYear, 0, 1, -7, 0, 0, 0));
      endDate = new Date(Date.UTC(vnYear, 11, 31, 16, 59, 59, 999));
      prevStartDate = new Date(Date.UTC(vnYear - 1, 0, 1, -7, 0, 0, 0));
      prevEndDate = new Date(Date.UTC(vnYear - 1, 11, 31, 16, 59, 59, 999));
    } else {
      startDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 29, -7, 0, 0, 0));
      prevStartDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 59, -7, 0, 0, 0));
      prevEndDate = new Date(Date.UTC(vnYear, vnMonth, vnDate - 30, 16, 59, 59, 999));
    }

    return { startDate, endDate, prevStartDate, prevEndDate, range };
  }

  async getDashboardMetrics(storeId: number, options: AnalyticsQueryOptions = {}) {
    const { startDate, endDate, prevStartDate, prevEndDate, range } = this.parseDateRange(options);

    // 1. Current period orders — filter by fulfilledAt (actual sale date)
    const currentOrders = await prisma.order.findMany({
      where: {
        storeId,
        status: 'FULFILLED',
        fulfilledAt: { gte: startDate, lte: endDate },
      },
      include: {
        items: {
          include: {
            stockItem: {
              include: {
                product: {
                  include: {
                    category: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // 2. Previous period orders (for growth comparison)
    const prevOrders = await prisma.order.findMany({
      where: {
        storeId,
        status: 'FULFILLED',
        fulfilledAt: { gte: prevStartDate, lte: prevEndDate },
      },
      include: {
        items: true,
      },
    });

    // 3. Current period returns / refunds
    const currentReturns = await prisma.returnOrder.aggregate({
      where: {
        storeId,
        status: 'COMPLETED',
        createdAt: { gte: startDate, lte: endDate },
      },
      _sum: { totalRefundAmount: true },
      _count: { id: true },
    });

    const prevReturns = await prisma.returnOrder.aggregate({
      where: {
        storeId,
        status: 'COMPLETED',
        createdAt: { gte: prevStartDate, lte: prevEndDate },
      },
      _sum: { totalRefundAmount: true },
    });

    // Compute financial aggregates for current period
    const safeOrders = Array.isArray(currentOrders) ? currentOrders : [];
    const grossRevenue = safeOrders.reduce((sum, o) => sum + toNumber(o.totalAmount), 0);
    const refundedAmount = toNumber(currentReturns?._sum?.totalRefundAmount || 0);
    const netRevenue = Math.max(0, grossRevenue - refundedAmount);
    const orderCount = safeOrders.length;
    const avgOrderValue = orderCount > 0 ? Math.round(netRevenue / orderCount) : 0;

    let totalCogs = 0;
    let totalUnitsSold = 0;
    let totalUnitsReturned = 0;
    const productSalesMap = new Map<number, {
      id: number;
      name: string;
      sku: string;
      category: string;
      soldQty: number;
      returnedQty: number;
      revenue: number;
      cost: number;
      profit: number;
    }>();

    const categoryMap = new Map<string, {
      name: string;
      revenue: number;
      cost: number;
      profit: number;
      orderCount: Set<number>;
    }>();

    for (const order of currentOrders) {
      for (const item of order.items) {
        const itemGross = toNumber(item.subtotal);
        const itemRefunded = toNumber(item.refundedAmount || 0);
        const itemNetRevenue = Math.max(0, itemGross - itemRefunded);
        const itemQty = item.quantity || 0;
        const itemReturned = item.returnedQuantity || 0;
        const netQty = Math.max(0, itemQty - itemReturned);
        const itemCost = toNumber(item.costPriceSnapshot) * netQty;
        const itemProfit = Math.max(0, itemNetRevenue - itemCost);
        totalCogs += itemCost;
        totalUnitsSold += netQty;
        totalUnitsReturned += itemReturned;
        // Group by stockItem
        const sId = item.stockItemId;
        const existing = productSalesMap.get(sId) || {
          id: sId,
          name: item.nameSnapshot,
          sku: item.skuSnapshot,
          category: item.stockItem?.product?.category?.name || 'Khác',
          soldQty: 0,
          returnedQty: 0,
          revenue: 0,
          cost: 0,
          profit: 0,
        };
        existing.soldQty += netQty;
        existing.returnedQty += itemReturned;
        existing.revenue += itemNetRevenue;
        existing.cost += itemCost;
        existing.profit += itemProfit;
        productSalesMap.set(sId, existing);

        // Group by category
        const catName = item.stockItem?.product?.category?.name || 'Tiêu dùng khác';
        const catData = categoryMap.get(catName) || {
          name: catName,
          revenue: 0,
          cost: 0,
          profit: 0,
          orderCount: new Set<number>(),
        };
        catData.revenue += itemNetRevenue;
        catData.cost += itemCost;
        catData.profit += itemProfit;
        catData.orderCount.add(order.id);
        categoryMap.set(catName, catData);
      }
    }

    const grossProfit = Math.max(0, netRevenue - totalCogs);
    const profitMargin = netRevenue > 0 ? Number(((grossProfit / netRevenue) * 100).toFixed(1)) : 0;

    // Previous period aggregates
    const safePrevOrders = Array.isArray(prevOrders) ? prevOrders : [];
    const prevGross = safePrevOrders.reduce((sum, o) => sum + toNumber(o.totalAmount), 0);
    const prevRefunded = toNumber(prevReturns?._sum?.totalRefundAmount || 0);
    const prevNetRevenue = Math.max(0, prevGross - prevRefunded);
    const prevOrderCount = safePrevOrders.length;
    let prevCogs = 0;
    for (const o of safePrevOrders) {
      for (const i of (o.items || [])) {
        const netQty = Math.max(0, (i.quantity || 0) - ((i as any).returnedQuantity || 0));
        prevCogs += toNumber(i.costPriceSnapshot) * netQty;
      }
    }
    const prevProfit = Math.max(0, prevNetRevenue - prevCogs);

    // Calculate Growth percentages
    const calcGrowth = (current: number, prev: number): string => {
      if (prev === 0) return current > 0 ? '+100%' : '0%';
      const pct = Math.round(((current - prev) / prev) * 100);
      return `${pct >= 0 ? '+' : ''}${pct}%`;
    };

    const growth = {
      revenue: calcGrowth(netRevenue, prevNetRevenue),
      profit: calcGrowth(grossProfit, prevProfit),
      orders: calcGrowth(orderCount, prevOrderCount),
    };

    // Inventory Valuation & Balances
    const balances = await prisma.inventoryBalance.findMany({
      where: { storeId },
      include: {
        stockItem: {
          select: {
            id: true,
            sku: true,
            name: true,
            costPrice: true,
            sellingPrice: true,
            minStockLevel: true,
            maxStockLevel: true,
            createdAt: true,
          },
        },
      },
    });

    let totalStockQuantity = 0;
    let inventoryCostValuation = 0;
    let inventoryRetailValuation = 0;

    for (const b of balances) {
      const qty = b.quantity;
      totalStockQuantity += qty;
      inventoryCostValuation += qty * toNumber(b.stockItem.costPrice);
      inventoryRetailValuation += qty * toNumber(b.stockItem.sellingPrice);
    }

    // Top selling products (sorted by sold quantity)
    const productSalesList = Array.from(productSalesMap.values());
    const topSellers = [...productSalesList]
      .sort((a, b) => b.soldQty - a.soldQty)
      .slice(0, 10)
      .map((p, idx) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        sold: p.soldQty,
        revenue: p.revenue,
        profit: p.profit,
        margin: p.revenue > 0 ? Number(((p.profit / p.revenue) * 100).toFixed(1)) : 0,
        trend: idx === 0 ? 'Bán chạy số 1' : 'Tăng trưởng tốt',
        tag: idx === 0 ? 'Bán chạy nhất' : 'Phát sinh đơn đều',
      }));

    // Slow moving items: in stock but not sold in this period. "Days without sale" counts from the last real
    // sale (fulfilled order or imported sales history); a SKU that never sold counts from when it was created.
    const soldItemIds = new Set(productSalesMap.keys());
    const unsoldBalances = balances.filter((b) => b.quantity > 0 && !soldItemIds.has(b.stockItemId));
    const unsoldIds = unsoldBalances.map((b) => b.stockItemId);
    const [lastOrderSales, lastImportedSales] = unsoldIds.length
      ? await Promise.all([
          prisma.orderItem?.groupBy
            ? prisma.orderItem.groupBy({
                by: ['stockItemId'],
                where: { storeId, stockItemId: { in: unsoldIds }, order: { status: 'FULFILLED' } },
                _max: { createdAt: true },
              })
            : Promise.resolve([]),
          prisma.historicalSale?.groupBy
            ? prisma.historicalSale.groupBy({
                by: ['stockItemId'],
                where: { storeId, stockItemId: { in: unsoldIds } },
                _max: { soldAt: true },
              })
            : Promise.resolve([]),
        ])
      : [[], []];
    const lastSaleAt = new Map<number, number>();
    const noteLastSale = (stockItemId: number | null, at: Date | null | undefined) => {
      if (stockItemId === null || !at) return;
      lastSaleAt.set(stockItemId, Math.max(lastSaleAt.get(stockItemId) ?? 0, at.getTime()));
    };
    ((lastOrderSales ?? []) as Array<{ stockItemId: number; _max: { createdAt: Date | null } }>).forEach((row) =>
      noteLastSale(row.stockItemId, row._max.createdAt)
    );
    ((lastImportedSales ?? []) as Array<{ stockItemId: number | null; _max: { soldAt: Date | null } }>).forEach((row) =>
      noteLastSale(row.stockItemId, row._max.soldAt)
    );

    const DAY_MS = 24 * 60 * 60 * 1000;
    const slowMovers = unsoldBalances
      .map((b) => {
        const costVal = b.quantity * toNumber(b.stockItem?.costPrice || 0);
        const lastSale = lastSaleAt.get(b.stockItemId);
        const createdAtTime = b.stockItem?.createdAt ? new Date(b.stockItem.createdAt).getTime() : Date.now();
        const daysNoSale = Math.max(0, Math.floor((Date.now() - (lastSale ?? createdAtTime)) / DAY_MS));
        return {
          id: b.stockItem.id,
          name: b.stockItem.name,
          sku: b.stockItem.sku,
          stock: b.quantity,
          capital: costVal,
          daysNoSale,
          neverSold: lastSale === undefined,
          lastSoldAt: lastSale !== undefined ? new Date(lastSale).toISOString() : null,
          suggestion: daysNoSale >= 30 ? 'Cân nhắc giảm giá kích cầu' : 'Theo dõi biến động tồn',
        };
      })
      .sort((a, b) => b.daysNoSale - a.daysNoSale || b.capital - a.capital)
      .slice(0, 10);

    // Category Stats: the store's own categories, highest revenue first.
    const categoryStats = [...categoryMap.values()]
      .map((cat) => ({
        name: cat.name,
        revenue: cat.revenue,
        profit: cat.profit,
        margin: cat.revenue > 0 ? Number(((cat.profit / cat.revenue) * 100).toFixed(1)) : 0,
        orderCount: cat.orderCount.size,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // Time trend series for chart
    // If range is today or 7d -> generate daily buckets
    // If range is month or 30d -> daily buckets
    // If range is year -> monthly buckets
    const chartSeries: Array<{ label: string; date: string; revenue: number; profit: number; orderCount: number }> = [];

    if (range === 'today') {
      // Hourly buckets (6h to 22h VN time) — use fulfilledAt
      for (let h = 6; h <= 22; h += 2) {
        const hLabel = `${h}:00`;
        const ordersInHour = currentOrders.filter((o) => {
          const t = o.fulfilledAt ?? o.createdAt;
          const vnHour = new Date(t.getTime() + 7 * 3600000).getUTCHours();
          return vnHour >= h && vnHour < h + 2;
        });
        const rev = ordersInHour.reduce((sum, o) => {
          const itemNet = (o.items || []).reduce((s, it) => s + Math.max(0, toNumber(it.subtotal) - toNumber(it.refundedAmount || 0)), 0);
          return sum + (itemNet > 0 ? itemNet : toNumber(o.totalAmount));
        }, 0);
        let cost = 0;
        ordersInHour.forEach((o) => o.items.forEach((i) => {
          const netQty = Math.max(0, (i.quantity || 0) - (i.returnedQuantity || 0));
          cost += toNumber(i.costPriceSnapshot) * netQty;
        }));
        chartSeries.push({
          label: hLabel,
          date: hLabel,
          revenue: rev,
          profit: Math.max(0, rev - cost),
          orderCount: ordersInHour.length,
        });
      }
    } else if (range === '7d' || range === '30d' || range === 'month' || range === 'this_month') {
      const daysCount = range === '7d' ? 7 : 30;
      for (let i = daysCount - 1; i >= 0; i--) {
        const dayVn = new Date(endDate.getTime() - i * 24 * 60 * 60 * 1000 + 7 * 3600000);
        const vy = dayVn.getUTCFullYear();
        const vm = dayVn.getUTCMonth();
        const vd = dayVn.getUTCDate();
        const dateStr = `${vd}/${vm + 1}`;
        const dayStart = new Date(Date.UTC(vy, vm, vd, -7, 0, 0, 0));
        const dayEnd = new Date(Date.UTC(vy, vm, vd, 16, 59, 59, 999));

        const ordersInDay = currentOrders.filter((o) => {
          const t = o.fulfilledAt ?? o.createdAt;
          return t >= dayStart && t <= dayEnd;
        });
        const rev = ordersInDay.reduce((sum, o) => {
          const itemNet = (o.items || []).reduce((s, it) => s + Math.max(0, toNumber(it.subtotal) - toNumber(it.refundedAmount || 0)), 0);
          return sum + (itemNet > 0 ? itemNet : toNumber(o.totalAmount));
        }, 0);
        let cost = 0;
        ordersInDay.forEach((o) => o.items.forEach((i) => {
          const netQty = Math.max(0, (i.quantity || 0) - (i.returnedQuantity || 0));
          cost += toNumber(i.costPriceSnapshot) * netQty;
        }));

        chartSeries.push({
          label: dateStr,
          date: `${vy}-${String(vm + 1).padStart(2, '0')}-${String(vd).padStart(2, '0')}`,
          revenue: rev,
          profit: Math.max(0, rev - cost),
          orderCount: ordersInDay.length,
        });
      }
    } else {
      // 12 months for year — use fulfilledAt VN month
      for (let m = 0; m < 12; m++) {
        const mLabel = `Tháng ${m + 1}`;
        const ordersInMonth = currentOrders.filter((o) => {
          const t = o.fulfilledAt ?? o.createdAt;
          const vnM = new Date(t.getTime() + 7 * 3600000).getUTCMonth();
          return vnM === m;
        });
        const rev = ordersInMonth.reduce((sum, o) => {
          const itemNet = (o.items || []).reduce((s, it) => s + Math.max(0, toNumber(it.subtotal) - toNumber(it.refundedAmount || 0)), 0);
          return sum + (itemNet > 0 ? itemNet : toNumber(o.totalAmount));
        }, 0);
        let cost = 0;
        ordersInMonth.forEach((o) => o.items.forEach((i) => {
          const netQty = Math.max(0, (i.quantity || 0) - (i.returnedQuantity || 0));
          cost += toNumber(i.costPriceSnapshot) * netQty;
        }));
        chartSeries.push({
          label: mLabel,
          date: `2026-${String(m + 1).padStart(2, '0')}`,
          revenue: rev,
          profit: Math.max(0, rev - cost),
          orderCount: ordersInMonth.length,
        });
      }
    }

    // 6-month monthlyRevenue trend for dashboard C2 chart (VN Timezone UTC+7)
    const monthlyRevenue: Array<{ month: string; ym: string; label: string; revenue: number; orderCount: number }> = [];
    const nowVn = new Date(Date.now() + 7 * 3600000);
    const currYear = nowVn.getUTCFullYear();
    const currMonth = nowVn.getUTCMonth();
    for (let i = 5; i >= 0; i--) {
      const targetMonthDate = new Date(Date.UTC(currYear, currMonth - i, 1));
      const mYear = targetMonthDate.getUTCFullYear();
      const mMonth = targetMonthDate.getUTCMonth();
      const mNum = mMonth + 1;
      const ym = `${mYear}-${String(mNum).padStart(2, '0')}`;
      const mStart = new Date(Date.UTC(mYear, mMonth, 1, -7, 0, 0, 0));
      const mEnd = new Date(Date.UTC(mYear, mMonth + 1, 0, 16, 59, 59, 999));

      const mOrders = await prisma.order.findMany({
        where: {
          storeId,
          status: 'FULFILLED',
          fulfilledAt: { gte: mStart, lte: mEnd },
        },
        select: { totalAmount: true },
      });
      const mRev = mOrders.reduce((sum, o) => sum + toNumber(o.totalAmount), 0);
      monthlyRevenue.push({
        month: `T${mNum}`,
        ym,
        label: `Tháng ${mNum}/${mYear}`,
        revenue: mRev,
        orderCount: mOrders.length,
      });
    }

    // Active alerts count
    const [openAlertsCount, pendingRecsCount] = await Promise.all([
      prisma.alert?.count ? prisma.alert.count({ where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } }) : Promise.resolve(0),
      prisma.pricingRecommendation?.count ? prisma.pricingRecommendation.count({ where: { storeId, status: 'PENDING' } }) : Promise.resolve(0),
    ]);

    return {
      timeRange: range,
      period: {
        from: startDate.toISOString(),
        to: endDate.toISOString(),
      },
      // Core financial KPIs
      grossRevenue,
      refundedAmount,
      netRevenue,
      cogs: totalCogs,
      grossProfit,
      profitMargin,
      marginPct: profitMargin,
      orderCount,
      completedOrdersCount: orderCount,
      avgOrderValue,
      totalUnitsSold,
      grossUnitsSold: totalUnitsSold + totalUnitsReturned,
      returnedUnits: totalUnitsReturned,
      // Growth vs previous period
      growth,

      // Inventory Valuation
      totalStockQuantity,
      inventoryValuation: inventoryCostValuation,
      inventoryCostValuation,
      inventoryRetailValuation,

      // Breakdowns & Lists
      topSellers,
      slowMovers,
      categoryStats,
      chartSeries,
      monthlyRevenue,

      // System risk status
      openAlertsCount,
      pendingRecsCount,
    };
  }
}
