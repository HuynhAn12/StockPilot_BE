-- CreateTable
CREATE TABLE `support_tickets` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `createdById` INTEGER NULL,
    `assigneeId` INTEGER NULL,
    `subject` VARCHAR(200) NOT NULL,
    `category` ENUM('DATA_IMPORT', 'PAYMENT', 'ACCOUNT', 'BUG', 'HOW_TO', 'OTHER') NOT NULL,
    `priority` ENUM('LOW', 'NORMAL', 'HIGH') NOT NULL DEFAULT 'NORMAL',
    `status` ENUM('OPEN', 'IN_PROGRESS', 'WAITING_STORE', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `lastMessageAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `firstResponseAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `support_tickets_storeId_createdAt_idx`(`storeId`, `createdAt`),
    INDEX `support_tickets_status_lastMessageAt_idx`(`status`, `lastMessageAt`),
    INDEX `support_tickets_createdById_idx`(`createdById`),
    INDEX `support_tickets_assigneeId_idx`(`assigneeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `support_ticket_messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ticketId` INTEGER NOT NULL,
    `authorId` INTEGER NULL,
    `fromAdmin` BOOLEAN NOT NULL DEFAULT false,
    `isInternal` BOOLEAN NOT NULL DEFAULT false,
    `body` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `support_ticket_messages_ticketId_createdAt_idx`(`ticketId`, `createdAt`),
    INDEX `support_ticket_messages_authorId_idx`(`authorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `support_tickets` ADD CONSTRAINT `support_tickets_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `stores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_tickets` ADD CONSTRAINT `support_tickets_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_tickets` ADD CONSTRAINT `support_tickets_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_ticket_messages` ADD CONSTRAINT `support_ticket_messages_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `support_tickets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_ticket_messages` ADD CONSTRAINT `support_ticket_messages_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

