# Ghi nhận các Quyết định Nghiệp vụ Giả định (D1 – D9)

Tài liệu này lưu trữ các quyết định D1–D9 được đề xuất trong `STOCKPILOT_BACKEND_FLOWS.md` nhưng chưa có biên bản phê duyệt chính thức từ nhóm. Toàn bộ các quyết định dưới đây đóng vai trò là **giả định kỹ thuật có thể hiệu chỉnh** khi nhóm đưa ra yêu cầu mới.

---

## Danh mục chi tiết các quyết định

| Mã | Vấn đề nghiệp vụ | Lựa chọn triển khai hiện tại (Giả định kỹ thuật) | Lý do kỹ thuật / Tác động | Trạng thái |
|---|---|---|---|---|
| **D1** | Khởi tạo tài khoản và phân quyền | Đăng ký tài khoản tự động tạo vai trò `SHOP_OWNER`, 1 cửa hàng (`Store`) và 1 kho mặc định (`Warehouse`) trong cùng 1 Transaction duy nhất. Không cho client tự truyền `role` hoặc `store_id` từ request body. Nhân viên (`WAREHOUSE_STAFF`) được tạo/mời trực tiếp bởi Shop Owner. | Bảo đảm tính nguyên tử và cô lập dữ liệu ngay từ bước khởi tạo, chống leo thang đặc quyền (Privilege Escalation). | [D] Đang áp dụng |
| **D2** | Ràng buộc duy nhất của SKU/Sản phẩm | SKU là duy nhất trong phạm vi từng cửa hàng (`store_id, sku`). Mã danh mục và mã sản phẩm cũng duy nhất theo `store_id`. | Cho phép các cửa hàng khác nhau có thể trùng mã SKU của nhà sản xuất mà không xung đột trên CSDL dùng chung. | [D] Đang áp dụng |
| **D3** | Định nghĩa đơn vị giữ tồn (Stock Item) | Mỗi biến thể hoặc SKU bán được là một đơn vị giữ tồn (`StockItem`). Sản phẩm đơn giản được xem là sản phẩm có 1 biến thể SKU mặc định. | Cấu trúc linh hoạt, hỗ trợ cả sản phẩm đơn và sản phẩm có nhiều thuộc tính (size, màu sắc) trong tương lai. | [D] Đang áp dụng |
| **D4** | Kiểm soát số lượng tồn kho | Số lượng tồn (`quantity`) được quản lý tách biệt trong `InventoryBalance` (theo `warehouse_id, stockItemId`) và bắt buộc sinh `StockMovement` tương ứng. Nghiêm cấm sửa trực tiếp số lượng qua API CRUD sản phẩm. | Bảo đảm tính kiểm toán (Auditability), chống mất dấu vết điều chỉnh kho. | [D] Đang áp dụng |
| **D5** | Thời điểm trừ tồn kho trong đơn hàng | Tồn kho được trừ tại thời điểm đơn hàng chuyển từ `DRAFT` sang `CONFIRMED`. Đơn `DRAFT` không giữ chỗ (soft-reserve) trong MVP để tránh giữ ảo tồn kho khi khách bỏ giỏ hàng. | Đơn giản hóa bài toán timeout giỏ hàng trong MVP; kiểm tra tồn kho tức thời khi xác nhận với khóa hàng atomic. | [D] Đang áp dụng |
| **D6** | Bất biến khi hủy đơn hàng | Chỉ cho phép hủy đơn ở trạng thái `DRAFT` hoặc `CONFIRMED`. Đơn `CONFIRMED` khi hủy sẽ hoàn trả tồn kho (`ORDER_CANCEL_RESTOCK`) trong cùng transaction. Tuyệt đối không hủy đơn đã `FULFILLED` (phải qua luồng Return). | Giữ tính toàn vẹn của doanh thu và chứng từ kế toán kho. | [D] Đang áp dụng |
| **D7** | Snapshot giá và tính toán tổng tiền | Khi tạo dòng đơn hàng (`OrderItem`), backend chụp lại snapshot `unitPriceSnapshot` và `costPriceSnapshot`. Backend tự tính toán tổng tiền dựa trên giá snapshot, không tin cậy `totalAmount` do frontend gửi. | Ngăn chặn gian lận giá từ phía client (Price Tampering). | [D] Đang áp dụng |
| **D8** | Chính sách trả hàng & hoàn tiền | Cho phép trả hàng một phần trên đơn `FULFILLED`. Chỉ ghi nhận số tiền hoàn được ghi sổ (`totalRefundAmount`), không tích hợp cổng thanh toán trực tuyến. Hàng hỏng (`isRestockable = false`) không tự động nhập lại kho. | Phản ánh đúng thực tế vận hành cửa hàng bán lẻ và bảo đảm an toàn kho. | [D] Đang áp dụng |
| **D9** | Phân quyền đề xuất & áp dụng giá | Chỉ có `SHOP_OWNER` mới có quyền xem biên lợi nhuận, xem giá vốn và duyệt áp dụng giá bán đề xuất. `WAREHOUSE_STAFF` bị ẩn toàn bộ thông tin giá vốn. `ADMIN` chỉ giám sát hệ thống, không tự ý can thiệp giá của cửa hàng. | Tuân thủ nghiêm ngặt nguyên tắc Broken Object Property Level Authorization (OWASP API3:2023). | [D] Đang áp dụng |

---

## Hướng dẫn cập nhật

Khi có phản hồi hoặc thống nhất mới từ nhóm đồ án:
1. Cập nhật bảng trên với nội dung quyết định chính thức và đổi trạng thái sang `[Approved]`.
2. Kiểm tra lại các file logic tương ứng trong `backend/src/modules/` để điều chỉnh code đồng bộ.
