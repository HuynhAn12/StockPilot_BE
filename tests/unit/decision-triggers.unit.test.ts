import { NotFoundError } from '../../src/common/errors/app-error';
import { DecisionRecomputeQueue } from '../../src/modules/decision-engine/recompute-queue';
import { DecisionScheduler, hourInTimeZone } from '../../src/modules/decision-engine/decision-scheduler';
import { BusinessSyncService } from '../../src/common/services/business-sync.service';

describe('DecisionRecomputeQueue', () => {
  function createQueue() {
    const recomputeSku = jest.fn().mockResolvedValue({});
    const rebuildDailySalesSummary = jest.fn().mockResolvedValue({ updatedDays: 1 });
    const queue = new DecisionRecomputeQueue({ recomputeSku } as any, { rebuildDailySalesSummary } as any, 10_000);
    return { queue, recomputeSku, rebuildDailySalesSummary };
  }

  it('coalesces repeated events for the same SKU into one recomputation', async () => {
    const { queue, recomputeSku } = createQueue();

    const waits = [queue.enqueue(1, [10, 11]), queue.enqueue(1, [10]), queue.enqueue(1, [11, 10])];
    expect(queue.pendingSkuCount()).toBe(2);
    await queue.flush();
    await Promise.all(waits);

    expect(recomputeSku).toHaveBeenCalledTimes(2);
    expect(recomputeSku).toHaveBeenCalledWith(1, 10);
    expect(recomputeSku).toHaveBeenCalledWith(1, 11);
  });

  it('keeps stores isolated and rebuilds the covered summary range before recomputing', async () => {
    const { queue, recomputeSku, rebuildDailySalesSummary } = createQueue();
    const order: string[] = [];
    rebuildDailySalesSummary.mockImplementation(async (storeId: number) => order.push(`summary:${storeId}`));
    recomputeSku.mockImplementation(async (storeId: number, id: number) => order.push(`sku:${storeId}:${id}`));

    queue.enqueue(1, [10], { summaryDateKeys: ['2026-10-20'] });
    queue.enqueue(1, [], { summaryDateKeys: ['2026-10-05', '2026-10-12'] });
    queue.enqueue(2, [10]);
    await queue.flush();

    expect(order).toEqual(['summary:1', 'sku:1:10', 'sku:2:10']);
    const [storeId, from, to] = rebuildDailySalesSummary.mock.calls[0];
    expect(storeId).toBe(1);
    expect((from as Date).toISOString().slice(0, 10)).toBe('2026-10-05');
    expect((to as Date).toISOString().slice(0, 10)).toBe('2026-10-20');
  });

  it('never rejects: failures and deleted SKUs are logged and the batch continues', async () => {
    const { queue, recomputeSku } = createQueue();
    recomputeSku
      .mockRejectedValueOnce(new NotFoundError('gone'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({});

    const done = queue.enqueue(1, [1, 2, 3]);
    await queue.flush();

    await expect(done).resolves.toBeUndefined();
    expect(recomputeSku).toHaveBeenCalledTimes(3);
  });

  it('processes work that arrives during a drain in the next cycle', async () => {
    const { queue, recomputeSku } = createQueue();
    let releaseFirst: () => void = () => {};
    recomputeSku.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = () => resolve({}))));

    queue.enqueue(1, [10]);
    const draining = queue.flush();
    await new Promise((resolve) => setImmediate(resolve));
    const late = queue.enqueue(1, [10]);
    releaseFirst();
    await draining;
    await late;

    expect(recomputeSku).toHaveBeenCalledTimes(2);
  });

  it('ignores empty or invalid input', async () => {
    const { queue, recomputeSku } = createQueue();
    await queue.enqueue(1, [0, -1, Number.NaN]);
    await queue.flush();
    expect(recomputeSku).not.toHaveBeenCalled();
  });
});

describe('DecisionScheduler', () => {
  // 2026-10-26T18:30:00Z is 01:30 on 2026-10-27 in Asia/Ho_Chi_Minh (UTC+7).
  const insideWindow = new Date('2026-10-26T18:30:00Z');
  const outsideWindow = new Date('2026-10-26T10:00:00Z');

  it('derives the local hour from the configured time zone', () => {
    expect(hourInTimeZone(insideWindow, 'Asia/Ho_Chi_Minh')).toBe(1);
    expect(hourInTimeZone(insideWindow, 'UTC')).toBe(18);
  });

  it('runs only during the nightly hour and never overlaps within the process', async () => {
    let finish: () => void = () => {};
    const runNightly = jest.fn(() => new Promise<null>((resolve) => (finish = () => resolve(null))));
    const scheduler = new DecisionScheduler({ runNightly } as any, 1, 'Asia/Ho_Chi_Minh');

    await scheduler.tick(outsideWindow);
    expect(runNightly).not.toHaveBeenCalled();

    const first = scheduler.tick(insideWindow);
    const overlapping = scheduler.tick(insideWindow);
    await overlapping;
    expect(runNightly).toHaveBeenCalledTimes(1);

    finish();
    await first;
    await scheduler.stop();
  });

  it('survives a failing nightly run', async () => {
    const runNightly = jest.fn().mockRejectedValue(new Error('boom'));
    const scheduler = new DecisionScheduler({ runNightly } as any, 1, 'Asia/Ho_Chi_Minh');

    await expect(scheduler.tick(insideWindow)).resolves.toBeUndefined();
    await expect(scheduler.tick(insideWindow)).resolves.toBeUndefined();
    expect(runNightly).toHaveBeenCalledTimes(2);
  });
});

describe('BusinessSyncService.fireAndForget', () => {
  it('swallows synchronous throws and async rejections from post-commit triggers', async () => {
    expect(() =>
      BusinessSyncService.fireAndForget({} as any, () => {
        throw new TypeError('items is undefined');
      })
    ).not.toThrow();

    expect(() => BusinessSyncService.fireAndForget({} as any, () => Promise.reject(new Error('queue')))).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
