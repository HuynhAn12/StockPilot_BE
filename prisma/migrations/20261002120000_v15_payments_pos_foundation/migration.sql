-- Phase 4: POS payment record foundation.
-- Payment records support CASH and PAYOS providers. Store payment configuration
-- remains PayOS-only and must not accept CASH credential config rows.

CREATE TABLE `payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `orderId` INTEGER NOT NULL,
    `provider` ENUM('CASH', 'PAYOS') NOT NULL,
    `method` ENUM('CASH', 'BANK_TRANSFER', 'PAYOS') NOT NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `currency` VARCHAR(3) NOT NULL DEFAULT 'VND',
    `status` ENUM('PENDING', 'PAID', 'FAILED', 'CANCELED', 'REFUNDED', 'PARTIALLY_REFUNDED') NOT NULL DEFAULT 'PENDING',
    `providerReference` VARCHAR(191) NULL,
    `clientRequestKey` VARCHAR(200) NULL,
    `metadataJson` JSON NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payments_storeId_clientRequestKey_key`(`storeId`, `clientRequestKey`),
    UNIQUE INDEX `payments_storeId_provider_providerReference_key`(`storeId`, `provider`, `providerReference`),
    INDEX `payments_storeId_orderId_idx`(`storeId`, `orderId`),
    INDEX `payments_storeId_status_createdAt_idx`(`storeId`, `status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `payments`
    ADD CONSTRAINT `payments_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `payments`
    ADD CONSTRAINT `payments_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
