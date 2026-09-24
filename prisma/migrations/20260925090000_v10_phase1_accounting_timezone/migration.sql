-- V10 Phase 1 accounting and business-date hardening
-- Historical cost is optional metadata and does not change sourceRowHash identity.

ALTER TABLE `historical_sales`
  ADD COLUMN `costPriceSnapshot` DECIMAL(15, 2) NULL;

ALTER TABLE `daily_sales_summaries`
  ADD COLUMN `historicalCostMissingQty` INT NOT NULL DEFAULT 0;

ALTER TABLE `historical_sales`
  ADD CONSTRAINT `historical_sales_costPriceSnapshot_non_negative`
  CHECK (`costPriceSnapshot` IS NULL OR `costPriceSnapshot` >= 0);

ALTER TABLE `daily_sales_summaries`
  ADD CONSTRAINT `daily_sales_summaries_historicalCostMissingQty_non_negative`
  CHECK (`historicalCostMissingQty` >= 0);
