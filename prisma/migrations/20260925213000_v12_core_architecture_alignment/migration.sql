-- V12 Core Architecture Alignment with Database Design v1.1.
-- Adds six foundation tables, aligns AlertType taxonomy, and tightens key DB constraints.

-- Preserve existing alert rows before removing the legacy combined enum value.
UPDATE `alerts`
SET `type` = 'OVERSTOCK'
WHERE `type` = 'OVERSTOCK_DEADSTOCK';

ALTER TABLE `alerts`
  MODIFY COLUMN `type` ENUM(
    'LOW_STOCK',
    'STOCKOUT',
    'OVERSTOCK',
    'SLOW_MOVING',
    'DEAD_STOCK',
    'UNUSUAL_DEMAND'
  ) NOT NULL;

ALTER TABLE `inventory_balances`
  ADD CONSTRAINT `chk_inventory_quantity_non_negative`
    CHECK (`quantity` >= 0),
  ADD CONSTRAINT `chk_inventory_reserved_non_negative`
    CHECK (`reservedQuantity` >= 0),
  ADD CONSTRAINT `chk_inventory_reserved_not_exceed_quantity`
    CHECK (`reservedQuantity` <= `quantity`);

CREATE INDEX `return_items_restockWarehouseId_idx`
  ON `return_items`(`restockWarehouseId`);

ALTER TABLE `return_items`
  ADD CONSTRAINT `return_items_restockWarehouseId_fkey`
    FOREIGN KEY (`restockWarehouseId`) REFERENCES `warehouses`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `import_job_items_stockItemId_idx`
  ON `import_job_items`(`stockItemId`);

ALTER TABLE `import_job_items`
  ADD CONSTRAINT `import_job_items_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `idempotency_requests`
  ADD CONSTRAINT `idempotency_requests_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `system_settings` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `key` VARCHAR(100) NOT NULL,
  `valueJson` JSON NOT NULL,
  `description` VARCHAR(255) NULL,
  `isPublic` BOOLEAN NOT NULL DEFAULT false,
  `updatedById` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `system_settings_key_key`(`key`),
  INDEX `system_settings_updatedById_idx`(`updatedById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `stock_takes` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `storeId` INTEGER NOT NULL,
  `warehouseId` INTEGER NOT NULL,
  `status` ENUM('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELED') NOT NULL DEFAULT 'DRAFT',
  `startedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `note` TEXT NULL,
  `createdById` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX `stock_takes_storeId_warehouseId_status_createdAt_idx`(`storeId`, `warehouseId`, `status`, `createdAt`),
  INDEX `stock_takes_createdById_idx`(`createdById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `stock_take_items` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `storeId` INTEGER NOT NULL,
  `stockTakeId` INTEGER NOT NULL,
  `stockItemId` INTEGER NOT NULL,
  `expectedQuantity` INTEGER NOT NULL,
  `countedQuantity` INTEGER NOT NULL,
  `varianceQuantity` INTEGER NOT NULL,
  `adjustmentMovementId` INTEGER NULL,
  `note` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `stock_take_items_stockTakeId_stockItemId_key`(`stockTakeId`, `stockItemId`),
  INDEX `stock_take_items_storeId_idx`(`storeId`),
  INDEX `stock_take_items_stockItemId_idx`(`stockItemId`),
  INDEX `stock_take_items_adjustmentMovementId_idx`(`adjustmentMovementId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `notifications` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `storeId` INTEGER NOT NULL,
  `userId` INTEGER NULL,
  `type` VARCHAR(50) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `message` TEXT NOT NULL,
  `entityType` VARCHAR(50) NULL,
  `entityId` VARCHAR(100) NULL,
  `isRead` BOOLEAN NOT NULL DEFAULT false,
  `readAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `notifications_storeId_userId_isRead_createdAt_idx`(`storeId`, `userId`, `isRead`, `createdAt`),
  INDEX `notifications_storeId_createdAt_idx`(`storeId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `audit_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `storeId` INTEGER NULL,
  `userId` INTEGER NULL,
  `action` VARCHAR(100) NOT NULL,
  `entityType` VARCHAR(50) NOT NULL,
  `entityId` VARCHAR(100) NULL,
  `beforeJson` JSON NULL,
  `afterJson` JSON NULL,
  `ipAddress` VARCHAR(50) NULL,
  `userAgent` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `audit_logs_storeId_createdAt_idx`(`storeId`, `createdAt`),
  INDEX `audit_logs_userId_createdAt_idx`(`userId`, `createdAt`),
  INDEX `audit_logs_entityType_entityId_createdAt_idx`(`entityType`, `entityId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_interactions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `storeId` INTEGER NOT NULL,
  `userId` INTEGER NULL,
  `conversationId` VARCHAR(191) NULL,
  `requestId` VARCHAR(191) NULL,
  `model` VARCHAR(100) NOT NULL,
  `questionText` TEXT NULL,
  `responseText` MEDIUMTEXT NULL,
  `contextSummaryJson` JSON NULL,
  `inputTokens` INTEGER NOT NULL DEFAULT 0,
  `outputTokens` INTEGER NOT NULL DEFAULT 0,
  `latencyMs` INTEGER NULL,
  `status` ENUM('SUCCESS', 'FAILED', 'TIMEOUT') NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `ai_interactions_requestId_key`(`requestId`),
  INDEX `ai_interactions_storeId_userId_createdAt_idx`(`storeId`, `userId`, `createdAt`),
  INDEX `ai_interactions_conversationId_createdAt_idx`(`conversationId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `system_settings`
  ADD CONSTRAINT `system_settings_updatedById_fkey`
    FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `stock_takes`
  ADD CONSTRAINT `stock_takes_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `stock_takes_warehouseId_fkey`
    FOREIGN KEY (`warehouseId`) REFERENCES `warehouses`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `stock_takes_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `users`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `stock_take_items`
  ADD CONSTRAINT `stock_take_items_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `stock_take_items_stockTakeId_fkey`
    FOREIGN KEY (`stockTakeId`) REFERENCES `stock_takes`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `stock_take_items_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `stock_take_items_adjustmentMovementId_fkey`
    FOREIGN KEY (`adjustmentMovementId`) REFERENCES `stock_movements`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `chk_stock_take_item_expected_non_negative`
    CHECK (`expectedQuantity` >= 0),
  ADD CONSTRAINT `chk_stock_take_item_counted_non_negative`
    CHECK (`countedQuantity` >= 0),
  ADD CONSTRAINT `chk_stock_take_item_variance_consistency`
    CHECK (`varianceQuantity` = `countedQuantity` - `expectedQuantity`);

ALTER TABLE `notifications`
  ADD CONSTRAINT `notifications_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `notifications_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `audit_logs`
  ADD CONSTRAINT `audit_logs_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `audit_logs_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `ai_interactions`
  ADD CONSTRAINT `ai_interactions_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `ai_interactions_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
