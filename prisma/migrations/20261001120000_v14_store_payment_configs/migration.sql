-- Phase 3B: per-store payment provider credential foundation.
CREATE TABLE `store_payment_configs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `provider` ENUM('PAYOS') NOT NULL,
    `clientIdEncrypted` TEXT NOT NULL,
    `apiKeyEncrypted` TEXT NOT NULL,
    `checksumKeyEncrypted` TEXT NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `configuredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `store_payment_configs_storeId_provider_key`(`storeId`, `provider`),
    INDEX `store_payment_configs_storeId_isActive_idx`(`storeId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `store_payment_configs`
    ADD CONSTRAINT `store_payment_configs_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
