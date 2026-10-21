-- CreateIndex
CREATE UNIQUE INDEX `payments_provider_providerReference_key` ON `payments`(`provider`, `providerReference`);
