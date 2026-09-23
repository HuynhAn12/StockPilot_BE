# Đặc tả Cơ sở Dữ liệu StockPilot (MySQL 8.4 / InnoDB)

Hệ thống sử dụng cơ chế lưu trữ **Multi-tenant theo mô hình Shared Database / Shared Schema**, trong đó mọi bảng dữ liệu liên quan tới nghiệp vụ đều có trường khóa ngoại `store_id` để phân lập dữ liệu.

---

## 1. Sơ đồ Thực thể - Quan hệ (ERD Overview)

```
[Store] 1 ──── * [User]
[Store] 1 ──── * [Warehouse]
[Store] 1 ──── * [Category]
[Store] 1 ──── * [Product] 1 ──── * [StockItem]
[Warehouse] 1 ──── * [InventoryBalance] * ──── 1 [StockItem]
[Warehouse] 1 ──── * [StockMovement] * ──── 1 [StockItem]
[Store] 1 ──── * [Order] 1 ──── * [OrderItem] * ──── 1 [StockItem]
[Order] 1 ──── * [ReturnOrder] 1 ──── * [ReturnItem] * ──── 1 [OrderItem]
```

---

## 2. Danh mục Bảng và Ràng buộc Chi tiết

### 2.1. Bảng `stores`
- **Mục đích:** Lưu trữ thông tin từng cửa hàng độc lập.
- **Khóa chính:** `id` (INT AUTO_INCREMENT)
- **Ràng buộc duy nhất:** `code` (VARCHAR(50) UNIQUE)
- **Các trường:** `name`, `code`, `phone`, `address`, `isActive`, `createdAt`, `updatedAt`.

### 2.2. Bảng `users`
- **Mục đích:** Tài khoản người dùng (Shop Owner, Warehouse Staff, Admin).
- **Khóa chính:** `id` (INT AUTO_INCREMENT)
- **Khóa ngoại:** `store_id` -> `stores(id)` (ON DELETE SET NULL)
- **Ràng buộc duy nhất:** `email` (VARCHAR(255) UNIQUE)
- **Enum Role:** `SHOP_OWNER`, `WAREHOUSE_STAFF`, `ADMIN`

### 2.3. Bảng `warehouses`
- **Mục đích:** Kho lưu trữ vật lý của cửa hàng (MVP: mỗi store 1 warehouse mặc định).
- **Khóa ngoại:** `store_id` -> `stores(id)` (ON DELETE CASCADE)
- **Chỉ mục:** `INDEX(store_id)`

### 2.4. Bảng `categories`
- **Khóa ngoại:** `store_id` -> `stores(id)` (ON DELETE CASCADE)
- **Ràng buộc duy nhất:** `UNIQUE(store_id, code)`
- **Chỉ mục:** `INDEX(store_id)`

### 2.5. Bảng `products` & `stock_items`
- **Bảng `products`:** Lưu thông tin chung của sản phẩm (`name`, `code`, `description`, `category_id`). Ràng buộc duy nhất `UNIQUE(store_id, code)`.
- **Bảng `stock_items`:** Lưu đơn vị biến thể/SKU trực tiếp giữ tồn kho.
  - `sku` (VARCHAR(100))
  - `cost_price` (DECIMAL(15, 2)) - Giá vốn nhập
  - `selling_price` (DECIMAL(15, 2)) - Giá niêm yết bán lẻ
  - `min_stock_level`, `max_stock_level` (INT)
  - Ràng buộc duy nhất: `UNIQUE(store_id, sku)`

### 2.6. Bảng `inventory_balances`
- **Mục đích:** Lưu trữ số dư tồn kho tức thời tại mỗi kho cho từng SKU để truy vấn nhanh.
- **Ràng buộc duy nhất:** `UNIQUE(warehouse_id, stock_item_id)`
- **Ràng buộc dữ liệu:** `quantity >= 0` (được bảo vệ bằng conditional query và database transaction).

### 2.7. Bảng `stock_movements`
- **Mục đích:** Sổ nhật ký biến động kho bất biến (Immutable Audit Log).
- **Enum MovementType:** `INFLOW`, `OUTFLOW`, `AUDIT_ADJUSTMENT`, `ORDER_FULFILL`, `ORDER_CANCEL_RESTOCK`, `RETURN_RESTOCK`.
- **Các trường kiểm toán:** `delta` (+ hoặc -), `before_quantity`, `after_quantity`, `reference_type`, `reference_id`, `idempotency_key` (UNIQUE), `note`, `created_by_id`, `created_at`.

### 2.8. Bảng `orders` & `order_items`
- **Bảng `orders`:**
  - `status`: `DRAFT`, `CONFIRMED`, `FULFILLED`, `CANCELED`.
  - `subtotal_amount`, `discount_amount`, `tax_amount`, `total_amount` (DECIMAL(15, 2)).
  - Ràng buộc duy nhất: `UNIQUE(store_id, order_number)`
- **Bảng `order_items`:**
  - Lưu snapshot: `sku_snapshot`, `name_snapshot`, `unit_price_snapshot`, `cost_price_snapshot`, `quantity`, `subtotal`.

### 2.9. Bảng `return_orders` & `return_items`
- **Bảng `return_orders`:**
  - `order_id`: Tham chiếu đơn gốc.
  - `total_refund_amount`: Tổng tiền hoàn được ghi nhận.
  - Ràng buộc duy nhất: `UNIQUE(store_id, return_number)`
- **Bảng `return_items`:**
  - `is_restockable` (BOOLEAN): Xác định hàng có được nhập lại kho hay không (hàng lỗi/hỏng = false).
  - `restock_warehouse_id`: Kho nhập lại nếu `is_restockable = true`.
