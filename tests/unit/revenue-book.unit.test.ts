import {
  buildRevenueBookLines, renderRevenueBookCsv, revenueBookTotal, RevenueBookMeta,
} from '../../src/modules/tax-support/revenue-book';
import type { LedgerDay, LedgerOrderLine } from '../../src/modules/tax-support/revenue-ledger.service';
import { resolvePeriod } from '../../src/modules/tax-support/tax-support.service';
import { ValidationError } from '../../src/common/errors/app-error';

const day = (key: string, over: Partial<LedgerDay> = {}): LedgerDay => {
  const d = { day: key, sales: 0, imported: 0, returns: 0, orderCount: 0, firstOrderNo: null, lastOrderNo: null, ...over };
  return { ...d, net: d.sales + d.imported - d.returns };
};

const meta = (over: Partial<RevenueBookMeta> = {}): RevenueBookMeta => ({
  template: 'S1A', storeName: 'Tạp hóa An Phát', storeAddress: '12 Lê Lợi', periodLabel: 'Quý 3/2026 (01/07/2026 – 30/09/2026)',
  partialUntil: null, generatedAt: new Date('2026-11-01T03:00:00Z'), ...over,
});

const LEDGER = [
  day('2026-07-01', { sales: 1_250_000, orderCount: 3, firstOrderNo: 'HD001', lastOrderNo: 'HD003' }),
  day('2026-07-02', { returns: 200_000 }),
  day('2026-07-03', { sales: 90_000.5, orderCount: 1, firstOrderNo: 'HD004', lastOrderNo: 'HD004', imported: 300_000 }),
];

describe('buildRevenueBookLines (day mode)', () => {
  const lines = buildRevenueBookLines(LEDGER, 'day');

  it('writes one sales line per day with the document range, imported and returns as separate lines', () => {
    expect(lines.map((l) => [l.date, l.reference, l.amount])).toEqual([
      ['2026-07-01', 'HD001–HD003', 1_250_000],
      ['2026-07-02', '', -200_000],
      ['2026-07-03', 'HD004', 90_000.5],
      ['2026-07-03', '', 300_000],
    ]);
    expect(lines[0].description).toBe('Doanh thu bán hàng hóa ngày 01/07 (3 đơn)');
    expect(lines[1].description).toBe('Hàng bán bị trả lại ngày 02/07');
    expect(lines[3].description).toContain('nhập từ phần mềm cũ');
  });

  it('totals exactly the net revenue of the ledger (book = dashboard invariant)', () => {
    const net = LEDGER.reduce((s, d) => s + Math.round(d.net * 100), 0) / 100;
    expect(revenueBookTotal(lines)).toBe(net);
    expect(revenueBookTotal(lines)).toBe(1_440_000.5);
  });
});

describe('buildRevenueBookLines (order mode)', () => {
  const docs: LedgerOrderLine[] = [
    { day: '2026-07-01', reference: 'HD001', kind: 'SALE', amount: 500_000 },
    { day: '2026-07-01', reference: 'TH001', kind: 'RETURN', amount: 100_000 },
  ];
  const ledger = [day('2026-07-01', { sales: 500_000, returns: 100_000, orderCount: 1, firstOrderNo: 'HD001', lastOrderNo: 'HD001', imported: 70_000 })];

  it('lists each order and return, keeps imported history as a daily line, and does not double-count returns', () => {
    const lines = buildRevenueBookLines(ledger, 'order', docs);
    expect(lines.map((l) => [l.reference, l.description, l.amount])).toEqual([
      ['HD001', 'Bán hàng hóa', 500_000],
      ['TH001', 'Hàng bán bị trả lại', -100_000],
      ['', 'Doanh thu bán hàng ngày 01/07 (nhập từ phần mềm cũ)', 70_000],
    ]);
    expect(revenueBookTotal(lines)).toBe(ledger[0].net);
  });
});

describe('renderRevenueBookCsv', () => {
  const lines = buildRevenueBookLines(LEDGER, 'day');

  it('starts with a UTF-8 BOM and uses the S1a-HKD columns', () => {
    const csv = renderRevenueBookCsv(meta(), lines);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Mẫu số S1a-HKD (Kèm theo Thông tư 152/2025/TT-BTC)');
    expect(csv).toContain('Ngày tháng,Diễn giải,Số tiền (đồng)');
    expect(csv).toContain('01/07/2026,Doanh thu bán hàng hóa ngày 01/07 (3 đơn) — chứng từ HD001–HD003,1250000');
    expect(csv).toContain(',Tổng cộng,1440000.50');
  });

  it('writes negative amounts as plain numbers so Excel can sum them', () => {
    const csv = renderRevenueBookCsv(meta(), lines);
    expect(csv).toContain(',-200000');
    expect(csv).not.toContain("'-200000");
  });

  it('neutralizes spreadsheet formulas in text cells', () => {
    const csv = renderRevenueBookCsv(meta({ storeName: '=HYPERLINK("http://x")' }), lines);
    expect(csv).not.toMatch(/^HỘ, CÁ NHÂN KINH DOANH: =/m);
    expect(csv).toContain('"HỘ, CÁ NHÂN KINH DOANH: =HYPERLINK(""http://x"")"');
  });

  it('marks a running period as provisional', () => {
    const csv = renderRevenueBookCsv(meta({ partialUntil: '2026-08-15' }), lines);
    expect(csv).toContain('tạm tính đến 15/08/2026');
  });

  it('writes a zero book when nothing was sold', () => {
    const csv = renderRevenueBookCsv(meta(), []);
    expect(csv).toContain('Không phát sinh doanh thu trong kỳ,0');
    expect(csv).toContain(',Tổng cộng,0');
  });

  it('S2a-HKD groups revenue under the goods business line and leaves tax rates blank', () => {
    const csv = renderRevenueBookCsv(meta({ template: 'S2A' }), lines);
    expect(csv).toContain('Mẫu số S2a-HKD');
    expect(csv).toContain('Số hiệu chứng từ,Ngày tháng chứng từ,Diễn giải,Số tiền (đồng),Ghi chú');
    expect(csv).toContain(',,"Ngành nghề: Phân phối, cung cấp hàng hóa",,');
    expect(csv).toContain('HD001–HD003,01/07/2026,Doanh thu bán hàng hóa ngày 01/07 (3 đơn),1250000,');
    expect(csv).toContain(',,Tỷ lệ % tính thuế GTGT,,Do người nộp thuế/kế toán xác định');
    expect(csv).not.toMatch(/Tỷ lệ % tính thuế GTGT,\d/);
  });

  it('stamps the generation date in Vietnam time', () => {
    // 20:00 UTC on 31/10 is already 01/11 in Vietnam.
    const csv = renderRevenueBookCsv(meta({ generatedAt: new Date('2026-10-31T20:00:00Z') }), lines);
    expect(csv).toContain('Lập ngày 01/11/2026');
  });
});

describe('resolvePeriod', () => {
  const today = '2026-11-01';

  it('resolves a past quarter to its full calendar range', () => {
    expect(resolvePeriod({ period: 'quarter', year: 2026, quarter: 3 }, today)).toEqual({
      fromKey: '2026-07-01', toKey: '2026-09-30', label: 'Quý 3/2026 (01/07/2026 – 30/09/2026)', partialUntil: null, fileSuffix: '2026-Q3',
    });
  });

  it('clamps the running period to today', () => {
    expect(resolvePeriod({ period: 'quarter', year: 2026, quarter: 4 }, today)).toMatchObject({ fromKey: '2026-10-01', toKey: '2026-11-01', partialUntil: '2026-11-01' });
    expect(resolvePeriod({ period: 'month', year: 2024, month: 2 }, today)).toMatchObject({ fromKey: '2024-02-01', toKey: '2024-02-29' });
  });

  it('rejects a period that has not started', () => {
    expect(() => resolvePeriod({ period: 'month', year: 2026, month: 12 }, today)).toThrow(ValidationError);
    expect(() => resolvePeriod({ period: 'year', year: 2027 }, today)).toThrow(ValidationError);
  });
});
