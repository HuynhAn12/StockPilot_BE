# StockPilot Backend - Nền tảng Quản lý Kho, Đơn hàng & Tối ưu hóa Giá

Dự án Backend cho hệ thống **StockPilot**, được phát triển theo kiến trúc **Modular Monolith** sử dụng **Node.js 24 LTS, Express, TypeScript, MySQL 8.4 và Prisma ORM**.

---

## 1. Yêu cầu Môi trường

- **Node.js:** `>= 20.x` (Khuyến nghị Node.js 24 LTS)
- **NPM:** `>= 10.x`
- **Database:** MySQL 8.0+ / 8.4 LTS
- **TypeScript:** 5.7+

---

## 2. Cấu trúc Thư mục

```text
backend/
├── docs/
│   ├── database.md       # Thiết kế CSDL, quan hệ, chỉ mục & khóa
│   ├── api.md            # Đặc tả API endpoints, định dạng request/response, mã lỗi
│   ├── decisions.md      # Bảng ghi nhận 9 giả định nghiệp vụ D1–D9
│   ├── progress-report.md # Báo cáo tiến độ chi tiết từng giai đoạn & Sprint
│   └── next-steps.md     # Data contracts & Lộ trình Decision Engine, AI, CSV
├── prisma/
│   └── schema.prisma     # Prisma schema chuẩn hóa cho MySQL InnoDB
├── src/
│   ├── config/           # Cấu hình env (Zod validation), kết nối Prisma DB client
│   ├── common/           # Lớp lỗi chuẩn hóa (AppError), middleware (auth, rbac, masking), utils
│   ├── modules/
│   │   ├── auth/         # Đăng ký Shop Owner + tạo Store/Kho nguyên tử, Đăng nhập, JWT
│   │   ├── users/        # Quản lý nhân viên WAREHOUSE_STAFF theo store
│   │   ├── categories/   # CRUD danh mục theo store
│   │   ├── products/     # Quản lý sản phẩm, biến thể SKU, giá bán/giá vốn
│   │   ├── inventory/    # Nhập kho, xuất kho, kiểm kê, balance & movement audit
│   │   ├── orders/       # Đơn hàng: DRAFT -> CONFIRMED (trừ tồn) -> FULFILLED -> CANCELED
│   │   ├── returns/      # Trả hàng đơn FULFILLED, hoàn tiền ghi sổ, hoàn kho có điều kiện
│   │   └── analytics/    # Dashboard doanh thu gộp, hoàn tiền, doanh thu ròng, định giá kho
│   ├── app.ts            # Khởi tạo Express app & gắn middleware tập trung
│   └── server.ts         # Server listener
├── tests/                # Bộ kiểm thử tự động toàn diện (Jest + Supertest)
├── .env.example          # Mẫu cấu hình môi trường
├── package.json
└── tsconfig.json
```

---

## 3. Hướng dẫn Cài đặt & Chạy ứng dụng

### 3.1. Cài đặt Dependencies
```bash
cd backend
npm install
```

### 3.2. Cấu hình Môi trường
Tạo file `.env` từ `.env.example`:
```bash
cp .env.example .env
```
Điều chỉnh thông số kết nối MySQL (`DATABASE_URL`) và các khóa bí mật JWT.

### 3.3. Sinh Prisma Client & Đồng bộ CSDL
```bash
# Sinh mã Prisma Client
npm run prisma:generate

# Đẩy schema lên CSDL MySQL
npm run prisma:push

# Hoặc chạy Migration
npm run prisma:migrate
```

### 3.4. Chạy ở Môi trường Phát triển (Development)
```bash
npm run dev
```
Hệ thống sẽ chạy tại địa chỉ: `http://localhost:5000/api/v1`

### 3.5. Kiểm tra Build TypeScript
```bash
npm run build
```

---

## 4. Chạy Bộ Kiểm thử (Testing)

Hệ thống được tích hợp bộ test tự động kiểm tra toàn bộ các bất biến quan trọng:
- Đăng ký tài khoản Shop Owner kèm Store & Kho mặc định trong 1 transaction.
- Phân quyền RBAC & cô lập dữ liệu theo Store (Store Scope Isolation).
- Cơ chế Masking dữ liệu nhạy cảm (Ẩn `costPrice` đối với `WAREHOUSE_STAFF`).
- Trừ tồn kho nguyên tử khi xác nhận đơn và chống bán vượt tồn (Race condition protection).
- Hoàn kho khi hủy đơn `CONFIRMED`, chặn hủy đơn `FULFILLED`.
- Trả hàng một phần, chặn trả vượt số lượng đã mua, xử lý hàng hỏng không nhập kho.
- Kiểm tra tính toán số liệu Dashboard.

Chạy test bằng lệnh:
```bash
npm test
```

Xem độ phủ kiểm thử:
```bash
npm run test:coverage
```

---

## 5. Danh mục Mã Lỗi Chuẩn Hóa

| HTTP Status | Error Code | Ý nghĩa |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Dữ liệu đầu vào sai định dạng hoặc không hợp lệ |
| 401 | `UNAUTHENTICATED` | Thiếu token, token sai hoặc đã hết hạn |
| 403 | `FORBIDDEN` | Tài khoản không đủ quyền hoặc truy cập ngoài phạm vi store |
| 404 | `NOT_FOUND` | Không tìm thấy tài nguyên trong cửa hàng |
| 409 | `CONFLICT` | Xung đột dữ liệu hoặc trạng thái nghiệp vụ không hợp lệ |
| 409 | `INSUFFICIENT_STOCK`| Tồn kho không đủ để xuất bán hoặc xác nhận đơn |
| 500 | `INTERNAL_ERROR` | Lỗi máy chủ nội bộ (kèm Request ID để tra cứu log) |
