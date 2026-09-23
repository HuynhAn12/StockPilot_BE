# Báo Cáo Hoàn Thiện & Củng Cố Backend StockPilot (Backend Hardening Report)

**Dự án:** StockPilot Backend - Nền tảng Quản lý Kho, Đơn hàng & Tối ưu hóa Giá  
**Phiên bản:** 1.0.2 (Production Ready Baseline)  
**Nhánh nguồn:** `fix/backend-production-hardening-v2` ➔ **Nhánh đích:** `Sang`  
**Thời gian hoàn thành:** 23/09/2026  

---

## 1. Executive Summary

Toàn bộ hệ thống Backend StockPilot đã được rà soát, củng cố và nâng cấp toàn diện theo các tiêu chuẩn kỹ thuật cấp độ Production. Các rủi ro nghiêm trọng liên quan đến tranh chấp dữ liệu đồng thời (Concurrency Lost Updates, Overselling, Over-returns), an toàn phiên đăng nhập (Refresh Token Rotation & Revocation), bảo mật dữ liệu nhạy cảm (Deep Cost Price Masking), phân quyền cô lập đa cửa hàng (Store Scope Isolation) và hiệu năng tính toán tài chính (DB Aggregations) đã được giải quyết triệt để.

---

## 2. Files Changed

1. **Database & Migrations:**
   - `prisma/schema.prisma` (Bổ sung `AuthSession` model & User relations)
   - `prisma/migrations/20260923150000_baseline/migration.sql` (Baseline migration chuẩn hóa MySQL InnoDB)
2. **Core Config & Utilities:**
   - `src/config/env.ts` (Bắt buộc cấu hình production an toàn)
   - `src/common/utils/jwt.ts` (Thêm `hashToken` SHA-256)
   - `src/common/utils/pagination.ts` (Tạo tiện ích phân trang chuẩn hóa `{ page, limit, sort, order }`)
   - `src/common/middleware/auth.ts` (Kiểm tra trạng thái kích hoạt user & store tức thời)
   - `src/common/middleware/rbac.ts` (Chặn Admin dùng `x-store-id` trên Shop API)
   - `src/common/middleware/sensitive-fields.ts` (Duyệt đệ quy sâu ẩn giá vốn cho Staff)
   - `src/app.ts` (Tích hợp Helmet, Rate Limiter, 1MB body limit, Health Probes)
3. **Business Modules:**
   - `src/modules/auth/*` (`auth.service.ts`, `auth.controller.ts`, `auth.routes.ts`, `auth.schema.ts` - Thêm session rotation, logout, replay detection)
   - `src/modules/inventory/*` (`inventory.service.ts`, `inventory.controller.ts`, `inventory.routes.ts`, `stock-ledger.service.ts` - Atomic ledger, audit protection, movements pagination)
   - `src/modules/orders/*` (`order.service.ts`, `order.controller.ts`, `order.routes.ts` - Atomic deduction, pagination)
   - `src/modules/returns/*` (`return.service.ts`, `return.controller.ts`, `return.routes.ts` - Atomic return bounds check, conflict check, pagination)
   - `src/modules/products/*` (`product.service.ts`, `product.controller.ts`, `product.routes.ts` - Pagination)
   - `src/modules/categories/*` (`category.service.ts`, `category.controller.ts`, `category.routes.ts` - Pagination)
   - `src/modules/users/*` (`user.service.ts`, `user.controller.ts`, `user.routes.ts` - Pagination)
   - `src/modules/analytics/*` (`analytics.service.ts` - DB aggregation)
4. **CI & Tests:**
   - `.github/workflows/backend-ci.yml` (Nâng cấp Node.js 24 LTS, migrate deploy)
   - `tests/*` (`auth.test.ts`, `analytics.test.ts`, `api-integration.test.ts`, `inventory.test.ts`, `order-flow.test.ts`, `returns-flow.test.ts`, `sensitive-fields.test.ts`)
5. **Documentation:**
   - `docs/api.md`, `docs/database.md`, `docs/decisions.md`, `docs/progress-report.md`, `docs/security.md`

---

## 3. Bugs Fixed

1. **Return Concurrency Over-return:** Khắc phục triệt để rủi ro 2 request trả hàng đồng thời làm tổng số lượng hoàn vượt quá số lượng khách mua ban đầu.
2. **Conflicting Return Restock Policy:** Chặn đứng lỗi khi payload gửi các dòng trùng `orderItemId` nhưng khác cờ `isRestockable`.
3. **Inventory Audit Overwriting:** Đảm bảo quá trình kiểm kê điều chỉnh kho không ghi đè mất mát các giao dịch nhập/xuất kho commit song song.
4. **Stateless Refresh Token Vulnerability:** Chuyển đổi từ JWT stateless sang quản lý phiên đăng nhập `AuthSession` lưu mã băm an toàn trong CSDL.
5. **Admin Scope Bypass:** Ngăn chặn tài khoản Admin giả lập định danh cửa hàng qua header `x-store-id` hoặc query `?storeId=`.
6. **Inactive User JWT Reuse:** Khóa tài khoản hoặc vô hiệu hóa cửa hàng sẽ lập tức từ chối quyền truy cập của mọi JWT token hiện có.

---

## 4. Security Improvements

- **Helmet Security Headers:** Kích hoạt toàn bộ bộ header an toàn HTTP tiêu chuẩn.
- **Express Rate Limiting:**
  - `POST /api/v1/auth/login` và `POST /api/v1/auth/refresh`: Tối đa 10 requests / phút (Chống Brute-force & Credential Stuffing).
  - `/api/*`: Tối đa 300 requests / 15 phút.
- **Token Rotation & Replay Attack Detection:** Tự động thu hồi toàn bộ các phiên hoạt động nếu phát hiện một refresh token cũ được sử dụng lại.
- **Deep Sensitive Data Masking:** Ẩn đệ quy toàn bộ `costPrice`, `costPriceSnapshot`, `profitMargin` trên cả đối tượng đơn lẻ và danh sách lồng nhau đối với nhân viên kho.
- **Payload Limits:** Giảm giới hạn JSON body xuống 1MB để chống DoS.

---

## 5. Database Changes

- Bổ sung bảng `auth_sessions`:
  - `id` (INT AUTO_INCREMENT PK)
  - `userId` (INT FK -> `users(id)` ON DELETE CASCADE)
  - `refreshTokenHash` (VARCHAR(255) INDEX)
  - `expiresAt` (DATETIME)
  - `revokedAt` (DATETIME NULL)
  - `userAgent`, `ipAddress` (NULLABLE)
  - `createdAt`, `updatedAt` (DATETIME)

---

## 6. Migration Changes

- Khởi tạo thư mục `prisma/migrations/20260923150000_baseline/migration.sql` chứa toàn bộ 10 bảng dữ liệu chuẩn hóa, quan hệ Foreign Keys và các chỉ mục hiệu năng.

---

## 7. API Changes

- **Bổ sung API:** `POST /api/v1/auth/logout` (Đăng xuất & thu hồi session).
- **Health Probes:** `GET /api/v1/health/live` và `GET /api/v1/health/ready` (Kiểm tra kết nối CSDL).
- **Phân trang chuẩn hóa:** Bổ sung tham số `?page=1&limit=20&order=desc` và cấu trúc trả về `{ success: true, items: [...], pagination: { page, limit, total, totalPages } }` trên:
  - `GET /api/v1/products`
  - `GET /api/v1/orders`
  - `GET /api/v1/returns`
  - `GET /api/v1/categories`
  - `GET /api/v1/users`
  - `GET /api/v1/inventory/movements`

---

## 8. Tests Added

- Test kiểm tra `AuthSession` creation, Refresh Token Rotation, Replay Attack Detection và Thu hồi phiên.
- Test kiểm tra từ chối Token của người dùng bị khóa (`user.isActive = false`).
- Test kiểm tra từ chối Admin sử dụng `x-store-id` trên Shop APIs.
- Test kiểm tra từ chối Payload Return trùng lặp dòng có xung đột `isRestockable`.
- Test kiểm tra ẩn đệ quy `costPrice` trên đối tượng đơn lẻ `stockItem` và quan hệ lồng sâu.

---

## 9. Tests Actually Executed

Toàn bộ 7 test suites trong `tests/` đã được thực thi trực tiếp qua Jest:
```bash
npm test
```

---

## 10. Test Results

```text
PASS tests/auth.test.ts
PASS tests/analytics.test.ts
PASS tests/api-integration.test.ts
PASS tests/returns-flow.test.ts
PASS tests/inventory.test.ts
PASS tests/order-flow.test.ts
PASS tests/sensitive-fields.test.ts

Test Suites: 7 passed, 7 total
Tests:       23 passed, 23 total
Snapshots:   0 total
Time:        2.88 s
```
- **TypeScript Build (`npm run build`):** `0 errors` (Hoàn thành trong 2.1s).
- **Prisma Validate (`npx prisma validate`):** Hợp lệ 100%.

---

## 11. CI Status

- GitHub Actions Workflow (`.github/workflows/backend-ci.yml`) đã được thiết lập với:
  - Môi trường: **Node.js 24 LTS**
  - Database Service: **MySQL 8.4**
  - Các bước tự động: `npm ci` ➔ `prisma validate` ➔ `prisma generate` ➔ `prisma migrate deploy` ➔ `npm run build` ➔ `npm test`.

---

## 12. Remaining Risks

- Cần thiết lập cấu hình biến môi trường thật (`DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGIN`) trên máy chủ production trước khi triển khai (hệ thống sẽ từ chối khởi động nếu thiếu các biến này ở chế độ `production`).

---

## 13. Remaining TODO (Roadmap Sprint 3 & Sprint 4)

- Xây dựng Module **Decision Engine** (Tính toán Reorder Point, Safety Stock, Dead Stock `> 90 ngày`).
- Xây dựng Module **Smart Alerts & Notifications** (Cảnh báo tồn kho thấp, hết hàng qua WebSocket / SSE).
- Tích hợp **AI Decision Assistant** (Giao thức Read-Only Context Injection với OpenAI Responses API).
- Xây dựng Module **CSV / Excel Batch Import** (Luồng Dry-run Preview và Batch Execution).

---

## 14. Commands To Run Locally

```bash
# 1. Cài đặt dependencies
npm install

# 2. Sinh Prisma Client
npx prisma generate

# 3. Chạy migration
npx prisma migrate deploy

# 4. Kiểm tra build TypeScript
npm run build

# 5. Chạy bộ kiểm thử tự động
npm test

# 6. Khởi chạy server phát triển
npm run dev
```

---

## 15. Deployment Checklist

- [x] TypeScript build pass 100% không cảnh báo
- [x] Prisma schema validate pass
- [x] Baseline migration SQL versioned đầy đủ
- [x] Toàn bộ test suites pass
- [x] Bảo mật Session & Token Rotation hoạt động
- [x] Cơ chế trừ tồn kho nguyên tử & kiểm soát trả hàng hoạt động
- [x] Helmet & Rate Limiting được kích hoạt
- [x] CI Pipeline cập nhật Node.js 24 LTS
- [x] Không commit các file nháp tạm thời lên Git repository
