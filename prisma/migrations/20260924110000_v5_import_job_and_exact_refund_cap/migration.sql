-- AlterTable order_items
ALTER TABLE `order_items` 
    ADD COLUMN `refundableAmount` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `refundedAmount` DECIMAL(15, 2) NOT NULL DEFAULT 0.00;

-- Backfill refundableAmount to match historical order item subtotal
UPDATE `order_items` SET `refundableAmount` = `subtotal` WHERE `refundableAmount` = 0.00;

-- Backfill refundedAmount from existing return items
UPDATE `order_items` oi
LEFT JOIN (
    SELECT `orderItemId`, SUM(`refundPrice`) AS total_refunded
    FROM `return_items`
    GROUP BY `orderItemId`
) r ON r.`orderItemId` = oi.`id`
SET oi.`refundedAmount` = COALESCE(r.total_refunded, 0.00);

-- CreateTable import_jobs
CREATE TABLE `import_jobs` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` INTEGER NOT NULL,
    `createdById` INTEGER NULL,
    `type` VARCHAR(50) NOT NULL,
    `payloadHash` VARCHAR(64) NOT NULL,
    `payloadJson` JSON NOT NULL,
    `status` ENUM('PREVIEWED', 'COMMITTING', 'COMPLETED', 'FAILED', 'EXPIRED') NOT NULL DEFAULT 'PREVIEWED',
    `totalRows` INTEGER NOT NULL DEFAULT 0,
    `validRows` INTEGER NOT NULL DEFAULT 0,
    `invalidRows` INTEGER NOT NULL DEFAULT 0,
    `warningRows` INTEGER NOT NULL DEFAULT 0,
    `resultJson` JSON NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `import_jobs_storeId_createdAt_idx`(`storeId`, `createdAt`),
    INDEX `import_jobs_storeId_payloadHash_idx`(`storeId`, `payloadHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable IF NOT EXISTS auth_sessions
CREATE TABLE IF NOT EXISTS `auth_sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `refreshTokenHash` VARCHAR(255) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `userAgent` VARCHAR(255) NULL,
    `ipAddress` VARCHAR(50) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    INDEX `auth_sessions_userId_idx`(`userId`),
    INDEX `auth_sessions_refreshTokenHash_idx`(`refreshTokenHash`),
    PRIMARY KEY (`id`),
    CONSTRAINT `auth_sessions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `import_jobs` ADD CONSTRAINT `import_jobs_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_jobs` ADD CONSTRAINT `import_jobs_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

