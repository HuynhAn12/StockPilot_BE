# Kế hoạch & Hợp đồng Dữ liệu Triển khai Tiếp theo (Next Steps)

Tài liệu này xác định giao ước dữ liệu (Data Contracts) và thứ tự triển khai cho các tính năng nâng cao trong các Sprint tiếp theo (Sprint 3 & Sprint 4): Decision Engine, Alerts, AI Assistant và CSV/Excel Import.

---

## 1. Decision Engine (Rule-based Inventory & Pricing Optimization)

### 1.1. Công thức và Ngưỡng tính toán
- **Reorder Point (ROP):** `ROP = (Average Daily Demand * Lead Time Days) + Safety Stock`
- **Safety Stock (SS):** `SS = Z * Standard Deviation of Lead Time Demand`
- **Dead Stock Threshold:** Sản phẩm không phát sinh đơn hàng bán trong `> 90 ngày` và số lượng tồn `> 0`.
- **Đề xuất giảm giá (Markdown Recommendation):**
  - Dead Stock `> 90 ngày`: Đề xuất giảm 10% - 15%.
  - Dead Stock `> 180 ngày`: Đề xuất giảm 20% - 30%, đảm bảo `New Price >= Cost Price * (1 + Min Margin)`.

### 1.2. Hợp đồng Dữ liệu (Data Contract)
```typescript
interface DecisionEngineOutput {
  storeId: number;
  stockItemId: number;
  sku: string;
  calculatedAt: string;
  metrics: {
    averageDailySales30d: number;
    daysOfInventoryRemaining: number;
    isStockoutRisk: boolean;
    isDeadStock: boolean;
  };
  recommendations: {
    reorderQuantity?: number;
    suggestedSellingPrice?: number;
    currentSellingPrice: number;
    costPrice: number;
    minMarginFloor: number;
    rationale: string;
  }[];
}
```

---

## 2. Hệ thống Cảnh báo (Alerts & Notifications)

### 2.1. Phân loại Alert
- `LOW_STOCK`: Tồn kho `<= minStockLevel` hoặc `<= ROP`.
- `STOCKOUT`: Tồn kho `= 0`.
- `OVERSTOCK_DEADSTOCK`: Tồn kho quá ngưỡng `maxStockLevel` hoặc không bán được trong 90 ngày.

### 2.2. Phân biệt Alert và Notification
- **Alert:** Bản ghi nghiệp vụ độc lập được sinh ra bởi Job định kỳ hoặc Event thay đổi tồn kho.
- **Notification:** Bản ghi gửi đến từng user cụ thể theo vai trò (`SHOP_OWNER`, `WAREHOUSE_STAFF`). Việc user đánh dấu đã đọc hoặc xóa Notification **không làm xóa Alert gốc**.

---

## 3. AI Decision Assistant (LLM Integration)

### 3.1. Nguyên tắc An toàn & Phân quyền
1. **Chỉ đọc (Read-Only):** AI Assistant tuyệt đối không có công cụ (tools) ghi dữ liệu hoặc tự động thay đổi giá/tồn kho.
2. **Context Injection:** Backend truy xuất dữ liệu đã phân quyền của `store_id` (loại bỏ giá vốn nếu người hỏi là Staff), đóng gói cùng kết quả Decision Engine thành JSON Context trước khi gửi tới OpenAI Responses API.
3. **Phòng chống Prompt Injection:** Nội dung câu hỏi và tên sản phẩm được xử lý như un-trusted input; model được chỉ thị chỉ căn cứ trên dữ liệu context được cấp.

---

## 4. Import CSV / Excel & Dữ liệu Lịch sử

### 4.1. Quy trình 2 bước Idempotent
1. **Bước 1 - Upload & Xem trước (Dry-run Preview):** Parse file tạm, kiểm tra hợp lệ từng dòng, phát hiện SKU trùng hoặc sai định dạng. Không ghi vào CSDL.
2. **Bước 2 - Xác nhận & Thực thi (Batch Execution):** Thực hiện insert/update theo từng chunk (100 dòng/transaction), trả về bản tổng kết `{ successCount, failureCount, errors: [...] }`.
3. **Phòng chống Formula Injection:** Tự động prefix dấu `'` cho các ô bắt đầu bằng `=`, `+`, `-`, `@`.
