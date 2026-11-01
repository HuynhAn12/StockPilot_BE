import { toBusinessDateKey } from '../../common/utils/business-date';
import { sanitizeCsvCell } from '../import-export/import-export.service';
import type { LedgerDay, LedgerOrderLine } from './revenue-ledger.service';

/**
 * Household-business revenue book (Thông tư 152/2025/TT-BTC):
 * - S1A (Mẫu S1a-HKD): Ngày tháng · Diễn giải · Số tiền.
 * - S2A (Mẫu S2a-HKD): Số hiệu & ngày chứng từ · Diễn giải · Số tiền, revenue grouped by business line
 *   with the same tax rate. StockPilot only sells goods → one group; tax rates and tax amounts are left
 *   blank on purpose — they are the taxpayer's/accountant's call, not something this file asserts.
 * Returns are separate negative lines so an accountant can reconcile them.
 * Pure: no I/O.
 */

export type RevenueBookTemplate = 'S1A' | 'S2A';
export type RevenueBookGranularity = 'day' | 'order';

export interface RevenueBookLine {
  date: string; // YYYY-MM-DD
  reference: string;
  description: string;
  amount: number; // VND, negative for returns
}

export interface RevenueBookMeta {
  template: RevenueBookTemplate;
  storeName: string;
  storeAddress: string | null;
  periodLabel: string; // e.g. "Quý 3/2026 (01/07/2026 – 30/09/2026)"
  /** Set when the period is still running: the book stops at this date. */
  partialUntil: string | null;
  generatedAt: Date;
}

const BOM = String.fromCharCode(0xfeff); // UTF-8 BOM: Excel opens Vietnamese text correctly
export const GOODS_BUSINESS_LINE = 'Phân phối, cung cấp hàng hóa';

export const vnDate = (key: string) => {
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
};
const shortDate = (key: string) => vnDate(key).slice(0, 5);
const cents = (n: number) => Math.round(n * 100);

export function buildRevenueBookLines(
  days: LedgerDay[],
  granularity: RevenueBookGranularity,
  orderLines: LedgerOrderLine[] = []
): RevenueBookLine[] {
  const lines: RevenueBookLine[] = [];
  const perOrder = granularity === 'order';
  const docsByDay = new Map<string, LedgerOrderLine[]>();
  if (perOrder) {
    for (const l of orderLines) {
      const list = docsByDay.get(l.day) ?? [];
      list.push(l);
      docsByDay.set(l.day, list);
    }
  }
  const allDays = [...new Set([...days.map((d) => d.day), ...docsByDay.keys()])].sort();
  const ledgerByDay = new Map(days.map((d) => [d.day, d]));

  for (const day of allDays) {
    const d = ledgerByDay.get(day);
    if (perOrder) {
      for (const doc of docsByDay.get(day) ?? []) {
        lines.push(doc.kind === 'SALE'
          ? { date: day, reference: doc.reference, description: 'Bán hàng hóa', amount: doc.amount }
          : { date: day, reference: doc.reference, description: 'Hàng bán bị trả lại', amount: -doc.amount });
      }
    } else if (d && d.sales > 0) {
      const ref = d.orderCount <= 1 || d.firstOrderNo === d.lastOrderNo
        ? (d.firstOrderNo ?? '')
        : `${d.firstOrderNo}–${d.lastOrderNo}`;
      lines.push({
        date: day,
        reference: ref,
        description: `Doanh thu bán hàng hóa ngày ${shortDate(day)} (${d.orderCount} đơn)`,
        amount: d.sales,
      });
    }
    // Imported history has no per-document detail worth listing: one line per day in both modes.
    if (d && d.imported > 0) {
      lines.push({ date: day, reference: '', description: `Doanh thu bán hàng ngày ${shortDate(day)} (nhập từ phần mềm cũ)`, amount: d.imported });
    }
    if (!perOrder && d && d.returns > 0) {
      lines.push({ date: day, reference: '', description: `Hàng bán bị trả lại ngày ${shortDate(day)}`, amount: -d.returns });
    }
  }
  return lines;
}

export function revenueBookTotal(lines: RevenueBookLine[]): number {
  return lines.reduce((sum, l) => sum + cents(l.amount), 0) / 100;
}

/** Text cells go through the formula-injection guard; numbers are written raw so Excel can sum them. */
const text = (value: string) => sanitizeCsvCell(value);
const money = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));
const row = (...cells: string[]) => cells.join(',');

export function renderRevenueBookCsv(meta: RevenueBookMeta, lines: RevenueBookLine[]): string {
  const s2a = meta.template === 'S2A';
  const width = s2a ? 5 : 3;
  const pad = (cells: string[]) => row(...cells, ...Array(Math.max(0, width - cells.length)).fill(''));
  const out: string[] = [];

  out.push(pad([text(`HỘ, CÁ NHÂN KINH DOANH: ${meta.storeName}`)]));
  out.push(pad([text(`Địa chỉ: ${meta.storeAddress || '…………………………'}`)]));
  out.push(pad([text('Mã số thuế: …………………… (chưa khai báo trên StockPilot)')]));
  out.push(pad([text(`Mẫu số ${s2a ? 'S2a-HKD' : 'S1a-HKD'} (Kèm theo Thông tư 152/2025/TT-BTC)`)]));
  out.push(pad([text('SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ')]));
  out.push(pad([text(`Kỳ: ${meta.periodLabel}${meta.partialUntil ? ` — tạm tính đến ${vnDate(meta.partialUntil)}` : ''}`)]));
  out.push(pad([]));

  if (s2a) {
    out.push(row(text('Số hiệu chứng từ'), text('Ngày tháng chứng từ'), text('Diễn giải'), text('Số tiền (đồng)'), text('Ghi chú')));
    out.push(row('A', 'B', 'C', '1', 'D'));
    out.push(pad(['', '', text(`Ngành nghề: ${GOODS_BUSINESS_LINE}`)]));
  } else {
    out.push(row(text('Ngày tháng'), text('Diễn giải'), text('Số tiền (đồng)')));
    out.push(row('A', 'B', '1'));
  }

  if (!lines.length) {
    out.push(s2a
      ? pad(['', '', text('Không phát sinh doanh thu trong kỳ'), '0'])
      : row('', text('Không phát sinh doanh thu trong kỳ'), '0'));
  }
  for (const l of lines) {
    out.push(s2a
      ? row(text(l.reference), vnDate(l.date), text(l.description), money(l.amount), '')
      : row(vnDate(l.date), text(l.reference ? `${l.description} — chứng từ ${l.reference}` : l.description), money(l.amount)));
  }

  const total = money(revenueBookTotal(lines));
  if (s2a) {
    out.push(pad(['', '', text(`Tổng cộng doanh thu ngành nghề ${GOODS_BUSINESS_LINE}`), total]));
    out.push(pad(['', '', text('Tỷ lệ % tính thuế GTGT'), '', text('Do người nộp thuế/kế toán xác định')]));
    out.push(pad(['', '', text('Số thuế GTGT phải nộp'), '', text('Do người nộp thuế/kế toán xác định')]));
    out.push(pad(['', '', text('Thuế suất thuế TNCN'), '', text('Do người nộp thuế/kế toán xác định')]));
    out.push(pad(['', '', text('Số thuế TNCN phải nộp'), '', text('Do người nộp thuế/kế toán xác định')]));
  } else {
    out.push(row('', text('Tổng cộng'), total));
  }

  out.push(pad([]));
  out.push(pad([text('Ghi chú: Chỉ gồm doanh thu ghi nhận trên StockPilot (đơn đã giao, lịch sử bán đã nhập, trừ hàng trả lại). Nếu cửa hàng bán thêm qua kênh khác, cần cộng thêm.')]));
  out.push(pad([text('Sổ này hỗ trợ ghi chép, không thay thế hóa đơn điện tử. Đối chiếu với kế toán/cơ quan thuế trước khi kê khai.')]));
  out.push(pad([text(`Lập ngày ${vnDate(toBusinessDateKey(meta.generatedAt))} từ StockPilot`)]));
  out.push(pad([text('NGƯỜI ĐẠI DIỆN HỘ KINH DOANH / CÁ NHÂN KINH DOANH (Ký, họ tên)')]));

  return BOM + out.join('\r\n');
}
