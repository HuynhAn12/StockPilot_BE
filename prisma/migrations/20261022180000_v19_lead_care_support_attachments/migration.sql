-- CreateTable
CREATE TABLE IF NOT EXISTS `contact_leads` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fullName` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `email` VARCHAR(191) NULL,
    `storeName` VARCHAR(191) NULL,
    `industry` VARCHAR(100) NULL,
    `note` TEXT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'NEW',
    `assigneeId` INTEGER NULL,
    `submissionCount` INTEGER NOT NULL DEFAULT 1,
    `lastSubmittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastContactedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    INDEX `contact_leads_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `contact_leads_phone_idx`(`phone`),
    INDEX `contact_leads_assigneeId_idx`(`assigneeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `support_tickets` ADD COLUMN `adminReadAt` DATETIME(3) NULL,
    ADD COLUMN `lastAdminMessageAt` DATETIME(3) NULL,
    ADD COLUMN `lastStoreMessageAt` DATETIME(3) NULL,
    ADD COLUMN `storeReadAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS `contact_lead_notes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `leadId` INTEGER NOT NULL,
    `authorId` INTEGER NULL,
    `type` VARCHAR(20) NOT NULL DEFAULT 'NOTE',
    `body` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `contact_lead_notes_leadId_createdAt_idx`(`leadId`, `createdAt`),
    INDEX `contact_lead_notes_authorId_idx`(`authorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `support_ticket_attachments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `messageId` INTEGER NOT NULL,
    `ticketId` INTEGER NOT NULL,
    `fileName` VARCHAR(200) NOT NULL,
    `mimeType` VARCHAR(50) NOT NULL,
    `size` INTEGER NOT NULL,
    `data` LONGBLOB NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `support_ticket_attachments_messageId_idx`(`messageId`),
    INDEX `support_ticket_attachments_ticketId_idx`(`ticketId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `contact_leads` ADD CONSTRAINT `contact_leads_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contact_lead_notes` ADD CONSTRAINT `contact_lead_notes_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `contact_leads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contact_lead_notes` ADD CONSTRAINT `contact_lead_notes_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_ticket_attachments` ADD CONSTRAINT `support_ticket_attachments_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `support_ticket_messages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing leads: their last submission is their creation time, not the migration time.
UPDATE `contact_leads` SET `lastSubmittedAt` = `createdAt`;
