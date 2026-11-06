# Test một MCP server

Đọc khi kiểm tra một server bằng tay, viết test tự động cho các tool của nó, hoặc xác nhận nó
chạy được bên trong ALP.

## Thứ tự

1. Unit test cho logic nằm sau từng tool, không qua protocol.
2. Test protocol: một SDK client kết nối tới server qua transport in-memory hoặc stdio.
3. Soi bằng tay danh sách tool và vài lời gọi.
4. Kiểm tra trong ALP bằng `alp mcp test <name>` và một lần chạy agent có dùng một tool.

Chạy lệnh test hiện có của dự án; thêm test trong framework và cách bố trí của nó.

## Kiểm tra bằng tay (kiểu inspector)

Chỉ dùng một MCP inspector tương tác nếu dự án hay owner đã có sẵn một cái;
lấy một cái qua package runner là tải code về và cần owner phê duyệt. Nếu không,
một script SDK client ngắn trong scratch space cũng làm được đúng việc đó.

Hãy kiểm tra:

- Khởi tạo thành công; tên server, version và các capability đã khai báo là đúng.
- `tools/list` trả về mọi tool mong đợi kèm description, input schema và annotation.
- Mỗi tool: một lời gọi hợp lệ, một lời gọi thiếu field bắt buộc, một lời gọi sai kiểu,
  một lời gọi làm phát sinh thất bại ở phía dưới (không tìm thấy, bị từ chối quyền).
- Kết quả lỗi là lỗi tool với message hành động được, không phải crash hay lỗi protocol.
- Danh sách lớn có phân trang: `nextCursor` xuất hiện, trang sau khác trang trước, trang cuối
  không có nó.
- stdio: chạy trực tiếp lệnh của server và xác nhận không có gì ngoài JSON-RPC trên stdout
  (banner khởi động và cảnh báo phải ra stderr).
- HTTP: request không có auth hợp lệ bị từ chối; `Origin` sai bị từ chối; server
  không lắng nghe trên mọi interface khi nó được định chỉ dùng local.

## Test tự động

- Khởi động server in-process bằng transport in-memory của SDK khi có, hoặc spawn
  lệnh stdio; kết nối một SDK client; gọi các tool qua client đó.
- Assert theo cấu trúc, không theo câu chữ chính xác: tên tool, field bắt buộc trong schema,
  field kết quả, cờ `isError` và loại lỗi.
- Snapshot danh sách tool (tên, tham số bắt buộc, annotation) để việc đổi tên hay đổi schema
  vô tình làm fail một test. Hãy cập nhật snapshot một cách có chủ đích.
- Thay các service upstream bằng fake ở biên HTTP hoặc biên client; đừng gọi API production
  hay dùng credential thật trong test.
- Phủ cả timeout và hủy bằng một upstream giả có trễ.
- Với tool phá hủy, hãy test đường dry-run và test rằng đường thật đòi đúng input mong đợi.
- Dọn các process con và file tạm trong teardown; một process server bị rò làm CI treo.

Khung test tối thiểu:

```text
setup:    start server (in-memory or spawn), create client, initialize
test:     tools/list contains expected names and required params
test:     call get_item {id: known}   -> result with id, no isError
test:     call get_item {id: missing} -> isError, message mentions not found
test:     call get_item {}            -> invalid input error
test:     list_items paginates with cursor
teardown: close client, stop server
```

## Kiểm tra bên trong ALP

- Cấu hình server: `alp mcp add <name> --command C --arg A` (stdio) hoặc
  `alp mcp add <name> --url U --header K=V` (HTTP); thêm `--project` cho lớp dự án.
- `alp mcp test <name>` khởi động server, in tên, version và danh sách tool của nó, rồi dừng
  nó. Fail ở đây thường nghĩa là sai lệnh hay sai `cwd`, thiếu biến môi trường, làm bẩn stdout,
  hoặc khởi động chậm.
- `alp mcp show <name>` xác nhận mục của lớp nào đang áp dụng.
- Khai tên server trong `agent.json` của agent (`"mcp": ["<name>"]`) và chạy một task ngắn có
  dùng một tool chỉ đọc; xác nhận lời gọi và kết quả trong log của session.
- Đừng bao giờ đặt token thật vào một config được commit để làm một test pass; hãy báo
  credential còn thiếu.

## Cần báo lại những gì

Các lệnh đã chạy và output của chúng (lệnh test, `alp mcp test`), các tool đã kiểm chứng, các
ca chưa phủ và lý do (ví dụ: không có credential cho API từ xa), và mọi thay đổi schema ảnh
hưởng tới các agent đang có.
