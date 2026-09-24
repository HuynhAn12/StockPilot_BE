# StockPilot Backend API Documentation (Master Reference)

**Phiên bản hệ thống:** `v1.0.0` (Production Hardened)  
**Tiền tố Base URL:** `/api/v1`  
**Tổng số Endpoints:** **52 Endpoints**  
**Múi giờ nghiệp vụ:** `Asia/Ho_Chi_Minh` (GMT+7)

---

## 1. Chuẩn Hóa Kiến Trúc & Giao Thức (Standard Protocol)

### 1.1. Cơ chế Xác thực & Phiên (Authentication & Session Rotation)
- **Access Token:** Bearer JWT truyền qua Header `Authorization: Bearer <access_token>` (Hạn dùng: 1 ngày).
- **Refresh Token Rotation:** Cấp lại Access Token và xoay vòng Refresh Token an toàn, chống Replay Attack và chống Race Condition bằng cơ chế Single Session Mapping.

### 1.2. Phân Quyền & Đa Chi Nhánh (RBAC & Multi-Tenancy)
- **Multi-Tenancy:** Mỗi `Store` là một tenant cô lập dữ liệu hoàn toàn. Mọi truy vấn bắt buộc có `storeId` được xác thực từ Session.
- **Roles:**
  - `SHOP_OWNER`: Toàn quyền quản trị, cấu hình Engine, xem giá vốn (`costPrice`), chấp thuận đề xuất giá và quản lý nhân viên.
  - `WAREHOUSE_STAFF`: Quản lý kho, nhập/xuất kho, tạo đơn, trả hàng, xem báo cáo vận hành. Bị ẩn trường nhạy cảm `costPrice` trên toàn bộ danh mục sản phẩm/kho.

### 1.3. Chuẩn Hóa Request / Response & Lỗi (Envelope & Error Schema)

#### Phản hồi thành công (Single Data):
```json
{
  "success": true,
  "data": { ... }
}
```

#### Phản hồi danh sách có phân trang (Pagination):
```json
{
  "success": true,
  "items": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 120,
    "totalPages": 6
  }
}
```

#### Phản hồi lỗi chuẩn (RFC-7807 Aligned Error Schema):
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR | UNAUTHENTICATED | FORBIDDEN | NOT_FOUND | CONFLICT | INSUFFICIENT_STOCK | IDEMPOTENCY_CONFLICT | INTERNAL_ERROR",
    "message": "Mô tả chi tiết nguyên nhân lỗi cho người dùng",
    "details": {},
    "requestId": "6d3c90e2-76be-4cb3-a602-0c9f864e432a"
  }
}
```

### 1.4. Cơ chế Đảm Bảo Idempotency (Chống Trùng Lặp)
Các API biến đổi dữ liệu tài chính/kho hỗ trợ Header `Idempotency-Key: <unique-uuid>`. Khi nhận trùng key trong vòng 24h, hệ thống trả lại kết quả nguyên bản mà không thực hiện lặp giao dịch.

---

## 2. Bảng Tổng Hợp 52 Endpoints Theo Phân Hệ

### Phân hệ 1: Hệ thống & Kiểm tra Sức khỏe (System & Health)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `GET` | `/api/v1/health` | Public | Thông tin phiên bản, trạng thái dịch vụ và thời gian hệ thống |
| `GET` | `/api/v1/health/live` | Public | Liveness probe cho Container Orchestrator (Docker/K8s) |
| `GET` | `/api/v1/health/ready` | Public | Readiness probe kiểm tra kết nối CSDL MySQL 8.4 |

---

### Phân hệ 2: Xác thực & Phiên Người Dùng (Auth & Session)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `POST` | `/api/v1/auth/register` | Public | Đăng ký Shop Owner mới + Tự động khởi tạo Store và Warehouse mặc định |
| `POST` | `/api/v1/auth/login` | Public | Đăng nhập hệ thống, cấp Access Token & Refresh Token |
| `POST` | `/api/v1/auth/refresh` | Public | Làm mới Access Token (Single-use Refresh Token Rotation) |
| `GET` | `/api/v1/auth/me` | Authenticated | Lấy thông tin tài khoản hiện tại kèm thông tin cửa hàng |
| `POST` | `/api/v1/auth/logout` | Authenticated | Thu hồi Refresh Token và đóng phiên đăng nhập |

---

### Phân hệ 3: Quản lý Nhân sự Cửa hàng (Staff Management)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `POST` | `/api/v1/users` | `SHOP_OWNER` | Tạo tài khoản nhân viên kho (`WAREHOUSE_STAFF`) thuộc cùng Store |
| `GET` | `/api/v1/users` | `SHOP_OWNER` | Danh sách nhân sự trực thuộc cửa hàng (Hỗ trợ phân trang) |

---

### Phân hệ 4: Danh mục Sản phẩm (Categories)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `GET` | `/api/v1/categories` | Store Scoped | Lấy danh sách danh mục sản phẩm (Phân trang, tìm kiếm theo tên/code) |
| `GET` | `/api/v1/categories/:id` | Store Scoped | Lấy thông tin chi tiết một danh mục theo ID |
| `POST` | `/api/v1/categories` | `SHOP_OWNER` | Tạo danh mục sản phẩm mới (Mã code duy nhất theo store) |
| `PUT` | `/api/v1/categories/:id` | `SHOP_OWNER` | Cập nhật thông tin danh mục sản phẩm |
| `DELETE` | `/api/v1/categories/:id` | `SHOP_OWNER` | Xóa danh mục sản phẩm |

---

### Phân hệ 5: Sản phẩm & Biến thể SKU (Products & StockItems)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `GET` | `/api/v1/products` | Store Scoped | Danh sách sản phẩm kèm biến thể SKU (Ẩn `costPrice` với `WAREHOUSE_STAFF`) |
| `GET` | `/api/v1/products/:id` | Store Scoped | Chi tiết sản phẩm kèm danh sách SKU (Ẩn `costPrice` với Staff) |
| `POST` | `/api/v1/products` | `SHOP_OWNER` | Tạo sản phẩm mới kèm danh sách các biến thể SKU (Mã SKU duy nhất theo store) |
| `PUT` | `/api/v1/products/:id` | `SHOP_OWNER` | Cập nhật thông tin sản phẩm và cấu hình giá/mức tồn kho an toàn |

---

### Phân hệ 6: Quản lý Kho & Sổ cái Tồn kho (Inventory & Ledger)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `GET` | `/api/v1/inventory/balance` | Store Scoped | Lấy tồn kho hiện tại theo kho/SKU (Lọc `warehouseId`, `stockItemId`, `lowStockOnly`) |
| `POST` | `/api/v1/inventory/inflow` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Nhập kho thủ công / nhập hàng từ nhà cung cấp (Ghi nhận StockMovement `INFLOW`) |
| `POST` | `/api/v1/inventory/outflow` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Xuất kho tiêu hao / thanh lý (Kiểm tra chặn tồn kho âm, ghi StockMovement `OUTFLOW`) |
| `POST` | `/api/v1/inventory/transfer` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Điều chuyển tồn kho giữa 2 kho trong cùng store (Atomic 2-leg Movement) |
| `GET` | `/api/v1/inventory/movements` | Store Scoped | Truy vấn lịch sử biến động sổ cái kho (Stock Ledger Audit Trail) |

---

### Phân hệ 7: Đơn hàng Bán lẻ (Orders & Fulfillment)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `POST` | `/api/v1/orders` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Tạo đơn hàng mới ở trạng thái `DRAFT` (Tính toán tự động chiết khấu, thuế, giá vốn snapshot) |
| `POST` | `/api/v1/orders/:id/confirm` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Xác nhận đơn hàng (`DRAFT` $\to$ `CONFIRMED`) |
| `POST` | `/api/v1/orders/:id/fulfill` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Xuất kho giao hàng (`FULFILLED`): Khóa dòng FOR UPDATE, trừ tồn kho, ghi nhận doanh thu thực nhận |
| `POST` | `/api/v1/orders/:id/cancel` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Hủy đơn hàng và tự động hoàn trả tồn kho nếu đơn đã trừ kho |
| `GET` | `/api/v1/orders` | Store Scoped | Danh sách đơn hàng (Lọc trạng thái `DRAFT`, `CONFIRMED`, `FULFILLED`, `CANCELLED`) |

---

### Phân hệ 8: Đổi Trả Hàng (Returns Management)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `POST` | `/api/v1/returns` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Tạo phiếu trả hàng: Chống trả vượt số lượng, hoàn tiền theo tỷ lệ thực nhận (`refundableAmount`), hoàn vốn theo giá gốc `costPriceSnapshot` |
| `GET` | `/api/v1/returns` | Store Scoped | Danh sách phiếu đổi trả hàng kèm chi tiết từng sản phẩm hoàn trả |

---

### Phân hệ 9: Nhập/Xuất Dữ liệu Hàng loạt (Import / Export)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `POST` | `/api/v1/import/preview` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Xem trước file nhập (`NEW_PRODUCTS`, `UPDATE_STOCK`, `REPLACE_STOCK`): Kiểm tra lỗi trước khi lưu |
| `POST` | `/api/v1/import/commit` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Áp dụng chính thức lô dữ liệu đã preview vào CSDL (Idempotent execution) |
| `GET` | `/api/v1/export/products` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Xuất danh mục sản phẩm & SKU ra file CSV/JSON |
| `GET` | `/api/v1/export/inventory` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Xuất số dư tồn kho chi tiết ra file CSV/JSON |
| `GET` | `/api/v1/export/orders` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Xuất danh sách đơn hàng và trạng thái doanh thu ra file CSV/JSON |

---

### Phân hệ 10: Dữ liệu Bán hàng Lịch sử (Historical Sales)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `POST` | `/api/v1/historical-sales/preview` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Preview nạp dữ liệu bán hàng quá khứ (Kiểm tra chống trùng khoảng thời gian với đơn Native) |
| `POST` | `/api/v1/historical-sales/commit` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Lưu dữ liệu bán hàng lịch sử để phục vụ Decision Engine học xu hướng |
| `GET` | `/api/v1/historical-sales` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Truy vấn danh sách bản ghi bán hàng lịch sử |

---

### Phân hệ 11: Decision Engine & Cấu hình Động (Inventory Intelligence)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `GET` | `/api/v1/decision-engine/sku/:stockItemId` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Phân tích toàn diện 1 SKU: Dự báo nhu cầu, Điểm đặt hàng lại (ROP), Tồn an toàn (Safety Stock), Rủi ro đứt hàng / dư thừa |
| `GET` | `/api/v1/decision-engine/overview` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Tổng quan sức khỏe kho toàn cửa hàng: Tổng SKU, phân bố rủi ro, danh sách SKU cần hành động |
| `POST` | `/api/v1/decision-engine/recalculate` | `SHOP_OWNER` | Kích hoạt quét lại toàn bộ dữ liệu 90 ngày và tính toán lại toàn bộ chỉ số cho tất cả SKU |
| `GET` | `/api/v1/decision-engine/config` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Lấy cấu hình Engine: Lead time, Safety days, Service level, Ngưỡng rủi ro |
| `PUT` | `/api/v1/decision-engine/config` | `SHOP_OWNER` | Cập nhật cấu hình Decision Engine cho cửa hàng |

---

### Phân hệ 12: Cảnh báo Thông minh (Smart Inventory Alerts)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `GET` | `/api/v1/alerts` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Danh sách cảnh báo (`LOW_STOCK`, `STOCKOUT`, `OVERSTOCK_DEADSTOCK`, `UNUSUAL_DEMAND`) |
| `POST` | `/api/v1/alerts/:id/acknowledge` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Đánh dấu đã tiếp nhận xử lý cảnh báo (`ACKNOWLEDGED`) |
| `POST` | `/api/v1/alerts/:id/resolve` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Đánh dấu đã xử lý xong cảnh báo (`RESOLVED`) |

---

### Phân hệ 13: Đề xuất Tối ưu Giá bán (Pricing Recommendations & Price History)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `GET` | `/api/v1/pricing` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Danh sách đề xuất điều chỉnh giá bán (`INCREASE`, `DECREASE`, `MAINTAIN`) kèm độ tự tin |
| `POST` | `/api/v1/pricing/:id/accept` | `SHOP_OWNER` | Chấp thuận giá đề xuất: Tự động cập nhật `sellingPrice` của SKU và lưu `PriceHistory` |
| `POST` | `/api/v1/pricing/:id/reject` | `SHOP_OWNER` | Từ chối áp dụng đề xuất điều chỉnh giá |
| `POST` | `/api/v1/pricing/:id/modify` | `SHOP_OWNER` | Điều chỉnh mức giá thủ công theo ý Shop Owner và ghi nhận vào `PriceHistory` |

---

### Phân hệ 14: Trợ lý AI Giải thích Quyết định (AI Assistant - Read Only)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `GET` | `/api/v1/assistant/sku/:stockItemId` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Trợ lý AI giải thích bằng ngôn ngữ tự nhiên lý do rủi ro tồn kho và gợi ý hành động cho SKU |
| `GET` | `/api/v1/assistant/overview` | `SHOP_OWNER`, `WAREHOUSE_STAFF` | Báo cáo tóm tắt tình trạng vận hành và cảnh báo chiến lược toàn cửa hàng bằng AI |

---

### Phân hệ 15: Báo cáo Thống kê & Phân tích (Analytics Dashboard)
| Method | Endpoint | Quyền | Mô tả |
|---|---|:---:|---|
| `GET` | `/api/v1/analytics/dashboard` | Store Scoped | Báo cáo KPI tổng hợp: Doanh thu thực nhận, Số đơn hoàn thành, Giá trị tồn kho, Cảnh báo nóng |
| `GET` | `/api/v1/analytics/inventory` | Store Scoped | Báo cáo chuyên sâu về giá trị vốn tồn kho, tổng lượng tồn, phân bổ theo danh mục |
| `GET` | `/api/v1/analytics/sales` | Store Scoped | Biểu đồ chuỗi thời gian doanh thu và lợi nhuận gộp theo ngày kinh doanh |
| `GET` | `/api/v1/analytics/top-selling` | Store Scoped | Danh sách Top sản phẩm bán chạy nhất kèm sản lượng và doanh thu thực |

---

## 3. Quy Tắc Kế Toán & Múi Giờ Cốt Lõi (Key Business Invariants)

1. **Doanh thu Thực nhận (`realizedRevenue`):**
   - Đơn bán tính theo `OrderItem.refundableAmount` (sau phân bổ chiết khấu/thuế cấp đơn hàng).
2. **Hạch toán Hoàn tiền & Trả hàng:**
   - Hoàn tiền đúng theo `ReturnItem.refundPrice` (không nhân trùng số lượng).
   - Ngày chỉ có trả hàng cho phép `netSoldQty` và `netRevenue` âm phản ánh đúng dòng tiền/sản lượng thực tế.
3. **Hạch toán Giá vốn Hàng bán (Return COGS):**
   - **Hàng nhập lại kho (`isRestockable = true`):** Hoàn lại giá vốn theo đúng `OrderItem.costPriceSnapshot` tại thời điểm bán (kể cả khi `costPrice` hiện tại đã thay đổi).
   - **Hàng hỏng / tiêu hủy (`isRestockable = false`):** Không hoàn lại giá vốn (`COGS reversal = 0`).
4. **Phân Vùng Ngày Kinh Doanh (Business Date Partitioning):**
   - Mọi mốc thời gian được phân vùng nửa mở `[start, end)` theo múi giờ `APP_TIMEZONE` (`Asia/Ho_Chi_Minh`), lưu trữ ngày tổng hợp canonical dạng `YYYY-MM-DDT00:00:00.000Z`.
