# Hướng Dẫn & Tiêu Chuẩn Bảo Mật StockPilot Backend (Security Policy)

---

## 1. Xác Thực & Quản Lý Phiên (Session Management & Tokens)

1. **Access Token:**
   - Định dạng: JSON Web Token (JWT) có thời hạn ngắn (15 phút - 1 ngày).
   - Nội dung payload: `{ userId, email, role, storeId }`.
   - Thu hồi/Khóa tức thời: `authMiddleware` truy vấn CSDL để xác thực trạng thái `user.isActive = true` và `store.isActive = true` cho mọi request được xác thực.
2. **Refresh Token & AuthSession:**
   - Refresh token được lưu trữ dưới dạng mã băm **SHA-256** (`refreshTokenHash`) trong bảng `auth_sessions`.
   - **Xoay vòng token (Token Rotation):** Mỗi khi gọi `POST /api/v1/auth/refresh`, phiên cũ sẽ bị đánh dấu thu hồi (`revokedAt = new Date()`) và cấp một phiên mới kèm refresh token mới.
   - **Phát hiện tái sử dụng (Replay Attack Detection):** Nếu một refresh token đã bị thu hồi được gửi lại, hệ thống lập tức thu hồi toàn bộ các phiên hoạt động còn lại của người dùng đó.
   - **Đăng xuất (Logout):** Endpoint `POST /api/v1/auth/logout` đánh dấu `revokedAt` cho phiên tương ứng.

---

## 2. Phân Quyền & Cô Lập Dữ Liệu Cửa Hàng (Store Scope Isolation)

1. **Store Scoping:**
   - Mọi truy vấn đọc/ghi tài nguyên của cửa hàng đều bắt buộc ràng buộc điều kiện `where: { storeId }`.
2. **Chặn Giả Quyền Admin:**
   - Tài khoản `ADMIN` bị chặn hoàn toàn trên các API cửa hàng (`requireStoreScope` trả về `403 FORBIDDEN` nếu cố ý truyền `x-store-id` hoặc `?storeId=`). Admin phải sử dụng các API quản trị hệ thống riêng biệt (`/api/v1/admin/*`).
3. **Ẩn Dữ Liệu Nhạy Cảm (Data Masking - OWASP API3):**
   - Middleware `sensitiveFieldsMiddleware` thực hiện duyệt đệ quy sâu (Deep Traversal) trên toàn bộ dữ liệu trả về và loại bỏ `costPrice`, `costPriceSnapshot`, `profitMargin` đối với vai trò `WAREHOUSE_STAFF`.

---

## 3. Bảo Vệ Tầng Mạng & Ứng Dụng (Network & Middleware Protections)

1. **HTTP Security Headers (`helmet`):**
   - Tự động thiết lập các HTTP headers bảo mật (X-DNS-Prefetch-Control, X-Frame-Options, Strict-Transport-Security, X-Download-Options, X-Content-Type-Options, X-XSS-Protection).
2. **Giới Hạn Tần Suất Yêu Cầu (`express-rate-limit`):**
   - **Auth Endpoints:** Giới hạn tối đa 10 requests / phút đối với `POST /api/v1/auth/login` và `POST /api/v1/auth/refresh` để chống brute-force mật khẩu.
   - **General API:** Giới hạn tối đa 300 requests / 15 phút cho toàn bộ các API `/api/`.
3. **Giới Hạn Kích Thước Body:**
   - Cắt giảm payload JSON parser xuống tối đa `1mb` để ngăn chặn tấn công từ chối dịch vụ (DoS).
4. **CORS Policy:**
   - Môi trường `production` bắt buộc khai báo `CORS_ORIGIN` cụ thể (không chấp nhận wildcard `*`).
