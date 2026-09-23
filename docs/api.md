# Tài liệu API Đặc tả Hệ thống StockPilot

Phiên bản: `v1.0.0`
Tiền tố: `/api/v1`

---

## 1. Chuẩn hóa Mã Lỗi (Uniform Error Responses)

Toàn bộ phản hồi lỗi từ hệ thống tuân theo format chuẩn JSON:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR | UNAUTHENTICATED | FORBIDDEN | NOT_FOUND | CONFLICT | INSUFFICIENT_STOCK | INTERNAL_ERROR",
    "message": "Mô tả chi tiết lỗi dành cho người dùng",
    "details": {},
    "requestId": "c1f7a8e2-..."
  }
}
```

---

## 2. Danh mục Endpoints Triển khai

### 2.1. Authentication & Users
- `POST /api/v1/auth/register`
  - Đăng ký Shop Owner mới, tự động tạo Store và Warehouse mặc định.
  - Body: `{ fullName, email, password, storeName, storeCode, phone, address }`
- `POST /api/v1/auth/login`
  - Đăng nhập hệ thống, trả về `accessToken` và `refreshToken`.
  - Body: `{ email, password }`
- `GET /api/v1/auth/me`
  - Lấy thông tin tài khoản hiện tại kèm store & warehouse.
- `POST /api/v1/users` *(Chỉ Shop Owner)*
  - Tạo tài khoản nhân viên kho (`WAREHOUSE_STAFF`) thuộc cùng store.
- `GET /api/v1/users` *(Chỉ Shop Owner)*
  - Danh sách nhân viên trong store.

### 2.2. Categories & Products
- `GET /api/v1/categories`, `POST /api/v1/categories`, `PUT /api/v1/categories/:id`, `DELETE /api/v1/categories/:id`
- `GET /api/v1/products`
  - Danh sách sản phẩm kèm các biến thể SKU và số tồn tức thời.
  - *Lưu ý:* Nhân viên kho (`WAREHOUSE_STAFF`) sẽ bị ẩn trường `costPrice`.
- `POST /api/v1/products` *(Shop Owner)*
  - Tạo sản phẩm mới kèm danh sách SKU/biến thể.
- `PUT /api/v1/products/:id` *(Shop Owner)*
  - Cập nhật thông tin sản phẩm và SKU (không sửa tồn kho tại đây).

### 2.3. Inventory Management (Quản lý Kho)
- `GET /api/v1/inventory/balances`
  - Xem số lượng tồn hiện tại của từng SKU theo kho.
- `GET /api/v1/inventory/movements`
  - Lịch sử biến động kho (Stock Movements audit trail).
- `POST /api/v1/inventory/inflow`
  - Nhập hàng vào kho (Goods Receipt).
  - Body: `{ warehouseId, items: [{ stockItemId, quantity }], note, referenceId }`
- `POST /api/v1/inventory/outflow`
  - Xuất hàng thủ công (loại trừ xuất bán đơn).
- `POST /api/v1/inventory/audit`
  - Kiểm kê điều chỉnh số tồn thực tế (Audit stock reconciliation).

### 2.4. Orders (Đơn hàng)
- `GET /api/v1/orders` - Danh sách đơn hàng theo filter trạng thái.
- `GET /api/v1/orders/:id` - Chi tiết đơn hàng và snapshot giá từng dòng.
- `POST /api/v1/orders` - Tạo đơn hàng nháp (`DRAFT`). Backend tự tính tổng tiền.
- `POST /api/v1/orders/:id/confirm` - Xác nhận đơn: Trừ tồn kho nguyên tử và chuyển trạng thái `CONFIRMED`.
- `POST /api/v1/orders/:id/fulfill` - Hoàn thành đơn hàng (`FULFILLED`).
- `POST /api/v1/orders/:id/cancel` - Hủy đơn: Hoàn lại tồn kho nếu đơn đã `CONFIRMED`.

### 2.5. Returns (Trả hàng)
- `POST /api/v1/returns`
  - Tạo yêu cầu trả hàng trên đơn `FULFILLED`. Hỗ trợ trả một phần.
  - Body: `{ orderId, items: [{ orderItemId, quantity, isRestockable, note }], reason }`
- `GET /api/v1/returns` - Danh sách đơn trả hàng.

### 2.6. Analytics & Dashboard *(Shop Owner)*
- `GET /api/v1/analytics/dashboard`
  - Thống kê thời gian thực: Tổng đơn hoàn thành, Doanh thu gộp, Khoản hoàn tiền, Doanh thu ròng, Tổng giá trị định giá kho.
