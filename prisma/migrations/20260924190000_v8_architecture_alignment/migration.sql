-- CreateEnum
-- Add PricingAction
-- Rename tables and align schemas

-- DropForeignKey
ALTER TABLE `daily_sku_metrics` DROP FOREIGN KEY `daily_sku_metrics_storeId_fkey`;
ALTER TABLE `daily_sku_metrics` DROP FOREIGN KEY `daily_sku_metrics_stockItemId_fkey`;
ALTER TABLE `stock_policies` DROP FOREIGN KEY `stock_policies_storeId_fkey`;
ALTER TABLE `stock_policies` DROP FOREIGN KEY `stock_policies_stockItemId_fkey`;
ALTER TABLE `smart_alerts` DROP FOREIGN KEY `smart_alerts_storeId_fkey`;
ALTER TABLE `smart_alerts` DROP FOREIGN KEY `smart_alerts_stockItemId_fkey`;

-- DropTable
DROP TABLE `daily_sku_metrics`;
DROP TABLE `stock_policies`;
DROP TABLE `smart_alerts`;

-- CreateTable DailySalesSummary
CREATE TABLE `daily_sales_summaries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `stockItemId` INTEGER NOT NULL,
    `summaryDate` DATE NOT NULL,
    `grossSoldQty` INTEGER NOT NULL DEFAULT 0,
    `returnQty` INTEGER NOT NULL DEFAULT 0,
    `netSoldQty` INTEGER NOT NULL DEFAULT 0,
    `grossRevenue` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `refundAmount` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `netRevenue` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `cogs` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `grossProfit` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `orderCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `daily_sales_summaries_storeId_summaryDate_idx`(`storeId`, `summaryDate`),
    INDEX `daily_sales_summaries_storeId_stockItemId_summaryDate_idx`(`storeId`, `stockItemId`, `summaryDate`),
    UNIQUE INDEX `daily_sales_summaries_storeId_stockItemId_summaryDate_key`(`storeId`, `stockItemId`, `summaryDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable EngineConfig
CREATE TABLE `engine_configs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `leadTimeDays` INTEGER NOT NULL DEFAULT 7,
    `safetyDays` INTEGER NOT NULL DEFAULT 3,
    `serviceLevel` DECIMAL(5, 4) NOT NULL DEFAULT 0.9500,
    `targetCoverageDays` INTEGER NOT NULL DEFAULT 30,
    `slowMovingDays` INTEGER NOT NULL DEFAULT 60,
    `deadStockDays` INTEGER NOT NULL DEFAULT 90,
    `minimumHistoryDays` INTEGER NOT NULL DEFAULT 14,
    `minimumMarginPct` DECIMAL(6, 4) NOT NULL DEFAULT 0.2000,
    `maxMarkdownPct` DECIMAL(6, 4) NOT NULL DEFAULT 0.3000,
    `maxMarkupPct` DECIMAL(6, 4) NOT NULL DEFAULT 0.2000,
    `lowRiskThreshold` INTEGER NOT NULL DEFAULT 25,
    `highRiskThreshold` INTEGER NOT NULL DEFAULT 50,
    `criticalRiskThreshold` INTEGER NOT NULL DEFAULT 75,
    `engineVersion` VARCHAR(50) NOT NULL DEFAULT 'DECISION_ENGINE_V1',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `engine_configs_storeId_key`(`storeId`),
    INDEX `engine_configs_storeId_idx`(`storeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable Alert
CREATE TABLE `alerts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `stockItemId` INTEGER NOT NULL,
    `type` ENUM('LOW_STOCK', 'STOCKOUT', 'OVERSTOCK_DEADSTOCK', 'UNUSUAL_DEMAND') NOT NULL,
    `severity` ENUM('INFO', 'WARNING', 'CRITICAL') NOT NULL,
    `status` ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `riskScore` DECIMAL(5, 2) NULL,
    `confidence` DECIMAL(5, 2) NULL DEFAULT 100.00,
    `title` VARCHAR(255) NOT NULL,
    `message` TEXT NOT NULL,
    `reasonJson` JSON NOT NULL,
    `fingerprint` VARCHAR(64) NOT NULL,
    `engineVersion` VARCHAR(50) NOT NULL DEFAULT 'DECISION_ENGINE_V1',
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `alerts_storeId_status_severity_idx`(`storeId`, `status`, `severity`),
    INDEX `alerts_storeId_stockItemId_idx`(`storeId`, `stockItemId`),
    UNIQUE INDEX `alerts_storeId_fingerprint_key`(`storeId`, `fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable PricingRecommendation
ALTER TABLE `pricing_recommendations`
    ADD COLUMN `action` ENUM('INCREASE', 'DECREASE', 'MAINTAIN') NOT NULL DEFAULT 'MAINTAIN',
    ADD COLUMN `confidence` DECIMAL(5, 2) NULL DEFAULT 100.00,
    ADD COLUMN `engineVersion` VARCHAR(50) NOT NULL DEFAULT 'DECISION_ENGINE_V1',
    ADD COLUMN `finalUserSelectedPrice` DECIMAL(15, 2) NULL,
    CHANGE COLUMN `score` `riskScore` DECIMAL(5, 2) NULL;

-- CreateTable PriceHistory
CREATE TABLE `price_histories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `stockItemId` INTEGER NOT NULL,
    `oldPrice` DECIMAL(15, 2) NOT NULL,
    `newPrice` DECIMAL(15, 2) NOT NULL,
    `source` VARCHAR(50) NOT NULL,
    `recommendationId` INTEGER NULL,
    `reason` TEXT NULL,
    `changedById` INTEGER NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `price_histories_storeId_stockItemId_changedAt_idx`(`storeId`, `stockItemId`, `changedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `daily_sales_summaries` ADD CONSTRAINT `daily_sales_summaries_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `daily_sales_summaries` ADD CONSTRAINT `daily_sales_summaries_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `engine_configs` ADD CONSTRAINT `engine_configs_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `alerts` ADD CONSTRAINT `alerts_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `alerts` ADD CONSTRAINT `alerts_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `price_histories` ADD CONSTRAINT `price_histories_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `price_histories` ADD CONSTRAINT `price_histories_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `price_histories` ADD CONSTRAINT `price_histories_changedById_fkey` FOREIGN KEY (`changedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `price_histories` ADD CONSTRAINT `price_histories_recommendationId_fkey` FOREIGN KEY (`recommendationId`) REFERENCES `pricing_recommendations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
