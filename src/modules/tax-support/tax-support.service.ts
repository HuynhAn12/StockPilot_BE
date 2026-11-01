import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ValidationError } from '../../common/errors/app-error';
import { SystemSettingsService } from '../../common/services/system-settings.service';
import { addBusinessDays, toBusinessDateKey } from '../../common/utils/business-date';
import { RevenueLedgerService } from './revenue-ledger.service';
import { evaluateRevenueThreshold, FORECAST_WINDOW_DAYS, MIN_FORECAST_DAYS } from './revenue-threshold';
import { buildRevenueBookLines, renderRevenueBookCsv, revenueBookTotal, vnDate } from './revenue-book';
import type { RevenueBookQuery } from './tax-support.schema';

const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export interface ResolvedPeriod {
  fromKey: string;
  toKey: string;
  label: string;
  partialUntil: string | null;
  fileSuffix: string;
}

/** Calendar period → business-date range, clamped to today; a period that has not started is rejected. */
export function resolvePeriod(q: Pick<RevenueBookQuery, 'period' | 'year' | 'month' | 'quarter'>, todayKey: string): ResolvedPeriod {
  let fromKey: string;
  let toKey: string;
  let label: string;
  let fileSuffix: string;
  if (q.period === 'month') {
    const m = q.month!;
    fromKey = `${q.year}-${pad2(m)}-01`;
    toKey = `${q.year}-${pad2(m)}-${pad2(lastDayOfMonth(q.year, m))}`;
    label = `Tháng ${m}/${q.year}`;
    fileSuffix = `${q.year}-T${pad2(m)}`;
  } else if (q.period === 'quarter') {
    const firstMonth = (q.quarter! - 1) * 3 + 1;
    const lastMonth = firstMonth + 2;
    fromKey = `${q.year}-${pad2(firstMonth)}-01`;
    toKey = `${q.year}-${pad2(lastMonth)}-${pad2(lastDayOfMonth(q.year, lastMonth))}`;
    label = `Quý ${q.quarter}/${q.year}`;
    fileSuffix = `${q.year}-Q${q.quarter}`;
  } else {
    fromKey = `${q.year}-01-01`;
    toKey = `${q.year}-12-31`;
    label = `Năm ${q.year}`;
    fileSuffix = String(q.year);
  }
  if (fromKey > todayKey) {
    throw new ValidationError(`${label} chưa bắt đầu, chưa có doanh thu để lập sổ`);
  }
  const partialUntil = toKey > todayKey ? todayKey : null;
  return {
    fromKey,
    toKey: partialUntil ?? toKey,
    label: `${label} (${vnDate(fromKey)} – ${vnDate(toKey)})`,
    partialUntil,
    fileSuffix,
  };
}

export class TaxSupportService {
  constructor(
    private readonly prisma: PrismaClient = defaultPrisma,
    private readonly ledger: RevenueLedgerService = new RevenueLedgerService(prisma)
  ) {}

  async getRevenueThreshold(storeId: number, now: Date = new Date()) {
    const todayKey = toBusinessDateKey(now);
    const year = Number(todayKey.slice(0, 4));
    const yearStart = `${year}-01-01`;
    const windowStart = addBusinessDays(todayKey, -(FORECAST_WINDOW_DAYS - 1));
    const fromKey = windowStart < yearStart ? windowStart : yearStart;

    const [threshold, current, prior, firstActivityKey] = await Promise.all([
      SystemSettingsService.get('tax.eInvoiceRevenueThreshold', this.prisma),
      this.ledger.daily(storeId, fromKey, todayKey),
      this.ledger.daily(storeId, `${year - 1}-01-01`, `${year - 1}-12-31`),
      this.ledger.firstActivityKey(storeId),
    ]);
    const priorYearRevenue = Math.round(prior.days.reduce((sum, d) => sum + d.net * 100, 0)) / 100;

    const result = evaluateRevenueThreshold({ year, todayKey, threshold, days: current.days, priorYearRevenue, firstActivityKey });

    const notes = ['Chỉ tính doanh thu ghi nhận trên StockPilot. Nếu cửa hàng bán thêm qua kênh hoặc địa điểm khác, ngưỡng được tính trên tổng doanh thu của mọi kênh.'];
    if (current.excludedImportedRows > 0 && current.cutover) {
      notes.push(`Bỏ qua ${current.excludedImportedRows} dòng lịch sử bán đã nhập từ ${vnDate(toBusinessDateKey(current.cutover))} vì trùng giai đoạn đã bán trên StockPilot.`);
    }
    if (result.registrationDeadlineHint) {
      notes.push('Hạn đăng ký gợi ý = 30 ngày sau ngày cuối quý có doanh thu lũy kế đạt ngưỡng (giả định kê khai theo quý). Chỉ để tham khảo, hãy xác nhận với kế toán hoặc cơ quan thuế.');
    }
    if (!result.forecast.sufficientData) {
      notes.push(`Chưa đủ ${MIN_FORECAST_DAYS} ngày dữ liệu bán hàng để dự báo.`);
    }

    return { ...result, notes, generatedAt: now.toISOString() };
  }

  private async buildBook(storeId: number, query: RevenueBookQuery, now: Date) {
    const period = resolvePeriod(query, toBusinessDateKey(now));
    const [store, ledger, orderLines] = await Promise.all([
      this.prisma.store.findUnique({ where: { id: storeId }, select: { name: true, address: true } }),
      this.ledger.daily(storeId, period.fromKey, period.toKey),
      query.granularity === 'order' ? this.ledger.orderLines(storeId, period.fromKey, period.toKey) : Promise.resolve([]),
    ]);
    const lines = buildRevenueBookLines(ledger.days, query.granularity, orderLines);
    return { period, store, ledger, lines };
  }

  async previewRevenueBook(storeId: number, query: RevenueBookQuery, now: Date = new Date()) {
    const { period, ledger, lines } = await this.buildBook(storeId, query, now);
    const sum = (pick: (d: (typeof ledger.days)[number]) => number) =>
      Math.round(ledger.days.reduce((s, d) => s + pick(d) * 100, 0)) / 100;
    return {
      template: query.template,
      periodLabel: period.label,
      partialUntil: period.partialUntil,
      lineCount: lines.length,
      total: revenueBookTotal(lines),
      breakdown: { sales: sum((d) => d.sales), imported: sum((d) => d.imported), returns: sum((d) => d.returns) },
    };
  }

  async exportRevenueBook(storeId: number, query: RevenueBookQuery, now: Date = new Date()) {
    const { period, store, lines } = await this.buildBook(storeId, query, now);
    const csv = renderRevenueBookCsv({
      template: query.template,
      storeName: store?.name ?? '',
      storeAddress: store?.address ?? null,
      periodLabel: period.label,
      partialUntil: period.partialUntil,
      generatedAt: now,
    }, lines);
    const filename = `so-doanh-thu-${query.template === 'S2A' ? 'S2a' : 'S1a'}-${period.fileSuffix}.csv`;
    return { csv, filename };
  }
}
