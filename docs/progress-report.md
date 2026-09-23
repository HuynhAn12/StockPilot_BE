# Báo Cáo Tiến Độ Dự Án StockPilot Backend (Progress Report)

**Dự án:** StockPilot Backend - Nền tảng Quản lý Kho, Đơn hàng & Tối ưu hóa Giá Thông minh  
**Phiên bản:** 1.0.0 (Giai đoạn Hoàn thiện Core Architecture & Business Flows)  
**Thời gian cập nhật:** Tháng 09/2026  
**Nhánh phát triển:** `Sang`

---

## 1. Tổng Quan Tiến Độ Dự Án

Hệ thống Backend StockPilot đã hoàn thành thiết kế kiến trúc tổng thể, mô hình cơ sở dữ liệu quan hệ trên MySQL 8.4 InnoDB thông qua Prisma ORM, hoàn thiện 8 module nghiệp vụ cốt lõi và bộ kiểm thử tự động end-to-end bảo đảm tính toàn vẹn dữ liệu.

| Hạng mục / Giai đoạn | Nội dung công việc | Trạng thái | Đánh giá / Ghi chú |
|---|---|:---:|---|
| **Phase 1: Architecture & DB Design** | Thiết lập Modular Monolith, TypeScript, Prisma Schema, MySQL Multi-tenant (Store Scope) | **Hoàn thành** | Chuẩn hóa toàn bộ quan hệ 1-N, N-N và chỉ mục tối ưu |
| **Phase 2: Core Auth & RBAC** | Đăng ký tài khoản kèm tạo Store/Kho nguyên tử trong 1 Transaction; JWT Authentication; RBAC Middleware; Sensitive Data Masking | **Hoàn thành** | Đạt chuẩn an toàn OWASP, bảo vệ giá vốn đối với nhân viên kho |
| **Phase 3: Catalog & SKU Management** | Quản lý Danh mục (Categories), Sản phẩm (Products), Biến thể SKU (StockItems) | **Hoàn thành** | Ràng buộc duy nhất `(store_id, sku)`, hỗ trợ quản lý giá vốn và giá niêm yết |
| **Phase 4: Inventory & Movements** | Quản lý số dư tồn kho tức thời (`InventoryBalance`), sổ cái biến động kho (`StockMovement`), Nhập/Xuất/Kiểm kê | **Hoàn thành** | Kiểm soát biến động kho có kiểm toán (Audit Trail), chống sửa tồn trực tiếp |
| **Phase 5: Orders & Atomic Deduction** | Vòng đời đơn hàng `DRAFT` -> `CONFIRMED` (Trừ tồn kho nguyên tử) -> `FULFILLED` -> `CANCELED` (Hoàn tồn kho) | **Hoàn thành** | Chống bán vượt tồn (Race conditions), Snapshot giá vốn/giá bán tại thời điểm tạo đơn |
| **Phase 6: Returns & Refunds** | Xử lý trả hàng đơn `FULFILLED`, hoàn tiền ghi sổ, xử lý hàng lỗi không nhập lại kho, hoàn kho hàng tốt | **Hoàn thành** | Chặn trả vượt số lượng đã mua, ghi nhận lý do trả hàng chi tiết |
| **Phase 7: Analytics & Dashboard** | Thống kê doanh thu gộp, hoàn tiền, doanh thu ròng, số lượng đơn hàng, định giá tồn kho | **Hoàn thành** | Tổng hợp dữ liệu tài chính và giá trị kho chính xác |
| **Phase 8: Automated Testing** | Bộ test Jest & Supertest kiểm thử toàn bộ luồng nghiệp vụ và bất biến dữ liệu | **Hoàn thành** | 100% test cases trọng yếu vượt qua thành công |
| **Phase 9: Advanced Engine & AI** | Decision Engine (ROP/Safety Stock/Dead stock), Alerts & Notification System, AI Assistant, CSV Batch Import | *Sẵn sàng triển khai (Sprint 3-4)* | Đã chuẩn bị đầy đủ Data Contracts tại `docs/next-steps.md` |

---

## 2. Chi Tiết Các Module Đã Triển Khai

### 2.1. Kiến Trúc & Cấu Hình Nền Tảng (`src/config/`, `src/common/`)
- **App Configuration:** Xác thực biến môi trường bằng `Zod` (`src/config/env.ts`).
- **Database Client:** Prisma Client cấu hình logging và kết nối tự động (`src/config/database.ts`).
- **Error Handling:** Lớp ngoại lệ chuẩn hóa `AppError`, `NotFoundError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError`, `ValidationError` cùng middleware xử lý lỗi tập trung `errorHandler`.
- **Bảo mật & Phân quyền:**
  - `authenticateToken`: Giải mã và kiểm tra tính hợp lệ của JWT token.
  - `requireRole`: Kiểm tra vai trò người dùng (`SHOP_OWNER`, `WAREHOUSE_STAFF`, `ADMIN`).
  - `maskSensitiveProductData`: Tự động ẩn `costPrice` khi người dùng có vai trò `WAREHOUSE_STAFF`.

### 2.2. Phân Hệ Xác Thực & Quản Lý Cửa Hàng (`src/modules/auth/`, `src/modules/users/`)
- **Atomic Registration:** Đăng ký tài khoản Shop Owner đồng thời tạo `Store` và `Warehouse` mặc định trong một Prisma Transaction duy nhất.
- **Token Management:** Phát hành Access Token (15m - 2h) và Refresh Token (7d) có lưu trữ mã băm an toàn trong CSDL.
- **User Management:** Shop Owner quản lý danh sách và cấp tài khoản nhân viên kho (`WAREHOUSE_STAFF`) trực thuộc cửa hàng của mình.

### 2.3. Phân Hệ Danh Mục & Sản Phẩm (`src/modules/categories/`, `src/modules/products/`)
- Quản lý cây danh mục độc lập theo từng cửa hàng.
- Tạo sản phẩm kèm biến thể SKU (`StockItem`).
- Mỗi SKU có thông số quản lý kho riêng biệt (`costPrice`, `sellingPrice`, `minStockLevel`, `maxStockLevel`).

### 2.4. Phân Hệ Quản Lý Kho & Biến Động Tồn Kho (`src/modules/inventory/`)
- **Sổ cái tồn kho (`StockMovement`):** Mọi thao tác tăng/giảm tồn kho đều bắt buộc tạo bản ghi lịch sử với các loại giao dịch: `INBOUND`, `OUTBOUND`, `ADJUSTMENT_INCREASE`, `ADJUSTMENT_DECREASE`, `ORDER_FULFILL`, `ORDER_CANCEL_RESTOCK`, `RETURN_RESTOCK`.
- **Số dư tồn kho tức thời (`InventoryBalance`):** Cập nhật nguyên tử số dư khả dụng, ngăn chặn số dư âm.

### 2.5. Phân Hệ Đơn Hàng & Vòng Đời Đơn (`src/modules/orders/`)
- **Tạo đơn hàng (`DRAFT`):** Chụp lại Snapshot giá bán (`unitPriceSnapshot`) và giá vốn (`costPriceSnapshot`). Hệ thống tự tính tổng tiền, ngăn chặn can thiệp giá từ client.
- **Xác nhận đơn (`CONFIRMED`):** Kiểm tra tồn kho tức thời và thực hiện trừ tồn kho nguyên tử. Báo lỗi ngay lập tức nếu bất kỳ sản phẩm nào không đủ hàng.
- **Hoàn thành đơn (`FULFILLED`):** Xác nhận giao hàng thành công.
- **Hủy đơn (`CANCELED`):** Cho phép hủy đơn `DRAFT` (không ảnh hưởng tồn kho) hoặc đơn `CONFIRMED` (tự động hoàn tồn kho và ghi sổ movement `ORDER_CANCEL_RESTOCK`). Ngăn chặn hủy trực tiếp đơn đã `FULFILLED`.

### 2.6. Phân Hệ Đổi Trả Hàng & Hoàn Tiền (`src/modules/returns/`)
- Chỉ cho phép tạo phiếu trả hàng trên các đơn hàng đã hoàn thành (`FULFILLED`).
- Kiểm tra tính hợp lệ của từng sản phẩm đổi trả: số lượng trả không được vượt quá số lượng đã mua trừ đi số lượng đã trả trước đó.
- Phân loại hàng đổi trả:
  - **Hàng còn tốt (`isRestockable = true`):** Nhập lại kho và ghi nhận `RETURN_RESTOCK`.
  - **Hàng hỏng/lỗi (`isRestockable = false`):** Ghi nhận hư hỏng, không tăng lại số lượng tồn kho khả dụng.
- Cập nhật số tiền hoàn ghi sổ (`totalRefundAmount`) cho đơn hàng.

### 2.7. Phân Hệ Báo Cáo Phân Tích (`src/modules/analytics/`)
- Tính toán doanh thu gộp (`grossRevenue`), tổng tiền hoàn trả (`totalRefunded`), doanh thu ròng (`netRevenue`).
- Tổng hợp số lượng đơn hàng theo từng trạng thái.
- Định giá tổng giá trị kho hàng theo giá vốn (`totalCostValue`) và giá bán niêm yết (`totalRetailValue`).

---

## 3. Đối Soát Các Quyết Định Nghiệp Vụ (D1 – D9)

| Mã | Quyết định nghiệp vụ | Trạng thái triển khai |
|---|---|:---:|
| **D1** | Khởi tạo tài khoản, Store và Warehouse mặc định nguyên tử trong 1 Transaction | **Đã áp dụng & Kiểm thử thành công** |
| **D2** | Ràng buộc duy nhất SKU theo phạm vi từng Store (`store_id, sku`) | **Đã áp dụng & Kiểm thử thành công** |
| **D3** | Định nghĩa đơn vị giữ tồn kho là `StockItem` (hỗ trợ sản phẩm đơn và biến thể) | **Đã áp dụng & Kiểm thử thành công** |
| **D4** | Số lượng tồn kho quản lý qua `InventoryBalance` + bắt buộc sinh `StockMovement` | **Đã áp dụng & Kiểm thử thành công** |
| **D5** | Trừ tồn kho nguyên tử tại thời điểm chuyển đơn sang `CONFIRMED` | **Đã áp dụng & Kiểm thử thành công** |
| **D6** | Hoàn tồn khi hủy đơn `CONFIRMED`, chặn hủy đơn `FULFILLED` | **Đã áp dụng & Kiểm thử thành công** |
| **D7** | Snapshot giá vốn và giá bán tại thời điểm tạo đơn, backend tự tính tổng tiền | **Đã áp dụng & Kiểm thử thành công** |
| **D8** | Cho phép trả hàng một phần trên đơn `FULFILLED`, hoàn tiền ghi sổ, xử lý hàng lỗi | **Đã áp dụng & Kiểm thử thành công** |
| **D9** | Ẩn giá vốn (`costPrice`) đối với vai trò `WAREHOUSE_STAFF` (Data Masking) | **Đã áp dụng & Kiểm thử thành công** |

---

## 4. Kế Hoạch Triển Khai Giai Đoạn Tiếp Theo (Sprint 3 & Sprint 4)

1. **Module Decision Engine (Tối ưu hóa Tồn kho & Giá bán):**
   - Tính toán Điểm đặt hàng lại (Reorder Point - ROP) và Tồn kho an toàn (Safety Stock - SS).
   - Nhận diện hàng ứ đọng, tồn kho chết (Dead Stock `> 90 ngày`).
   - Đề xuất mức chiết khấu/giảm giá (Markdown Recommendation) bảo đảm biên lợi nhuận tối thiểu (`minMarginFloor`).
2. **Module Cảnh báo & Thông báo (Alerts & Notifications):**
   - Cảnh báo tồn kho thấp (`LOW_STOCK`), hết hàng (`STOCKOUT`), hàng tồn quá lâu (`OVERSTOCK_DEADSTOCK`).
   - Phân luồng thông báo cho Shop Owner và Warehouse Staff qua SSE/WebSocket/Polling.
3. **Module AI Decision Assistant:**
   - Tích hợp OpenAI Responses API với giao thức Read-Only và Context Injection theo từng Store.
4. **Module Import / Export Dữ liệu Hàng loạt (CSV / Excel):**
   - Luồng Dry-run Preview và Batch Insert/Update Idempotent có phòng chống Formula Injection.
