# Báo Cáo Tiến Độ Dự Án StockPilot Backend (Progress Report)

**Dự án:** StockPilot Backend - Nền tảng Quản lý Kho, Đơn hàng & Tối ưu hóa Giá Thông minh  
**Phiên bản:** 1.0.1 (Giai đoạn Hoàn thiện Core Architecture, Atomic Concurrency & Repair Plan)  
**Thời gian cập nhật:** Tháng 09/2026  
**Nhánh phát triển:** `Sang`

---

## 1. Tổng Quan Tiến Độ Dự Án

Hệ thống Backend StockPilot đã hoàn thành thiết kế kiến trúc tổng thể, mô hình cơ sở dữ liệu quan hệ trên MySQL 8.4 InnoDB thông qua Prisma ORM, hoàn thiện 8 module nghiệp vụ cốt lõi, cơ chế kiểm soát tranh chấp dữ liệu đồng thời (Concurrency Control & Deadlock Prevention), sâu hóa bảo mật dữ liệu và thiết lập pipeline GitHub Actions CI.

| Hạng mục / Giai đoạn | Nội dung công việc | Trạng thái | Đánh giá / Ghi chú |
|---|---|:---:|---|
| **Phase 1: Architecture & DB Design** | Thiết lập Modular Monolith, TypeScript, Prisma Schema, MySQL Multi-tenant (Store Scope) | **Hoàn thành** | Chuẩn hóa toàn bộ quan hệ 1-N, N-N và chỉ mục tối ưu |
| **Phase 2: Core Auth & RBAC** | Đăng ký tài khoản kèm tạo Store/Kho nguyên tử; JWT Authentication; RBAC Middleware; Deep Sensitive Data Masking | **Hoàn thành** | Đạt chuẩn an toàn OWASP API3, ẩn đệ quy toàn bộ giá vốn/biên lợi nhuận với Staff |
| **Phase 3: Catalog & SKU Management** | Quản lý Danh mục (Categories), Sản phẩm (Products), Biến thể SKU (StockItems) | **Hoàn thành** | Ràng buộc duy nhất `(store_id, sku)`, hỗ trợ quản lý giá vốn và giá niêm yết |
| **Phase 4: Inventory & Stock Ledger** | `StockLedgerService` trừ/cộng tồn kho nguyên tử (`updateMany` có điều kiện), sắp xếp SKU chống deadlock, ghi sổ `StockMovement` | **Hoàn thành** | Loại bỏ hoàn toàn nguy cơ Lost Update và Overselling khi nhiều request song song |
| **Phase 5: Orders & State Machine** | Vòng đời đơn hàng `DRAFT` -> `CONFIRMED` -> `FULFILLED` -> `CANCELED` có atomic status guards và hoàn tồn kho | **Hoàn thành** | Chống xác nhận trùng lặp, Snapshot giá vốn/giá bán tại thời điểm tạo đơn |
| **Phase 6: Returns & Refunds** | Xử lý trả hàng đơn `FULFILLED`, kiểm tra trần số lượng mua, hoàn tiền ghi sổ, xử lý hàng lỗi và hoàn kho hàng tốt | **Hoàn thành** | Chặn trả vượt số lượng đã mua (kể cả request gửi trùng dòng), ghi nhận lý do trả hàng |
| **Phase 7: Analytics & Dashboard** | Thống kê doanh thu gộp, hoàn tiền, doanh thu ròng, số lượng đơn hàng, định giá tồn kho | **Hoàn thành** | Tổng hợp dữ liệu tài chính và giá trị kho chính xác |
| **Phase 8: Automated Testing & CI** | Bộ test Jest & Supertest (7 test suites, 18 tests) + GitHub Actions CI workflow | **Hoàn thành** | Tự động hóa kiểm thử, build và validate schema trên mỗi commit/PR |
| **Phase 9: Advanced Engine & AI** | Decision Engine (ROP/Safety Stock/Dead stock), Alerts & Notification System, AI Assistant, CSV Batch Import | *Sẵn sàng triển khai (Sprint 3-4)* | Đã chuẩn bị đầy đủ Data Contracts tại `docs/next-steps.md` |

---

## 2. Chi Tiết Các Cải Tiến Kỹ Thuật (Theo Kế Hoạch Sửa Chữa)

### 2.1. Kiểm Soát Đổi Tồn Kho Đồng Thời & Sổ Cái Kho (`StockLedgerService`)
- **Khắc phục Lost Update:** Thay thế quy trình đọc–tính–ghi cũ bằng cập nhật nguyên tử `updateMany` với điều kiện `quantity: { gte: requestedQuantity }` và `decrement: requestedQuantity`.
- **Chống Deadlock:** Tự động gộp các SKU trùng lặp và sắp xếp thứ tự các SKU theo `stockItemId ASC` trước khi thao tác trong Transaction.
- **Sổ cái bất biến:** Đảm bảo `beforeQuantity` và `afterQuantity` của từng dòng `StockMovement` phản ánh chính xác trạng thái thực tế sau cập nhật trong cùng Transaction.

### 2.2. Bảo Mật Dữ Liệu & Ẩn Giá Vốn Đệ Quy (`maskSensitiveFields`)
- Nâng cấp bộ lọc dữ liệu sang cơ chế duyệt đệ quy sâu (Deep Traversal) trên mọi cấu trúc Object/Array.
- Tự động xóa triệt để các trường `costPrice`, `costPriceSnapshot`, `cost_price`, `cost_price_snapshot`, `totalCostPrice`, `profitMargin` trên cả các đối tượng đơn lẻ (`stockItem`, `product`, `orderItem`) khi trả về cho `WAREHOUSE_STAFF`.

### 2.3. Khóa Trạng Thái Đơn Hàng & Kiểm Soát Hoàn Hàng
- **Atomic State Guard:** Chuyển trạng thái đơn hàng `DRAFT` sang `CONFIRMED` hoặc `CONFIRMED` sang `FULFILLED` sử dụng conditional update guard trong Transaction, ngăn chặn 2 request đồng thời xác nhận cùng một đơn.
- **Return Bound Verification:** Kiểm tra tổng số lượng đã hoàn trả trước đó cộng với số lượng yêu cầu hoàn trả mới trong Transaction, ngăn chặn hoàn vượt số lượng mua ban đầu.

### 2.4. Khởi Động & Giám Sát Sức Khỏe Hệ Thống
- Thiết lập 3 endpoint kiểm tra:
  - `GET /api/v1/health`: Kiểm tra thông tin phiên bản và trạng thái tổng quan.
  - `GET /api/v1/health/live`: Liveness probe cho orchestrator / container runner.
  - `GET /api/v1/health/ready`: Readiness probe thực hiện query kiểm tra kết nối CSDL MySQL.
- Thêm cơ chế Graceful Shutdown đóng kết nối DB khi nhận tín hiệu `SIGTERM` / `SIGINT`.
