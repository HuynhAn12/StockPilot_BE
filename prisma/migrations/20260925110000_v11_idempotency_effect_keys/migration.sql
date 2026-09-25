-- V11 idempotency unknown-outcome recovery metadata.
-- Nullable values preserve existing rows; composite uniqueness allows multiple NULLs in MySQL.

ALTER TABLE `orders`
  ADD COLUMN `clientRequestKey` VARCHAR(200) NULL;

ALTER TABLE `return_orders`
  ADD COLUMN `clientRequestKey` VARCHAR(200) NULL;

CREATE UNIQUE INDEX `orders_storeId_clientRequestKey_key`
  ON `orders`(`storeId`, `clientRequestKey`);

CREATE UNIQUE INDEX `return_orders_storeId_clientRequestKey_key`
  ON `return_orders`(`storeId`, `clientRequestKey`);
