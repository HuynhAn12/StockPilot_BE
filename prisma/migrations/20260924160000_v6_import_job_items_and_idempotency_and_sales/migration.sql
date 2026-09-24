-- CreateTable import_job_items
CREATE TABLE `import_job_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `importJobId` VARCHAR(191) NOT NULL,
    `rowNumber` INTEGER NOT NULL,
    `stockItemId` INTEGER NULL,
    `sku` VARCHAR(100) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `resultJson` JSON NULL,
    `errorJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    INDEX `import_job_items_importJobId_status_idx`(`importJobId`, `status`),
    UNIQUE INDEX `import_job_items_importJobId_rowNumber_key`(`importJobId`, `rowNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable idempotency_requests
CREATE TABLE `idempotency_requests` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` INTEGER NOT NULL,
    `operation` VARCHAR(100) NOT NULL,
    `key` VARCHAR(150) NOT NULL,
    `requestHash` VARCHAR(64) NOT NULL,
    `status` ENUM('PROCESSING', 'COMPLETED', 'FAILED') NOT NULL,
    `statusCode` INTEGER NULL,
    `responseJson` JSON NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idempotency_requests_storeId_expiresAt_idx`(`storeId`, `expiresAt`),
    UNIQUE INDEX `idempotency_requests_storeId_operation_key_key`(`storeId`, `operation`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable historical_sales
CREATE TABLE `historical_sales` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `stockItemId` INTEGER NULL,
    `externalSku` VARCHAR(100) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `unitPrice` DECIMAL(15, 2) NOT NULL,
    `totalAmount` DECIMAL(15, 2) NOT NULL,
    `soldAt` DATETIME(3) NOT NULL,
    `source` VARCHAR(50) NOT NULL,
    `externalOrderId` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `historical_sales_storeId_soldAt_idx`(`storeId`, `soldAt`),
    INDEX `historical_sales_storeId_stockItemId_soldAt_idx`(`storeId`, `stockItemId`, `soldAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `import_job_items` ADD CONSTRAINT `import_job_items_importJobId_fkey` FOREIGN KEY (`importJobId`) REFERENCES `import_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
