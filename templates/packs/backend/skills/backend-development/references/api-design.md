# Thiết kế API

Đọc khi thiết kế một resource hoặc endpoint mới, hoặc khi chọn status code,
phân trang, idempotency, versioning, hay validation cho request.

Kiểu API hiện có của dự án thắng. Nếu dự án dùng route kiểu RPC, GraphQL, hay gRPC,
hãy áp dụng tinh thần của các quy tắc dưới đây (resource rõ ràng, contract ổn định,
lỗi tường minh) theo kiểu đó thay vì chuyển nó sang REST.

## Resource và route

- Đặt tên resource là danh từ số nhiều: `/orders`, `/orders/{id}`, `/orders/{id}/items`.
- Chỉ lồng nhau khi thật sự là quan hệ sở hữu, nhiều nhất một hoặc hai cấp.
- Dùng method theo ý định: GET đọc (an toàn), PUT thay thế (idempotent), PATCH cập
  nhật một phần, POST tạo hoặc chạy một hành động, DELETE xóa (idempotent).
- Mô hình hóa một hành động không phải CRUD thành sub-resource hoặc một POST tới hành
  động có tên (`POST /orders/{id}/cancel`) khi dự án đã làm như vậy.
- Giữ cách đặt tên field nhất quán với các response hiện có (camelCase hay snake_case).
- Trả về biểu diễn đã tạo hoặc đã cập nhật, hoặc theo quy ước hiện có.
- Dùng ID mờ hoặc không tăng tuần tự trong URL khi việc dò tuần tự làm lộ thông tin.

## Status code

| Tình huống | Code |
| --- | --- |
| Đọc hoặc cập nhật thành công | 200 |
| Đã tạo | 201, kèm header Location nếu dự án dùng |
| Nhận để xử lý bất đồng bộ | 202, kèm cách poll trạng thái |
| Thành công, không có body | 204 |
| Input sai dạng hoặc không hợp lệ | 400 hoặc 422, theo quy ước của dự án |
| Chưa authenticate | 401 |
| Đã authenticate nhưng không được phép | 403, hoặc 404 để không tiết lộ sự tồn tại |
| Không tìm thấy | 404 |
| Xung đột trạng thái, trùng lặp, lệch version | 409 (hoặc 412 cho precondition) |
| Bị giới hạn tần suất | 429, kèm Retry-After khi biết |
| Server lỗi bất ngờ | 500 |
| Dependency không khả dụng hoặc timeout | 502, 503, hay 504 |

Không bao giờ trả 200 với body là lỗi. Không bao giờ trả 500 cho input client sai.

## Body của lỗi

Dùng một hình dạng lỗi duy nhất ở mọi nơi. Nếu dự án chưa có, chỉ cần một code ổn
định máy đọc được, một message cho người, và chi tiết field tùy chọn, ví dụ
`{ "error": { "code": "validation_failed", "message": "...", "fields": {...} } }`.
Một số dự án dùng problem details của RFC 9457; hãy theo cái đang có.

## Phân trang

- Phân trang theo cursor (keyset) cho tập dữ liệu lớn hoặc hay thay đổi: trả về một
  cursor `next` mờ, dẫn xuất từ khóa sắp xếp cộng một khóa phá thế bằng duy nhất.
- Phân trang theo offset chỉ dùng cho tập nhỏ, ổn định, hoặc khi client cần số trang;
  nó chậm dần và bỏ sót hoặc lặp dòng khi có ghi đồng thời.
- Luôn chặn kích thước trang ở phía server và áp một giá trị mặc định.
- Làm thứ tự sắp xếp tường minh và tất định.
- Chỉ trả tổng số khi nó rẻ hoặc bắt buộc; việc đếm có thể đắt.

## Lọc và sắp xếp

- Lập whitelist các field được lọc và được sắp xếp; đừng bao giờ truyền input thô vào truy vấn.
- Từ chối các tham số lọc hay sắp xếp không nhận biết được, hoặc bỏ qua chúng, theo quy ước dự
  án.

## Idempotency

- PUT và DELETE phải idempotent theo thiết kế.
- Với POST tạo mới hoặc thu phí, hãy nhận một header idempotency key khi client có
  thể retry. Lưu key cùng dấu vết của request và response; phát lại response đã lưu
  khi gặp lại; từ chối một key dùng lại với body khác (409 hoặc 422).
- Cho key đã lưu một thời hạn. Giới hạn phạm vi theo từng client hoặc user.
- Handler của webhook và job dedupe theo ID của event hoặc message.

## Đồng thời

- Với các cập nhật có thể đua nhau, dùng optimistic concurrency: một ETag hoặc field
  version, kèm If-Match hoặc version trong body, và 409 hoặc 412 khi lệch.

## Versioning

- Ưu tiên thay đổi chỉ thêm vào, tương thích ngược: field tùy chọn mới, endpoint mới.
- Thay đổi phá vỡ (bỏ hoặc đổi tên field, đổi kiểu hay ý nghĩa, siết validation) cần
  quyết định của owner và một đường migration.
- Theo lược đồ versioning của dự án (tiền tố path, header, hay không có). Đừng đưa vào
  một lược đồ mới mà không có quyết định.
- Client nên bỏ qua field không biết; đừng dựa vào thứ tự field.

## Validate request

- Validate ở biên: kiểu, field bắt buộc, khoảng giá trị, độ dài, định dạng, thuộc tập
  enum, và kích thước body tối đa.
- Dùng validator hoặc library schema hiện có của dự án; đừng thêm cái khác.
- Parse thành một giá trị có kiểu hoặc đã chuẩn hóa, rồi chỉ truyền giá trị đó vào trong.
- Từ chối field không biết khi mass assignment là rủi ro (ví dụ client tự đặt `role`
  hay `ownerId`); đừng bao giờ bind body của request thẳng vào model lưu trữ.
- Trả về tất cả lỗi field một lượt khi khả thi.
- Validation không phải authorization; kiểm tra quyền riêng.
