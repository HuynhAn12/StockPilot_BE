-- AlterTable historical_sales
ALTER TABLE `historical_sales` ADD COLUMN `sourceRowHash` VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE `historical_sales` ADD CONSTRAINT `historical_sales_storeId_sourceRowHash_key` UNIQUE (`storeId`, `sourceRowHash`);
ALTER TABLE `historical_sales` ADD CONSTRAINT `historical_sales_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `historical_sales` ADD CONSTRAINT `historical_sales_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable daily_sku_metrics
CREATE TABLE `daily_sku_metrics` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `stockItemId` INTEGER NOT NULL,
    `metricDate` DATE NOT NULL,
    `grossSoldQty` INTEGER NOT NULL DEFAULT 0,
    `returnedQty` INTEGER NOT NULL DEFAULT 0,
    `netSoldQty` INTEGER NOT NULL DEFAULT 0,
    `grossRevenue` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `refundAmount` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `netRevenue` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `orderCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `daily_sku_metrics_storeId_stockItemId_metricDate_key`(`storeId`, `stockItemId`, `metricDate`),
    INDEX `daily_sku_metrics_storeId_metricDate_idx`(`storeId`, `metricDate`),
    INDEX `daily_sku_metrics_storeId_stockItemId_metricDate_idx`(`storeId`, `stockItemId`, `metricDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable stock_policies
CREATE TABLE `stock_policies` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `stockItemId` INTEGER NOT NULL,
    `leadTimeDays` INTEGER NOT NULL DEFAULT 7,
    `safetyDays` INTEGER NOT NULL DEFAULT 3,
    `serviceLevel` DECIMAL(5, 4) NOT NULL DEFAULT 0.9500,
    `targetCoverageDays` INTEGER NOT NULL DEFAULT 30,
    `deadStockDays` INTEGER NOT NULL DEFAULT 90,
    `minimumMarginPct` DECIMAL(6, 4) NOT NULL DEFAULT 0.1000,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `stock_policies_storeId_stockItemId_key`(`storeId`, `stockItemId`),
    INDEX `stock_policies_storeId_idx`(`storeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable smart_alerts
CREATE TABLE `smart_alerts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `stockItemId` INTEGER NOT NULL,
    `type` ENUM('LOW_STOCK', 'STOCKOUT', 'OVERSTOCK_DEADSTOCK', 'UNUSUAL_DEMAND') NOT NULL,
    `severity` ENUM('INFO', 'WARNING', 'CRITICAL') NOT NULL,
    `status` ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `score` DECIMAL(5, 2) NULL,
    `title` VARCHAR(255) NOT NULL,
    `message` TEXT NOT NULL,
    `reasonJson` JSON NOT NULL,
    `fingerprint` VARCHAR(64) NOT NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `smart_alerts_storeId_fingerprint_key`(`storeId`, `fingerprint`),
    INDEX `smart_alerts_storeId_status_severity_idx`(`storeId`, `status`, `severity`),
    INDEX `smart_alerts_storeId_stockItemId_idx`(`storeId`, `stockItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable pricing_recommendations
CREATE TABLE `pricing_recommendations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `stockItemId` INTEGER NOT NULL,
    `currentPrice` DECIMAL(15, 2) NOT NULL,
    `recommendedPrice` DECIMAL(15, 2) NOT NULL,
    `discountPct` DECIMAL(5, 2) NOT NULL,
    `score` DECIMAL(5, 2) NULL,
    `reasonJson` JSON NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'MODIFIED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `acceptedPrice` DECIMAL(15, 2) NULL,
    `decidedById` INTEGER NULL,
    `decidedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    INDEX `pricing_recommendations_storeId_status_idx`(`storeId`, `status`),
    INDEX `pricing_recommendations_storeId_stockItemId_idx`(`storeId`, `stockItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable decision_snapshots
CREATE TABLE `decision_snapshots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `stockItemId` INTEGER NOT NULL,
    `calculatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `inputJson` JSON NOT NULL,
    `metricsJson` JSON NOT NULL,
    `risksJson` JSON NOT NULL,
    `version` VARCHAR(50) NOT NULL DEFAULT 'DECISION_ENGINE_V1',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `decision_snapshots_storeId_stockItemId_calculatedAt_idx`(`storeId`, `stockItemId`, `calculatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKeys
ALTER TABLE `daily_sku_metrics` ADD CONSTRAINT `daily_sku_metrics_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `daily_sku_metrics` ADD CONSTRAINT `daily_sku_metrics_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `stock_policies` ADD CONSTRAINT `stock_policies_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `stock_policies` ADD CONSTRAINT `stock_policies_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `smart_alerts` ADD CONSTRAINT `smart_alerts_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `smart_alerts` ADD CONSTRAINT `smart_alerts_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `pricing_recommendations` ADD CONSTRAINT `pricing_recommendations_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `pricing_recommendations` ADD CONSTRAINT `pricing_recommendations_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `pricing_recommendations` ADD CONSTRAINT `pricing_recommendations_decidedById_fkey` FOREIGN KEY (`decidedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `decision_snapshots` ADD CONSTRAINT `decision_snapshots_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `decision_snapshots` ADD CONSTRAINT `decision_snapshots_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
