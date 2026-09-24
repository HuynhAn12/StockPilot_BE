# Tài liệu API Đặc tả Hệ thống StockPilot

Phiên bản: `v1.0.2`  
Tiền tố hệ thống: `/api/v1`  
Tổng số Endpoints hiện tại: **36 Endpoints**

---

## 1. Chuẩn Hóa Phản Hồi & Mã Lỗi (Uniform Response & Error Format)

### Phản hồi thành công:
```json
{
  "success": true,
  "data": { ... }
}
```

### Phản hồi phân trang (List Endpoints):
```json
{
  "success": true,
  "items": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

### Phản hồi lỗi:
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

## 2. Bảng Thống Kê Chi Tiết 36 Endpoints Đã Triển Khai

### 2.1. System & Health Check (3 APIs)
| Method | Endpoint | Quyền (Roles) | Mô tả chi tiết |
|---|---|:---:|---|
| `GET` | `/api/v1/health` | Public | Thông tin phiên bản, trạng thái dịch vụ và timestamp |
| `GET` | `/api/v1/health/live` | Public | Liveness probe cho container orchestrator |
| `GET` | `/api/v1/health/ready` | Public | Readiness probe kiểm tra kết nối CSDL MySQL |

---

### 2.2. Authentication & Profile (5 APIs)
| Method | Endpoint | Quyền (Roles) | Mô tả chi tiết |
|---|---|:---:|---|
| `POST` | `/api/v1/auth/register` | Public | Đăng ký Shop Owner + tạo Store và Warehouse mặc định trong 1 Transaction |
| `POST` | `/api/v1/auth/login` | Public | Đăng nhập hệ thống, cấp Access Token & Refresh Token |
| `POST` | `/api/v1/auth/refresh` | Public | Cấp mới Access Token từ Refresh Token hợp lệ (Rotation & Race-safe Replay Detection) |
| `GET` | `/api/v1/auth/me` | Authenticated | Lấy thông tin tài khoản hiện tại kèm thông tin cửa hàng |
| `POST` | `/api/v1/auth/logout` | Authenticated | Thu hồi phiên đăng nhập hiện tại |

---

### 2.3. User & Staff Management (2 APIs)
| Method | Endpoint | Quyền (Roles) | Mô tả chi tiết |
|---|---|:---:|---|
| `POST` | `/api/v1/users` | `SHOP_OWNER` (Store Scoped) | Tạo tài khoản nhân viên kho (`WAREHOUSE_STAFF`) thuộc cùng store |
| `GET` | `/api/v1/users` | `SHOP_OWNER` (Store Scoped) | Lấy danh sách nhân viên trực thuộc cửa hàng (Phân trang) |

---

### 2.4. Categories Management (5 APIs)
| Method | Endpoint | Quyền (Roles) | Mô tả chi tiết |
|---|---|:---:|---|
| `GET` | `/api/v1/categories` | Store Scoped | Danh sách danh mục sản phẩm của cửa hàng (Phân trang) |
| `GET` | `/api/v1/categories/:id` | Store Scoped | Lấy thông tin chi tiết một danh mục theo ID |
| `POST` | `/api/v1/categories` | `SHOP_OWNER` | Tạo danh mục sản phẩm mới |
| `PUT` | `/api/v1/categories/:id` | `SHOP_OWNER` | Cập nhật thông tin danh mục |
| `DELETE` | `/api/v1/categories/:id` | `SHOP_OWNER` | Xóa danh mục sản phẩm |

---

### 2.5. Products & SKUs Management (4 APIs)
| Method | Endpoint | Quyền (Roles) | Mô tả chi tiết |
|---|---|:---:|---|
| `GET` | `/api/v1/products` | Store Scoped | Danh sách sản phẩm kèm biến thể SKU (Hỗ trợ `?q=`, `?categoryId=`, phân trang & ẩn `costPrice` với Staff) |
| `GET` | `/api/v1/products/:id` | Store Scoped | Chi tiết sản phẩm kèm danh sách SKU (Ẩn `costPrice` với Staff) |
| `POST` | `/api/v1/products` | `SHOP_OWNER` | Tạo sản phẩm mới kèm danh sách biến thể SKU |
| `PUT` | `/api/v1/products/:id` | `SHOP_OWNER` | Cập nhật thông tin sản phẩm và biến thể SKU |

---

### 2.6. Inventory & Stock Ledger (5 APIs)
| Method | Endpoint | Quyền (Roles) | Mô tả chi tiết |
|---|---|:---:|---|
| `GET` | `/api/v1/inventory/balances` | Store Scoped | Số dư tồn kho tức thời từng SKU theo kho (Phân trang, ẩn `costPrice` với Staff) |
| `GET` | `/api/v1/inventory/movements` | Store Scoped | Sổ cái lịch sử biến động kho có kiểm toán (`?stockItemId=`, `?type=`, phân trang) |
| `POST` | `/api/v1/inventory/inflow` | Store Scoped | Nhập kho hàng hóa (Inbound) tăng tồn kho nguyên tử |
| `POST` | `/api/v1/inventory/outflow` | Store Scoped | Xuất kho thủ công (Outbound) trừ tồn kho nguyên tử |
| `POST` | `/api/v1/inventory/audit` | Store Scoped | Kiểm kê và điều chỉnh cân bằng tồn kho thực tế với Row-Level Lock (`SELECT ... FOR UPDATE`) |

---

### 2.7. Orders Management (6 APIs)
| Method | Endpoint | Quyền (Roles) | Mô tả chi tiết |
|---|---|:---:|---|
| `GET` | `/api/v1/orders` | Store Scoped | Danh sách đơn hàng (`?status=`, phân trang) |
| `GET` | `/api/v1/orders/:id` | Store Scoped | Chi tiết đơn hàng, snapshot giá và thông tin hoàn trả |
| `POST` | `/api/v1/orders` | Store Scoped | Tạo đơn hàng nháp (`DRAFT`), tính toán bằng `Prisma.Decimal` |
| `POST` | `/api/v1/orders/:id/confirm` | Store Scoped | Xác nhận đơn (`CONFIRMED`), trừ tồn kho nguyên tử chống overselling |
| `POST` | `/api/v1/orders/:id/fulfill` | Store Scoped | Hoàn thành giao đơn hàng (`FULFILLED`) |
| `POST` | `/api/v1/orders/:id/cancel` | Store Scoped | Hủy đơn (`CANCELED`), tự động hoàn tồn kho nếu đơn đã `CONFIRMED` |

---

### 2.8. Returns & Refunds (2 APIs)
| Method | Endpoint | Quyền (Roles) | Mô tả chi tiết |
|---|---|:---:|---|
| `GET` | `/api/v1/returns` | Store Scoped | Danh sách các phiếu đổi trả hàng của cửa hàng |
| `POST` | `/api/v1/returns` | Store Scoped | Tạo phiếu trả hàng với **Atomic Return Concurrency Guard** (`returnedQuantity` check) chống over-return |

---

### 2.9. Analytics & Reporting (1 API)
| Method | Endpoint | Quyền (Roles) | Mô tả chi tiết |
|---|---|:---:|---|
| `GET` | `/api/v1/analytics/dashboard` | `SHOP_OWNER`, `ADMIN` | Báo cáo doanh thu gộp, hoàn tiền, doanh thu ròng, định giá kho bằng SQL Aggregation |

---

### 2.10. Bulk Import & Export (4 APIs)
| Method | Endpoint | Quyền (Roles) | Mô tả chi tiết |
|---|---|:---:|---|
| `POST` | `/api/v1/import/preview` | `SHOP_OWNER` | Dry-run validation danh sách import sản phẩm/tồn kho (kiểm tra SKU trùng, sai format mà không ghi DB) |
| `POST` | `/api/v1/import/commit` | `SHOP_OWNER` | Xác nhận import hàng loạt theo chunk (100 rows / transaction) |
| `GET` | `/api/v1/export/products` | Store Scoped | Xuất toàn bộ danh sách sản phẩm & SKU ra file CSV (Phòng chống Formula Injection, ẩn giá vốn với Staff) |
| `GET` | `/api/v1/export/inventory` | Store Scoped | Xuất số dư tồn kho ra file CSV (Phòng chống Formula Injection, ẩn giá vốn với Staff) |
