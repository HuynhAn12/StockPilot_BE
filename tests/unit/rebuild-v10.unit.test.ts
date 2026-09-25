import { parseStoreIdArg, runRebuildDailySalesSummaryV10 } from '../../scripts/rebuild-daily-sales-summary-v10';

describe('V10 daily sales summary rebuild maintenance guard', () => {
  it.each([
    ['1', 1],
    ['123', 123],
  ])('accepts valid --storeId=%s', (raw, expected) => {
    expect(parseStoreIdArg(raw)).toBe(expected);
  });

  it.each(['abc', '', '0', '-1', '1.5'])('rejects invalid --storeId=%s', (raw) => {
    expect(() => parseStoreIdArg(raw)).toThrow('Invalid --storeId value');
  });

  it('rejects invalid programmatic storeId before any database rebuild operation', async () => {
    const prisma = {
      store: { findMany: jest.fn() },
    };

    await expect(runRebuildDailySalesSummaryV10(prisma as any, { storeId: Number.NaN })).rejects.toThrow(
      'Invalid storeId'
    );
    expect(prisma.store.findMany).not.toHaveBeenCalled();
  });
});
