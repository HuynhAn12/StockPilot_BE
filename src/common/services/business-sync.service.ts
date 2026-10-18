import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { DecisionEngineService } from '../../modules/decision-engine/decision-engine.service';
import { DailySalesSummaryService } from '../../modules/daily-sales-summary/daily-sales-summary.service';
import { logger } from '../logger';
import { toBusinessDateKey, businessDateKeyToDate } from '../utils/business-date';

export class BusinessSyncService {
  private static instance: BusinessSyncService | null = null;
  private readonly decisionEngine: DecisionEngineService;
  private readonly dailySalesService: DailySalesSummaryService;

  constructor(private readonly prisma: PrismaClient = defaultPrisma) {
    this.decisionEngine = new DecisionEngineService(prisma);
    this.dailySalesService = new DailySalesSummaryService(prisma);
  }

  public static getInstance(prisma: PrismaClient = defaultPrisma): BusinessSyncService {
    if (!BusinessSyncService.instance) {
      BusinessSyncService.instance = new BusinessSyncService(prisma);
    }
    return BusinessSyncService.instance;
  }

  /**
   * Re-evaluates risk alerts, coverage, and pricing recommendations for a list of SKUs.
   */
  async syncStockItems(storeId: number, stockItemIds: number[]): Promise<void> {
    const uniqueIds = Array.from(new Set(stockItemIds.filter((id) => Boolean(id) && id > 0)));
    if (uniqueIds.length === 0) return;

    for (const stockItemId of uniqueIds) {
      try {
        await this.decisionEngine.analyzeSku(storeId, stockItemId, { persist: true });
      } catch (err) {
        logger.warn('business_sync_sku_failed', {
          storeId,
          stockItemId,
          error: (err as any)?.message || err,
        });
      }
    }
  }

  /**
   * Called immediately after a POS sale or Order fulfillment.
   * Updates today's sales summary facts and re-evaluates sold stock items.
   */
  async syncAfterSale(storeId: number, stockItemIds: number[]): Promise<void> {
    try {
      const todayKey = toBusinessDateKey(new Date());
      const todayDate = businessDateKeyToDate(todayKey);
      await this.dailySalesService.rebuildDailySalesSummary(storeId, todayDate, todayDate).catch(() => {});
      await this.syncStockItems(storeId, stockItemIds);
    } catch (err) {
      logger.warn('business_sync_after_sale_failed', {
        storeId,
        stockItemIds,
        error: (err as any)?.message || err,
      });
    }
  }

  /**
   * Called after inventory inflow (nhập kho), outflow (xuất kho), or audit adjustment (kiểm kê).
   */
  async syncAfterInventoryMovement(storeId: number, stockItemIds: number[]): Promise<void> {
    try {
      await this.syncStockItems(storeId, stockItemIds);
    } catch (err) {
      logger.warn('business_sync_after_inventory_failed', {
        storeId,
        stockItemIds,
        error: (err as any)?.message || err,
      });
    }
  }

  /**
   * Called after an order is canceled, returned, or refunded.
   */
  async syncAfterCancelOrReturn(storeId: number, stockItemIds: number[]): Promise<void> {
    try {
      const todayKey = toBusinessDateKey(new Date());
      const todayDate = businessDateKeyToDate(todayKey);
      await this.dailySalesService.rebuildDailySalesSummary(storeId, todayDate, todayDate).catch(() => {});
      await this.syncStockItems(storeId, stockItemIds);
    } catch (err) {
      logger.warn('business_sync_after_cancel_failed', {
        storeId,
        stockItemIds,
        error: (err as any)?.message || err,
      });
    }
  }

  /**
   * Called after a stock item's selling price or cost price changes.
   */
  async syncAfterPriceChange(storeId: number, stockItemId: number): Promise<void> {
    try {
      await this.syncStockItems(storeId, [stockItemId]);
    } catch (err) {
      logger.warn('business_sync_after_price_change_failed', {
        storeId,
        stockItemId,
        error: (err as any)?.message || err,
      });
    }
  }
}
