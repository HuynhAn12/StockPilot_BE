import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../src/config/db';
import { DailySalesSummaryService } from '../src/modules/daily-sales-summary/daily-sales-summary.service';
import { toBusinessDateKey } from '../src/common/utils/business-date';
import { env } from '../src/config/env';

export interface RebuildOptions {
  storeId?: number;
  dryRun?: boolean;
}

export async function runRebuildDailySalesSummaryV10(
  prisma: PrismaClient = defaultPrisma,
  options: RebuildOptions = {}
): Promise<{
  processedStores: number;
  skippedStores: number;
  totalDaysUpdated: number;
  storeResults: Array<{
    storeId: number;
    storeCode: string;
    fromDate: string;
    toDate: string;
    updatedDays: number;
    dryRun: boolean;
  }>;
}> {
  const summaryService = new DailySalesSummaryService(prisma);
  const isDryRun = Boolean(options.dryRun);

  const stores = await prisma.store.findMany({
    where: options.storeId ? { id: options.storeId } : {},
    select: { id: true, code: true, name: true },
    orderBy: { id: 'asc' },
  });

  const results = [];
  let totalDaysUpdated = 0;
  let skippedStores = 0;

  for (const store of stores) {
    // 1. Find earliest and latest dates across Orders, Returns, and HistoricalSales
    const [
      earliestOrder,
      latestOrder,
      earliestReturn,
      latestReturn,
      earliestHistorical,
      latestHistorical,
    ] = await Promise.all([
      prisma.order.findFirst({
        where: { storeId: store.id, status: 'FULFILLED', fulfilledAt: { not: null } },
        orderBy: { fulfilledAt: 'asc' },
        select: { fulfilledAt: true },
      }),
      prisma.order.findFirst({
        where: { storeId: store.id, status: 'FULFILLED', fulfilledAt: { not: null } },
        orderBy: { fulfilledAt: 'desc' },
        select: { fulfilledAt: true },
      }),
      prisma.returnOrder.findFirst({
        where: { storeId: store.id, status: 'COMPLETED' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.returnOrder.findFirst({
        where: { storeId: store.id, status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.historicalSale.findFirst({
        where: { storeId: store.id },
        orderBy: { soldAt: 'asc' },
        select: { soldAt: true },
      }),
      prisma.historicalSale.findFirst({
        where: { storeId: store.id },
        orderBy: { soldAt: 'desc' },
        select: { soldAt: true },
      }),
    ]);

    const minDates: Date[] = [];
    const maxDates: Date[] = [];

    if (earliestOrder?.fulfilledAt) minDates.push(earliestOrder.fulfilledAt);
    if (latestOrder?.fulfilledAt) maxDates.push(latestOrder.fulfilledAt);

    if (earliestReturn?.createdAt) minDates.push(earliestReturn.createdAt);
    if (latestReturn?.createdAt) maxDates.push(latestReturn.createdAt);

    if (earliestHistorical?.soldAt) minDates.push(earliestHistorical.soldAt);
    if (latestHistorical?.soldAt) maxDates.push(latestHistorical.soldAt);

    if (minDates.length === 0) {
      skippedStores++;
      continue;
    }

    const minDate = new Date(Math.min(...minDates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...maxDates.map((d) => d.getTime())));

    const fromDateStr = toBusinessDateKey(minDate, env.APP_TIMEZONE);
    const toDateStr = toBusinessDateKey(maxDate, env.APP_TIMEZONE);

    let updatedDays = 0;
    if (!isDryRun) {
      const res = await summaryService.rebuildDailySalesSummary(store.id, minDate, maxDate);
      updatedDays = res.updatedDays;
      totalDaysUpdated += updatedDays;
    }

    results.push({
      storeId: store.id,
      storeCode: store.code,
      fromDate: fromDateStr,
      toDate: toDateStr,
      updatedDays,
      dryRun: isDryRun,
    });
  }

  return {
    processedStores: results.length,
    skippedStores,
    totalDaysUpdated,
    storeResults: results,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const storeIdArg = args.find((a) => a.startsWith('--storeId='));
  const storeId = storeIdArg ? parseInt(storeIdArg.split('=')[1], 10) : undefined;

  runRebuildDailySalesSummaryV10(defaultPrisma, { storeId, dryRun })
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Rebuild V10] Failed:', err);
      process.exit(1);
    })
    .finally(() => defaultPrisma.$disconnect());
}
