import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../src/config/db';
import { DailySalesSummaryService } from '../src/modules/daily-sales-summary/daily-sales-summary.service';
import { businessDateKeyToDate, canonicalDateToBusinessDateKey, toBusinessDateKey } from '../src/common/utils/business-date';
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
  if (options.storeId !== undefined && !isValidStoreId(options.storeId)) {
    throw new Error('Invalid storeId. Expected a positive integer.');
  }

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
    // 1. Find earliest/latest business dates across source facts and existing summaries.
    const [
      earliestOrder,
      latestOrder,
      earliestReturn,
      latestReturn,
      earliestHistorical,
      latestHistorical,
      earliestSummary,
      latestSummary,
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
      prisma.dailySalesSummary.findFirst({
        where: { storeId: store.id },
        orderBy: { summaryDate: 'asc' },
        select: { summaryDate: true },
      }),
      prisma.dailySalesSummary.findFirst({
        where: { storeId: store.id },
        orderBy: { summaryDate: 'desc' },
        select: { summaryDate: true },
      }),
    ]);

    const minKeys: string[] = [];
    const maxKeys: string[] = [];

    if (earliestOrder?.fulfilledAt) minKeys.push(toBusinessDateKey(earliestOrder.fulfilledAt, env.APP_TIMEZONE));
    if (latestOrder?.fulfilledAt) maxKeys.push(toBusinessDateKey(latestOrder.fulfilledAt, env.APP_TIMEZONE));

    if (earliestReturn?.createdAt) minKeys.push(toBusinessDateKey(earliestReturn.createdAt, env.APP_TIMEZONE));
    if (latestReturn?.createdAt) maxKeys.push(toBusinessDateKey(latestReturn.createdAt, env.APP_TIMEZONE));

    if (earliestHistorical?.soldAt) minKeys.push(toBusinessDateKey(earliestHistorical.soldAt, env.APP_TIMEZONE));
    if (latestHistorical?.soldAt) maxKeys.push(toBusinessDateKey(latestHistorical.soldAt, env.APP_TIMEZONE));

    if (earliestSummary?.summaryDate) minKeys.push(canonicalDateToBusinessDateKey(earliestSummary.summaryDate));
    if (latestSummary?.summaryDate) maxKeys.push(canonicalDateToBusinessDateKey(latestSummary.summaryDate));

    if (minKeys.length === 0) {
      skippedStores++;
      continue;
    }

    const fromDateStr = minKeys.sort()[0];
    const toDateStr = maxKeys.sort()[maxKeys.length - 1];
    const fromDate = businessDateKeyToDate(fromDateStr);
    const toDate = businessDateKeyToDate(toDateStr);

    let updatedDays = 0;
    if (!isDryRun) {
      const res = await summaryService.rebuildDailySalesSummary(store.id, fromDate, toDate);
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

function isValidStoreId(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function parseStoreIdArg(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('Invalid --storeId value. Use a positive integer, for example --storeId=1.');
  }
  return Number(value);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const storeIdArg = args.find((a) => a.startsWith('--storeId='));
  let storeId: number | undefined;

  try {
    storeId = parseStoreIdArg(storeIdArg ? storeIdArg.split('=')[1] : undefined);
  } catch (err) {
    console.error(`[Rebuild V10] ${(err as Error).message}`);
    process.exit(1);
  }

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
