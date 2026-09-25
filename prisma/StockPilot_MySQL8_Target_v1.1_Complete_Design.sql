-- ============================================================================
-- STOCKPILOT - CONSOLIDATED TARGET MYSQL 8.4 DATABASE DESIGN (v1.1)
-- ============================================================================
-- Project      : StockPilot - Smart Inventory and Pricing Decision Support System
-- Repository   : HuynhAn12/StockPilot_BE
-- Version      : Database Design Target v1.1 (29 Tables)
-- DBMS         : MySQL 8.4 / InnoDB / utf8mb4 / utf8mb4_unicode_ci
-- Target Schema: 29 Physical Tables
-- Generated for: MySQL Workbench / phpMyAdmin / DBeaver / Production DB Setup
--
-- IMPORTANT ARCHITECTURAL NOTES:
-- 1) This is a CONSOLIDATED TARGET SCHEMA for system design, documentation,
--    and direct database initialization/import. It does NOT replace the
--    repository's historical Prisma migration ledger.
-- 2) Target count is exactly 29 physical tables (23 baseline + 6 newly added).
-- 3) Strict MySQL 8.4 compliance: InnoDB engine, utf8mb4 character set,
--    DATETIME(3) precision, explicit CHECK constraints, and exact foreign keys.
-- 4) Store Isolation Rule: Service/Data-Access layer MUST enforce same-store
--    ownership across all relational entities before COMMIT.
-- 5) MVP Warehouse Rule: Each store operates with one default warehouse in MVP;
--    the schema retains native multi-warehouse physical capability for scaling.
-- ============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS `stockpilot`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `stockpilot`;

SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================================
-- DROP TABLE IN REVERSE DEPENDENCY ORDER (29 TABLES)
-- ============================================================================
DROP TABLE IF EXISTS `ai_interactions`;
DROP TABLE IF EXISTS `audit_logs`;
DROP TABLE IF EXISTS `notifications`;
DROP TABLE IF EXISTS `decision_snapshots`;
DROP TABLE IF EXISTS `price_histories`;
DROP TABLE IF EXISTS `pricing_recommendations`;
DROP TABLE IF EXISTS `alerts`;
DROP TABLE IF EXISTS `engine_configs`;
DROP TABLE IF EXISTS `daily_sales_summaries`;
DROP TABLE IF EXISTS `historical_sales`;
DROP TABLE IF EXISTS `idempotency_requests`;
DROP TABLE IF EXISTS `import_job_items`;
DROP TABLE IF EXISTS `import_jobs`;
DROP TABLE IF EXISTS `return_items`;
DROP TABLE IF EXISTS `return_orders`;
DROP TABLE IF EXISTS `order_items`;
DROP TABLE IF EXISTS `orders`;
DROP TABLE IF EXISTS `stock_take_items`;
DROP TABLE IF EXISTS `stock_takes`;
DROP TABLE IF EXISTS `stock_movements`;
DROP TABLE IF EXISTS `inventory_balances`;
DROP TABLE IF EXISTS `stock_items`;
DROP TABLE IF EXISTS `products`;
DROP TABLE IF EXISTS `categories`;
DROP TABLE IF EXISTS `warehouses`;
DROP TABLE IF EXISTS `system_settings`;
DROP TABLE IF EXISTS `auth_sessions`;
DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `stores`;

-- ============================================================================
-- 1. SYSTEM SETTINGS, STORES & ACCESS CONTROL
-- ============================================================================

-- Table 1: stores
CREATE TABLE `stores` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `code` VARCHAR(50) NOT NULL,
  `phone` VARCHAR(50) NULL,
  `address` VARCHAR(255) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `stores_code_key` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 2: users
CREATE TABLE `users` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `email` VARCHAR(255) NOT NULL,
  `passwordHash` VARCHAR(255) NOT NULL,
  `fullName` VARCHAR(255) NOT NULL,
  `role` ENUM('SHOP_OWNER','WAREHOUSE_STAFF','ADMIN')
    NOT NULL DEFAULT 'SHOP_OWNER',
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `storeId` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `users_email_key` (`email`),
  KEY `users_storeId_idx` (`storeId`),

  CONSTRAINT `users_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 3: auth_sessions
CREATE TABLE `auth_sessions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `userId` INT NOT NULL,
  `refreshTokenHash` VARCHAR(255) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `revokedAt` DATETIME(3) NULL,
  `userAgent` VARCHAR(255) NULL,
  `ipAddress` VARCHAR(50) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `auth_sessions_refreshTokenHash_key` (`refreshTokenHash`),
  KEY `auth_sessions_userId_idx` (`userId`),

  CONSTRAINT `auth_sessions_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 4: system_settings (NEW)
CREATE TABLE `system_settings` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `key` VARCHAR(100) NOT NULL,
  `valueJson` JSON NOT NULL,
  `description` VARCHAR(255) NULL,
  `isPublic` BOOLEAN NOT NULL DEFAULT FALSE,
  `updatedById` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `system_settings_key_key` (`key`),
  KEY `system_settings_updatedById_idx` (`updatedById`),

  CONSTRAINT `system_settings_updatedById_fkey`
    FOREIGN KEY (`updatedById`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 2. WAREHOUSES & CATALOG
-- ============================================================================

-- Table 5: warehouses
-- MVP Rule: One Store -> one default Warehouse enforced by application layer.
CREATE TABLE `warehouses` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `location` VARCHAR(255) NULL,
  `isDefault` BOOLEAN NOT NULL DEFAULT FALSE,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `warehouses_storeId_idx` (`storeId`),

  CONSTRAINT `warehouses_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 6: categories
CREATE TABLE `categories` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `code` VARCHAR(50) NOT NULL,
  `description` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `categories_storeId_code_key` (`storeId`, `code`),
  KEY `categories_storeId_idx` (`storeId`),

  CONSTRAINT `categories_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 7: products
CREATE TABLE `products` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `categoryId` INT NULL,
  `name` VARCHAR(255) NOT NULL,
  `code` VARCHAR(50) NOT NULL,
  `description` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `products_storeId_code_key` (`storeId`, `code`),
  KEY `products_storeId_idx` (`storeId`),
  KEY `products_categoryId_idx` (`categoryId`),

  CONSTRAINT `products_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `products_categoryId_fkey`
    FOREIGN KEY (`categoryId`) REFERENCES `categories` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 8: stock_items
CREATE TABLE `stock_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `productId` INT NOT NULL,
  `sku` VARCHAR(100) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `barcode` VARCHAR(100) NULL,
  `costPrice` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `sellingPrice` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `minStockLevel` INT NOT NULL DEFAULT 0,
  `maxStockLevel` INT NOT NULL DEFAULT 1000,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `stock_items_storeId_sku_key` (`storeId`, `sku`),
  KEY `stock_items_storeId_idx` (`storeId`),
  KEY `stock_items_productId_idx` (`productId`),

  CONSTRAINT `stock_items_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `stock_items_productId_fkey`
    FOREIGN KEY (`productId`) REFERENCES `products` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `chk_stock_item_cost_non_negative`
    CHECK (`costPrice` >= 0),

  CONSTRAINT `chk_stock_item_selling_non_negative`
    CHECK (`sellingPrice` >= 0),

  CONSTRAINT `chk_stock_item_min_non_negative`
    CHECK (`minStockLevel` >= 0),

  CONSTRAINT `chk_stock_item_max_ge_min`
    CHECK (`maxStockLevel` >= `minStockLevel`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 3. INVENTORY & STOCK MOVEMENTS
-- ============================================================================

-- Table 9: inventory_balances
CREATE TABLE `inventory_balances` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `warehouseId` INT NOT NULL,
  `stockItemId` INT NOT NULL,
  `quantity` INT NOT NULL DEFAULT 0,
  `reservedQuantity` INT NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `inventory_balances_warehouseId_stockItemId_key`
    (`warehouseId`, `stockItemId`),
  KEY `inventory_balances_storeId_stockItemId_idx`
    (`storeId`, `stockItemId`),

  CONSTRAINT `inventory_balances_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `inventory_balances_warehouseId_fkey`
    FOREIGN KEY (`warehouseId`) REFERENCES `warehouses` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `inventory_balances_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `chk_inventory_quantity_non_negative`
    CHECK (`quantity` >= 0),

  CONSTRAINT `chk_inventory_reserved_non_negative`
    CHECK (`reservedQuantity` >= 0),

  CONSTRAINT `chk_inventory_reserved_not_exceed_quantity`
    CHECK (`reservedQuantity` <= `quantity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 10: stock_movements
CREATE TABLE `stock_movements` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `warehouseId` INT NOT NULL,
  `stockItemId` INT NOT NULL,
  `type` ENUM(
    'INFLOW',
    'OUTFLOW',
    'AUDIT_ADJUSTMENT',
    'ORDER_FULFILL',
    'ORDER_CANCEL_RESTOCK',
    'RETURN_RESTOCK'
  ) NOT NULL,
  `delta` INT NOT NULL,
  `beforeQuantity` INT NOT NULL,
  `afterQuantity` INT NOT NULL,
  `referenceType` VARCHAR(50) NOT NULL,
  `referenceId` VARCHAR(100) NOT NULL,
  `idempotencyKey` VARCHAR(150) NULL,
  `note` TEXT NULL,
  `createdById` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `stock_movements_idempotencyKey_key` (`idempotencyKey`),
  KEY `stock_movements_storeId_stockItemId_createdAt_idx`
    (`storeId`, `stockItemId`, `createdAt`),
  KEY `stock_movements_warehouseId_idx` (`warehouseId`),
  KEY `stock_movements_createdById_idx` (`createdById`),

  CONSTRAINT `stock_movements_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `stock_movements_warehouseId_fkey`
    FOREIGN KEY (`warehouseId`) REFERENCES `warehouses` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `stock_movements_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `stock_movements_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `chk_stock_movement_before_non_negative`
    CHECK (`beforeQuantity` >= 0),

  CONSTRAINT `chk_stock_movement_after_non_negative`
    CHECK (`afterQuantity` >= 0),

  CONSTRAINT `chk_stock_movement_delta_consistency`
    CHECK (`afterQuantity` = `beforeQuantity` + `delta`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 4. STOCK TAKES (INVENTORY AUDITING)
-- ============================================================================

-- Table 11: stock_takes (NEW)
CREATE TABLE `stock_takes` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `warehouseId` INT NOT NULL,
  `status` ENUM('DRAFT','IN_PROGRESS','COMPLETED','CANCELED')
    NOT NULL DEFAULT 'DRAFT',
  `startedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `note` TEXT NULL,
  `createdById` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `stock_takes_storeId_warehouseId_status_createdAt_idx`
    (`storeId`, `warehouseId`, `status`, `createdAt`),
  KEY `stock_takes_createdById_idx` (`createdById`),

  CONSTRAINT `stock_takes_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `stock_takes_warehouseId_fkey`
    FOREIGN KEY (`warehouseId`) REFERENCES `warehouses` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `stock_takes_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 12: stock_take_items (NEW)
CREATE TABLE `stock_take_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `stockTakeId` INT NOT NULL,
  `stockItemId` INT NOT NULL,
  `expectedQuantity` INT NOT NULL,
  `countedQuantity` INT NOT NULL,
  `varianceQuantity` INT NOT NULL,
  `adjustmentMovementId` INT NULL,
  `note` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `stock_take_items_stockTakeId_stockItemId_key`
    (`stockTakeId`, `stockItemId`),
  KEY `stock_take_items_storeId_idx` (`storeId`),
  KEY `stock_take_items_stockItemId_idx` (`stockItemId`),
  KEY `stock_take_items_adjustmentMovementId_idx` (`adjustmentMovementId`),

  CONSTRAINT `stock_take_items_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `stock_take_items_stockTakeId_fkey`
    FOREIGN KEY (`stockTakeId`) REFERENCES `stock_takes` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `stock_take_items_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `stock_take_items_adjustmentMovementId_fkey`
    FOREIGN KEY (`adjustmentMovementId`) REFERENCES `stock_movements` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `chk_stock_take_item_expected_non_negative`
    CHECK (`expectedQuantity` >= 0),

  CONSTRAINT `chk_stock_take_item_counted_non_negative`
    CHECK (`countedQuantity` >= 0),

  CONSTRAINT `chk_stock_take_item_variance_consistency`
    CHECK (`varianceQuantity` = `countedQuantity` - `expectedQuantity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 5. ORDERS & RETURNS
-- ============================================================================

-- Table 13: orders
CREATE TABLE `orders` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `orderNumber` VARCHAR(100) NOT NULL,
  `status` ENUM('DRAFT','CONFIRMED','FULFILLED','CANCELED')
    NOT NULL DEFAULT 'DRAFT',
  `customerName` VARCHAR(255) NULL,
  `customerPhone` VARCHAR(50) NULL,
  `customerAddress` VARCHAR(255) NULL,
  `subtotalAmount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `discountAmount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `taxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `totalAmount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `note` TEXT NULL,
  `confirmedAt` DATETIME(3) NULL,
  `fulfilledAt` DATETIME(3) NULL,
  `canceledAt` DATETIME(3) NULL,
  `cancelReason` TEXT NULL,
  `createdById` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `orders_storeId_orderNumber_key` (`storeId`, `orderNumber`),
  KEY `orders_storeId_status_createdAt_idx` (`storeId`, `status`, `createdAt`),
  KEY `orders_createdById_idx` (`createdById`),

  CONSTRAINT `orders_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `orders_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `chk_order_subtotal_non_negative`
    CHECK (`subtotalAmount` >= 0),

  CONSTRAINT `chk_order_discount_non_negative`
    CHECK (`discountAmount` >= 0),

  CONSTRAINT `chk_order_tax_non_negative`
    CHECK (`taxAmount` >= 0),

  CONSTRAINT `chk_order_total_non_negative`
    CHECK (`totalAmount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 14: order_items
CREATE TABLE `order_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `orderId` INT NOT NULL,
  `stockItemId` INT NOT NULL,
  `skuSnapshot` VARCHAR(100) NOT NULL,
  `nameSnapshot` VARCHAR(255) NOT NULL,
  `unitPriceSnapshot` DECIMAL(15,2) NOT NULL,
  `costPriceSnapshot` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `quantity` INT NOT NULL,
  `refundableAmount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `refundedAmount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `returnedQuantity` INT NOT NULL DEFAULT 0,
  `subtotal` DECIMAL(15,2) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `order_items_storeId_orderId_idx` (`storeId`, `orderId`),
  KEY `order_items_stockItemId_idx` (`stockItemId`),

  CONSTRAINT `order_items_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `order_items_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `orders` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `order_items_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `chk_order_item_quantity_positive`
    CHECK (`quantity` > 0),

  CONSTRAINT `chk_order_item_unit_price_non_negative`
    CHECK (`unitPriceSnapshot` >= 0),

  CONSTRAINT `chk_order_item_cost_non_negative`
    CHECK (`costPriceSnapshot` >= 0),

  CONSTRAINT `chk_order_item_subtotal_non_negative`
    CHECK (`subtotal` >= 0),

  CONSTRAINT `chk_order_item_returned_quantity`
    CHECK (`returnedQuantity` >= 0 AND `returnedQuantity` <= `quantity`),

  CONSTRAINT `chk_order_item_refundable_non_negative`
    CHECK (`refundableAmount` >= 0),

  CONSTRAINT `chk_order_item_refunded_non_negative`
    CHECK (`refundedAmount` >= 0),

  CONSTRAINT `chk_order_item_refund_cap`
    CHECK (`refundedAmount` <= `refundableAmount`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 15: return_orders
CREATE TABLE `return_orders` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `orderId` INT NOT NULL,
  `returnNumber` VARCHAR(100) NOT NULL,
  `status` ENUM('COMPLETED') NOT NULL DEFAULT 'COMPLETED',
  `totalRefundAmount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `reason` TEXT NULL,
  `createdById` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `return_orders_storeId_returnNumber_key`
    (`storeId`, `returnNumber`),
  KEY `return_orders_storeId_orderId_idx` (`storeId`, `orderId`),
  KEY `return_orders_createdById_idx` (`createdById`),

  CONSTRAINT `return_orders_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `return_orders_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `orders` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `return_orders_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `chk_return_total_refund_non_negative`
    CHECK (`totalRefundAmount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 16: return_items
CREATE TABLE `return_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `returnOrderId` INT NOT NULL,
  `orderItemId` INT NOT NULL,
  `stockItemId` INT NOT NULL,
  `quantity` INT NOT NULL,
  `refundPrice` DECIMAL(15,2) NOT NULL,
  `isRestockable` BOOLEAN NOT NULL DEFAULT TRUE,
  `restockWarehouseId` INT NULL,
  `note` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `return_items_storeId_returnOrderId_idx`
    (`storeId`, `returnOrderId`),
  KEY `return_items_orderItemId_idx` (`orderItemId`),
  KEY `return_items_stockItemId_idx` (`stockItemId`),
  KEY `return_items_restockWarehouseId_idx` (`restockWarehouseId`),

  CONSTRAINT `return_items_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `return_items_returnOrderId_fkey`
    FOREIGN KEY (`returnOrderId`) REFERENCES `return_orders` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `return_items_orderItemId_fkey`
    FOREIGN KEY (`orderItemId`) REFERENCES `order_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `return_items_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `return_items_restockWarehouseId_fkey`
    FOREIGN KEY (`restockWarehouseId`) REFERENCES `warehouses` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `chk_return_item_quantity_positive`
    CHECK (`quantity` > 0),

  CONSTRAINT `chk_return_item_refund_non_negative`
    CHECK (`refundPrice` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 6. DATA IMPORT & IDEMPOTENCY
-- ============================================================================

-- Table 17: import_jobs
CREATE TABLE `import_jobs` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` INT NOT NULL,
  `createdById` INT NULL,
  `type` VARCHAR(50) NOT NULL,
  `payloadHash` VARCHAR(64) NOT NULL,
  `payloadJson` JSON NOT NULL,
  `status` ENUM('PREVIEWED','COMMITTING','COMPLETED','FAILED','EXPIRED')
    NOT NULL DEFAULT 'PREVIEWED',
  `totalRows` INT NOT NULL DEFAULT 0,
  `validRows` INT NOT NULL DEFAULT 0,
  `invalidRows` INT NOT NULL DEFAULT 0,
  `warningRows` INT NOT NULL DEFAULT 0,
  `resultJson` JSON NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `import_jobs_storeId_createdAt_idx` (`storeId`, `createdAt`),
  KEY `import_jobs_storeId_payloadHash_idx` (`storeId`, `payloadHash`),
  KEY `import_jobs_createdById_idx` (`createdById`),

  CONSTRAINT `import_jobs_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `import_jobs_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `chk_import_job_row_counts_non_negative`
    CHECK (
      `totalRows` >= 0
      AND `validRows` >= 0
      AND `invalidRows` >= 0
      AND `warningRows` >= 0
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 18: import_job_items
CREATE TABLE `import_job_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `importJobId` VARCHAR(191) NOT NULL,
  `rowNumber` INT NOT NULL,
  `stockItemId` INT NULL,
  `sku` VARCHAR(100) NOT NULL,
  `status` ENUM('PENDING','PROCESSING','COMPLETED','FAILED','SKIPPED')
    NOT NULL DEFAULT 'PENDING',
  `resultJson` JSON NULL,
  `errorJson` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `import_job_items_importJobId_rowNumber_key`
    (`importJobId`, `rowNumber`),
  KEY `import_job_items_importJobId_status_idx`
    (`importJobId`, `status`),
  KEY `import_job_items_stockItemId_idx` (`stockItemId`),

  CONSTRAINT `import_job_items_importJobId_fkey`
    FOREIGN KEY (`importJobId`) REFERENCES `import_jobs` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `import_job_items_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `chk_import_job_item_row_positive`
    CHECK (`rowNumber` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 19: idempotency_requests
CREATE TABLE `idempotency_requests` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` INT NOT NULL,
  `operation` VARCHAR(100) NOT NULL,
  `key` VARCHAR(150) NOT NULL,
  `requestHash` VARCHAR(64) NOT NULL,
  `status` ENUM('PROCESSING','COMPLETED','FAILED') NOT NULL,
  `statusCode` INT NULL,
  `responseJson` JSON NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `idempotency_requests_storeId_operation_key_key`
    (`storeId`, `operation`, `key`),
  KEY `idempotency_requests_storeId_expiresAt_idx`
    (`storeId`, `expiresAt`),

  CONSTRAINT `idempotency_requests_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 7. HISTORICAL SALES & DAILY ANALYTICS
-- ============================================================================

-- Table 20: historical_sales
CREATE TABLE `historical_sales` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `stockItemId` INT NULL,
  `externalSku` VARCHAR(100) NOT NULL,
  `quantity` INT NOT NULL,
  `unitPrice` DECIMAL(15,2) NOT NULL,
  `totalAmount` DECIMAL(15,2) NOT NULL,
  `soldAt` DATETIME(3) NOT NULL,
  `source` VARCHAR(50) NOT NULL,
  `externalOrderId` VARCHAR(100) NULL,
  `sourceRowHash` VARCHAR(64) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `historical_sales_storeId_sourceRowHash_key`
    (`storeId`, `sourceRowHash`),
  KEY `historical_sales_storeId_soldAt_idx`
    (`storeId`, `soldAt`),
  KEY `historical_sales_storeId_stockItemId_soldAt_idx`
    (`storeId`, `stockItemId`, `soldAt`),

  CONSTRAINT `historical_sales_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `historical_sales_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `chk_historical_sale_quantity_positive`
    CHECK (`quantity` > 0),

  CONSTRAINT `chk_historical_sale_unit_price_non_negative`
    CHECK (`unitPrice` >= 0),

  CONSTRAINT `chk_historical_sale_total_non_negative`
    CHECK (`totalAmount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 21: daily_sales_summaries
CREATE TABLE `daily_sales_summaries` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `stockItemId` INT NOT NULL,
  `summaryDate` DATE NOT NULL,
  `grossSoldQty` INT NOT NULL DEFAULT 0,
  `returnQty` INT NOT NULL DEFAULT 0,
  `netSoldQty` INT NOT NULL DEFAULT 0,
  `grossRevenue` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `refundAmount` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `netRevenue` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `cogs` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `grossProfit` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `orderCount` INT NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `daily_sales_summaries_storeId_stockItemId_summaryDate_key`
    (`storeId`, `stockItemId`, `summaryDate`),
  KEY `daily_sales_summaries_storeId_summaryDate_idx`
    (`storeId`, `summaryDate`),

  CONSTRAINT `daily_sales_summaries_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `daily_sales_summaries_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `chk_daily_gross_sold_non_negative`
    CHECK (`grossSoldQty` >= 0),

  CONSTRAINT `chk_daily_return_qty_non_negative`
    CHECK (`returnQty` >= 0),

  CONSTRAINT `chk_daily_gross_revenue_non_negative`
    CHECK (`grossRevenue` >= 0),

  CONSTRAINT `chk_daily_refund_non_negative`
    CHECK (`refundAmount` >= 0),

  CONSTRAINT `chk_daily_order_count_non_negative`
    CHECK (`orderCount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 8. DECISION ENGINE CONFIG & SMART ALERTS
-- ============================================================================

-- Table 22: engine_configs
CREATE TABLE `engine_configs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `leadTimeDays` INT NOT NULL DEFAULT 7,
  `safetyDays` INT NOT NULL DEFAULT 3,
  `serviceLevel` DECIMAL(5,4) NOT NULL DEFAULT 0.9500,
  `targetCoverageDays` INT NOT NULL DEFAULT 30,
  `slowMovingDays` INT NOT NULL DEFAULT 60,
  `deadStockDays` INT NOT NULL DEFAULT 90,
  `minimumHistoryDays` INT NOT NULL DEFAULT 14,
  `minimumMarginPct` DECIMAL(6,4) NOT NULL DEFAULT 0.2000,
  `maxMarkdownPct` DECIMAL(6,4) NOT NULL DEFAULT 0.3000,
  `maxMarkupPct` DECIMAL(6,4) NOT NULL DEFAULT 0.2000,
  `lowRiskThreshold` INT NOT NULL DEFAULT 25,
  `highRiskThreshold` INT NOT NULL DEFAULT 50,
  `criticalRiskThreshold` INT NOT NULL DEFAULT 75,
  `engineVersion` VARCHAR(50) NOT NULL DEFAULT 'DECISION_ENGINE_V1',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `engine_configs_storeId_key` (`storeId`),

  CONSTRAINT `engine_configs_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `chk_engine_lead_time_non_negative`
    CHECK (`leadTimeDays` >= 0),

  CONSTRAINT `chk_engine_safety_days_non_negative`
    CHECK (`safetyDays` >= 0),

  CONSTRAINT `chk_engine_service_level`
    CHECK (`serviceLevel` > 0 AND `serviceLevel` <= 1),

  CONSTRAINT `chk_engine_coverage_positive`
    CHECK (`targetCoverageDays` > 0),

  CONSTRAINT `chk_engine_slow_dead_days`
    CHECK (
      `slowMovingDays` >= 0
      AND `deadStockDays` >= `slowMovingDays`
    ),

  CONSTRAINT `chk_engine_history_days`
    CHECK (`minimumHistoryDays` >= 1),

  CONSTRAINT `chk_engine_margin_pct`
    CHECK (`minimumMarginPct` >= 0 AND `minimumMarginPct` < 1),

  CONSTRAINT `chk_engine_markdown_pct`
    CHECK (`maxMarkdownPct` >= 0 AND `maxMarkdownPct` <= 1),

  CONSTRAINT `chk_engine_markup_pct`
    CHECK (`maxMarkupPct` >= 0 AND `maxMarkupPct` <= 1),

  CONSTRAINT `chk_engine_risk_thresholds`
    CHECK (
      `lowRiskThreshold` >= 0
      AND `lowRiskThreshold` < `highRiskThreshold`
      AND `highRiskThreshold` < `criticalRiskThreshold`
      AND `criticalRiskThreshold` <= 100
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 23: alerts
-- Updated ENUM aligns with Proposal: LOW_STOCK, STOCKOUT, OVERSTOCK, SLOW_MOVING, DEAD_STOCK, UNUSUAL_DEMAND
CREATE TABLE `alerts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `stockItemId` INT NOT NULL,
  `type` ENUM(
    'LOW_STOCK',
    'STOCKOUT',
    'OVERSTOCK',
    'SLOW_MOVING',
    'DEAD_STOCK',
    'UNUSUAL_DEMAND'
  ) NOT NULL,
  `severity` ENUM('INFO','WARNING','CRITICAL') NOT NULL,
  `status` ENUM('OPEN','ACKNOWLEDGED','RESOLVED')
    NOT NULL DEFAULT 'OPEN',
  `riskScore` DECIMAL(5,2) NULL,
  `confidence` DECIMAL(5,2) NULL DEFAULT 100.00,
  `title` VARCHAR(255) NOT NULL,
  `message` TEXT NOT NULL,
  `reasonJson` JSON NOT NULL,
  `fingerprint` VARCHAR(64) NOT NULL,
  `engineVersion` VARCHAR(50) NOT NULL DEFAULT 'DECISION_ENGINE_V1',
  `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `resolvedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `alerts_storeId_fingerprint_key` (`storeId`, `fingerprint`),
  KEY `alerts_storeId_status_severity_idx`
    (`storeId`, `status`, `severity`),
  KEY `alerts_storeId_stockItemId_idx`
    (`storeId`, `stockItemId`),

  CONSTRAINT `alerts_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `alerts_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `chk_alert_risk_score`
    CHECK (`riskScore` IS NULL OR (`riskScore` >= 0 AND `riskScore` <= 100)),

  CONSTRAINT `chk_alert_confidence`
    CHECK (`confidence` IS NULL OR (`confidence` >= 0 AND `confidence` <= 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 9. PRICING DECISION SUPPORT & SNAPSHOTS
-- ============================================================================

-- Table 24: pricing_recommendations
CREATE TABLE `pricing_recommendations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `stockItemId` INT NOT NULL,
  `currentPrice` DECIMAL(15,2) NOT NULL,
  `recommendedPrice` DECIMAL(15,2) NOT NULL,
  `discountPct` DECIMAL(5,2) NOT NULL,
  `action` ENUM('INCREASE','DECREASE','MAINTAIN')
    NOT NULL DEFAULT 'MAINTAIN',
  `riskScore` DECIMAL(5,2) NULL,
  `confidence` DECIMAL(5,2) NULL DEFAULT 100.00,
  `reasonJson` JSON NOT NULL,
  `status` ENUM('PENDING','ACCEPTED','REJECTED','MODIFIED','EXPIRED')
    NOT NULL DEFAULT 'PENDING',
  `engineVersion` VARCHAR(50) NOT NULL DEFAULT 'DECISION_ENGINE_V1',
  `finalUserSelectedPrice` DECIMAL(15,2) NULL,
  `decidedById` INT NULL,
  `decidedAt` DATETIME(3) NULL,
  `expiresAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `pricing_recommendations_storeId_status_idx`
    (`storeId`, `status`),
  KEY `pricing_recommendations_storeId_stockItemId_idx`
    (`storeId`, `stockItemId`),
  KEY `pricing_recommendations_decidedById_idx` (`decidedById`),

  CONSTRAINT `pricing_recommendations_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `pricing_recommendations_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `pricing_recommendations_decidedById_fkey`
    FOREIGN KEY (`decidedById`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `chk_pricing_current_price_non_negative`
    CHECK (`currentPrice` >= 0),

  CONSTRAINT `chk_pricing_recommended_price_non_negative`
    CHECK (`recommendedPrice` >= 0),

  CONSTRAINT `chk_pricing_discount_pct`
    CHECK (`discountPct` >= 0 AND `discountPct` <= 100),

  CONSTRAINT `chk_pricing_risk_score`
    CHECK (`riskScore` IS NULL OR (`riskScore` >= 0 AND `riskScore` <= 100)),

  CONSTRAINT `chk_pricing_confidence`
    CHECK (`confidence` IS NULL OR (`confidence` >= 0 AND `confidence` <= 100)),

  CONSTRAINT `chk_pricing_final_price_non_negative`
    CHECK (`finalUserSelectedPrice` IS NULL OR `finalUserSelectedPrice` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 25: price_histories
CREATE TABLE `price_histories` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `stockItemId` INT NOT NULL,
  `oldPrice` DECIMAL(15,2) NOT NULL,
  `newPrice` DECIMAL(15,2) NOT NULL,
  `source` VARCHAR(50) NOT NULL,
  `recommendationId` INT NULL,
  `reason` TEXT NULL,
  `changedById` INT NULL,
  `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `price_histories_storeId_stockItemId_changedAt_idx`
    (`storeId`, `stockItemId`, `changedAt`),
  KEY `price_histories_changedById_idx` (`changedById`),
  KEY `price_histories_recommendationId_idx` (`recommendationId`),

  CONSTRAINT `price_histories_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `price_histories_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `price_histories_changedById_fkey`
    FOREIGN KEY (`changedById`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `price_histories_recommendationId_fkey`
    FOREIGN KEY (`recommendationId`) REFERENCES `pricing_recommendations` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `chk_price_history_old_non_negative`
    CHECK (`oldPrice` >= 0),

  CONSTRAINT `chk_price_history_new_non_negative`
    CHECK (`newPrice` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 26: decision_snapshots
CREATE TABLE `decision_snapshots` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `stockItemId` INT NOT NULL,
  `calculatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `inputJson` JSON NOT NULL,
  `metricsJson` JSON NOT NULL,
  `risksJson` JSON NOT NULL,
  `version` VARCHAR(50) NOT NULL DEFAULT 'DECISION_ENGINE_V1',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `decision_snapshots_storeId_stockItemId_calculatedAt_idx`
    (`storeId`, `stockItemId`, `calculatedAt`),

  CONSTRAINT `decision_snapshots_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `decision_snapshots_stockItemId_fkey`
    FOREIGN KEY (`stockItemId`) REFERENCES `stock_items` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 10. NOTIFICATIONS, AUDIT LOGS & AI INTERACTIONS
-- ============================================================================

-- Table 27: notifications (NEW)
CREATE TABLE `notifications` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `userId` INT NULL,
  `type` VARCHAR(50) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `message` TEXT NOT NULL,
  `entityType` VARCHAR(50) NULL,
  `entityId` VARCHAR(100) NULL,
  `isRead` BOOLEAN NOT NULL DEFAULT FALSE,
  `readAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `notifications_storeId_userId_isRead_createdAt_idx`
    (`storeId`, `userId`, `isRead`, `createdAt`),
  KEY `notifications_storeId_createdAt_idx`
    (`storeId`, `createdAt`),

  CONSTRAINT `notifications_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `notifications_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 28: audit_logs (NEW - IMMUTABLE AUDIT TRAIL)
CREATE TABLE `audit_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `storeId` INT NULL,
  `userId` INT NULL,
  `action` VARCHAR(100) NOT NULL,
  `entityType` VARCHAR(50) NOT NULL,
  `entityId` VARCHAR(100) NULL,
  `beforeJson` JSON NULL,
  `afterJson` JSON NULL,
  `ipAddress` VARCHAR(50) NULL,
  `userAgent` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  KEY `audit_logs_storeId_createdAt_idx` (`storeId`, `createdAt`),
  KEY `audit_logs_userId_createdAt_idx` (`userId`, `createdAt`),
  KEY `audit_logs_entityType_entityId_createdAt_idx`
    (`entityType`, `entityId`, `createdAt`),

  CONSTRAINT `audit_logs_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT `audit_logs_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Table 29: ai_interactions (NEW - AI DECISION ASSISTANT LOGS)
-- SECURITY NOTE: Strictly prohibited from storing credentials, raw tokens, or customer PII.
CREATE TABLE `ai_interactions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `storeId` INT NOT NULL,
  `userId` INT NULL,
  `conversationId` VARCHAR(191) NULL,
  `requestId` VARCHAR(191) NULL,
  `model` VARCHAR(100) NOT NULL,
  `questionText` TEXT NULL,
  `responseText` MEDIUMTEXT NULL,
  `contextSummaryJson` JSON NULL,
  `inputTokens` INT NOT NULL DEFAULT 0,
  `outputTokens` INT NOT NULL DEFAULT 0,
  `latencyMs` INT NULL,
  `status` ENUM('SUCCESS','FAILED','TIMEOUT') NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `ai_interactions_requestId_key` (`requestId`),
  KEY `ai_interactions_storeId_userId_createdAt_idx`
    (`storeId`, `userId`, `createdAt`),
  KEY `ai_interactions_conversationId_createdAt_idx`
    (`conversationId`, `createdAt`),

  CONSTRAINT `ai_interactions_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT `ai_interactions_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- STORE ISOLATION & APPLICATION LEVEL GOVERNANCE RULES
-- ============================================================================
-- 1) SAME-STORE OWNERSHIP VALIDATION:
--    The application service/data-access layer MUST explicitly assert identical
--    `storeId` consistency before committing transactions across related models:
--      - Product -> StockItem
--      - Warehouse -> InventoryBalance
--      - Order -> OrderItem
--      - ReturnOrder -> ReturnItem
--      - StockTake -> StockTakeItem
--      - Alert -> StockItem
--      - PricingRecommendation -> StockItem
--      - DecisionSnapshot -> StockItem
--      - Notification -> Target User & Store
--      - AI Interaction -> Requesting User & Store
--    Any cross-store entity reference must be aborted and rejected immediately.
--
-- 2) MVP WAREHOUSE GOVERNANCE:
--    - For MVP, each store is bound to one default active Warehouse (`isDefault = TRUE`).
--    - All inventory balance adjustments and order fulfillment routes use this warehouse.
--    - Schema retains native multi-warehouse relations for future enterprise phases.
--
-- 3) IMPORT & ERROR HANDLING:
--    - Import row-level parsing/validation errors are persisted directly into
--      `import_job_items.errorJson` and `import_job_items.resultJson`.
-- ============================================================================
