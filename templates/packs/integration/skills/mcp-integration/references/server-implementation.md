# Hiện thực MCP server

Đọc khi chọn transport, thêm auth cho một server từ xa, hoặc khi hiện thực lifecycle,
logging, timeout và phân trang.

## Dùng SDK chính thức

- Dùng MCP SDK chính thức của ngôn ngữ dự án ở đúng version đã pin. Hãy kiểm tra tài liệu và
  changelog của version đó: lớp transport, helper đăng ký và kiểu kết quả khác nhau
  giữa các bản phát hành và các bản sửa đổi protocol.
- Thêm SDK, nâng version nó, hay thêm một web framework cho HTTP là một quyết định về
  dependency của owner. Đừng tự cài gì cả.
- Để SDK lo việc đóng khung JSON-RPC, khởi tạo và thương lượng version protocol. Đừng
  tự viết protocol bằng tay.

## Transport

| | stdio | Streamable HTTP |
|---|---|---|
| Process | Client khởi chạy server làm process con | Service chạy lâu, nhiều client |
| Phù hợp | Tool local, truy cập file hay CLI local theo từng người dùng | Service dùng chung hay từ xa, tích hợp được host |
| Message | JSON-RPC phân cách bằng dòng mới trên stdin/stdout | JSON-RPC qua HTTP POST tới một endpoint; response là JSON hoặc một stream SSE |
| Auth | Thừa hưởng môi trường của người dùng | Bắt buộc với mọi thứ không phải local |
| Config ALP | `{ "command", "args", "env", "cwd" }` | `{ "url", "headers" }` |

- Transport HTTP+SSE cũ đã deprecated; chỉ hỗ trợ nó nếu một client đang có cần nó.
- stdio: stdout chỉ chở message protocol. Mọi lần print lạc, banner, progress bar hay cảnh báo
  của library trên stdout đều làm hỏng stream. Hãy gửi log ra stderr.
- Streamable HTTP: validate header `Origin` để chặn DNS rebinding, bind server chỉ dùng local
  vào `127.0.0.1` thay vì mọi interface, và xử lý session ID như SDK ghi trong tài liệu.
  Giữ đường dẫn endpoint ổn định; client lưu lại URL.

## Lifecycle

1. Khởi tạo: client gửi version protocol và capability của nó; server đáp lại bằng version,
   capability (tool, resource, prompt, logging) và thông tin server (tên, version) của mình.
2. Notification initialized; hoạt động bình thường bắt đầu. Đừng gửi request trước đó.
3. Hoạt động: xử lý `tools/list`, `tools/call` và mọi capability khác đã khai báo. Chỉ phát
   notification `list_changed` nếu đã khai báo và bộ tool thật sự thay đổi.
4. Dừng: với stdio, thoát gọn khi stdin đóng; với HTTP, giải phóng trạng thái session.
   Flush log, đóng các kết nối lên upstream và các process con.

- Khởi động nhanh. Hoãn việc chậm (kết nối lên upstream, nạp index) tới lần dùng đầu để
  `tools/list` đáp nhanh; client và `alp mcp test` sẽ timeout khi khởi động chậm.
- Fail ngay khi khởi động kèm một message rõ ràng trên stderr nếu thiếu cấu hình bắt buộc.

## Cấu hình và secret

- Đọc cấu hình từ biến môi trường hoặc tham số; ghi tài liệu cho từng cái.
- Đừng bao giờ commit secret. ALP truyền giá trị `env` và `headers` đúng như viết, nên một
  `.alp/mcp/<name>.json` ở mức dự án không được chứa token. Hãy giữ các mục chứa secret trong
  library của người dùng, hoặc để owner cung cấp credential ngoài repository.
- Đừng bao giờ log secret hay toàn bộ body request có thể chứa chúng.

## Auth cho server từ xa

- Theo phần authorization của đặc tả MCP ứng với bản sửa đổi protocol đang dùng (dựa trên OAuth
  2.1, kèm metadata về protected resource). Dùng helper auth của SDK hay của framework thay vì
  tự parse token.
- Validate token ở mọi request: issuer, audience (token phải được phát cho server này),
  hạn dùng và scope. Từ chối token phát cho service khác.
- Đừng chuyển token của client sang các API upstream; hãy lấy credential upstream riêng.
- Map scope sang tool; kiểm tra authorization theo từng lời gọi tool, không chỉ lúc kết nối.
- Giới hạn tần suất theo từng client và trả một lỗi rõ ràng khi chạm giới hạn.
- Hosting, DNS, chứng chỉ và thiết lập identity provider là các thay đổi hạ tầng, cần
  được cho phép tường minh.

## Timeout, hủy và tiến độ

- Đặt cho mọi lời gọi upstream một timeout ngắn hơn timeout request của client, và trả về một
  lỗi tool có nêu tên timeout đó.
- Tôn trọng notification hủy: dừng việc và giải phóng tài nguyên.
- Với thao tác dài, báo tiến độ nếu client đã gửi một progress token, hoặc tách thành
  tool start và tool status.
- Giới hạn mức đồng thời để bảo vệ các service upstream.

## Phân trang và kích thước

- Các thao tác liệt kê (`tools/list`, `resources/list`, và các tool kiểu liệt kê) dùng cursor
  mờ: trả `nextCursor` khi còn kết quả; nhận `cursor` ở lời gọi tiếp theo.
- Cursor là chuỗi mờ; đừng để client phụ thuộc vào định dạng của chúng.
- Chặn kích thước kết quả. Blob lớn thuộc về resource hay file được tham chiếu bằng URI, không
  nằm trong text.

## Logging

- stderr cho server stdio; dòng có cấu trúc (level, thời gian, tool, thời lượng, loại lỗi).
- Có thể hiện thực thêm capability logging của protocol để client nhận được message log.
- Log tên tool, thời lượng và kết quả cho mỗi lời gọi; bỏ các giá trị tham số có thể nhạy cảm.

## Phía client

- Khi viết một client, hãy dùng cùng SDK: kết nối một transport, khởi tạo, liệt kê tool, gọi
  tool, xử lý kết quả `isError` tách riêng khỏi lỗi protocol, và đóng session.
- Chỉ cache danh sách tool cho tới khi có notification `list_changed` hoặc khi kết nối lại.
