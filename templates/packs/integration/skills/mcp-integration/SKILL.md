---
name: mcp-integration
description: "Thiết kế, xây dựng, test và nối server cùng client Model Context Protocol: tên tool, schema, description và lỗi, transport stdio hay streamable HTTP, auth cho server từ xa, và cấu hình ALP. Dùng khi tạo hoặc sửa một MCP server, hoặc khi nối một server vào một agent. Không dùng cho thiết kế REST API nói chung (việc backend) hay việc chọn skill."
---

# MCP server và client

## Khi nào dùng

- Thiết kế hoặc đổi các tool, resource hay prompt mà một MCP server phơi ra.
- Hiện thực một server hay client bằng MCP SDK chính thức của ngôn ngữ dự án.
- Chọn transport (stdio hay streamable HTTP) hoặc thêm auth cho một server từ xa.
- Test một server bằng tay hoặc bằng test tự động.
- Làm cho một server đang có khả dụng với các agent ALP.

## Không dùng cho

- Thiết kế một API HTTP hay RPC thuần, không có lớp MCP.
- Dùng tool của một MCP server đã cấu hình sẵn trong công việc thường ngày.
- Deploy một server từ xa hay cấp phát hosting cho nó: việc đó cần được cho phép tường minh
  (xem devops).

## Điều kiện tiên quyết

- Đọc ALP.md cùng các manifest, lockfile và code MCP hiện có của dự án. Dùng MCP SDK chính thức
  của ngôn ngữ dự án ở đúng version đã pin; đọc tài liệu của version đó trước khi dựa vào một
  API, vì bề mặt SDK thay đổi giữa các bản phát hành.
- Biết ai gọi server (những agent nào, local hay từ xa) và nó được chạm vào những gì
  (file, mạng, tài khoản). Các quyết định còn thiếu thì chuyển lên.

## Quy trình

1. Định nghĩa công việc: những task của người dùng mà server mở ra, các hệ thống nó vươn tới,
   và mỗi thao tác là đọc, ghi hay xóa. Ưu tiên ít tool mang hình dạng task hơn là ảnh phản
   chiếu mọi endpoint.
2. Thiết kế tool: tên, description, input schema, output, annotation và hành vi lỗi. Hãy soát
   cả bộ như một model sẽ thấy nó: chỉ từ tên và description, nó chọn được đúng tool không?
3. Chọn transport. stdio cho một process local được khởi chạy theo từng client; streamable HTTP
   cho một service dùng chung hoặc từ xa. Server từ xa cần auth và kiểm tra origin.
4. Hiện thực bằng SDK: khởi tạo, khai báo capability, handler có validate input, timeout, phân
   trang cho danh sách lớn, log ra stderr (đừng bao giờ ra stdout khi dùng stdio).
5. Test: kiểm tra protocol bằng tay, test tự động gọi từng tool qua một client, các ca lỗi
   và ca biên, rồi `alp mcp test <name>` sau khi đã cấu hình.
6. Nối vào ALP (bên dưới), khai tên nó trong các agent cần nó, và xác nhận agent thấy được các
   tool.
7. Handoff: tool đã thêm hay đổi, schema, transport, mục config, lệnh test và kết quả,
   và mọi secret mà owner phải cung cấp.

## Nối một server vào ALP

- Một server một file: `mcp/<name>.json` trong library của người dùng (`~/.alp`) hoặc
  `.alp/mcp/` của dự án. Dạng của nó là một mục `.mcp.json`:
  `{ "command", "args", "env", "cwd" }` cho stdio, hoặc `{ "url", "headers" }` cho HTTP.
  Một `cwd` tương đối thì tương đối với thư mục của file.
- Tạo nó bằng `alp mcp add <name> --command C --arg A [--env K=V] [--cwd D]` hoặc
  `alp mcp add <name> --url U [--header K=V]`; thêm `--project` cho lớp dự án.
- Một agent dùng nó bằng cách khai tên nó trong `agent.json`: `"mcp": ["<name>"]`. Một agent
  library chỉ khai được server của library; một agent dự án khai được cả server dự án và server
  library. Một tên cũng có mặt trong `.mcp.json` của chính agent là một lỗi.
- `alp mcp test <name>` khởi động server, liệt kê các tool của nó rồi dừng nó.
  `alp mcp show <name>` cho thấy mục nào đang áp dụng và nó đến từ đâu.

## Ràng buộc

- Theo stack, SDK và quy ước hiện có của dự án trước đã. Không thêm dependency,
  service hay tài nguyên cloud mà không có quyết định của owner. Không tự cài.
- Đừng bao giờ đặt secret vào file được commit, kể cả `.alp/mcp/*.json` trong một repository.
  Giá trị trong `env` và `headers` được dùng đúng như viết, nên hãy giữ các mục chứa secret
  trong library của người dùng, hoặc để server đọc một credential mà owner cung cấp ngoài
  repository. Đừng đọc hay in các secret đang có.
- Đừng bao giờ deploy, đổi hạ tầng, hay chạm vào hệ thống hoặc credential production mà không
  được cho phép tường minh.
- Tool nào ghi, xóa hay tiêu tiền thì phải nói rõ điều đó trong description và annotation của
  nó, và nên hỗ trợ một bước dry run hoặc xác nhận ở nơi SDK và client cho phép.
- Agent chỉ đọc thì thiết kế và review; chúng không sửa code hay config ALP.

## Kiểm chứng

- Mọi tool đều có tên rõ ràng, một description nói khi nào dùng nó, một input schema nghiêm
  ngặt và các lỗi đã ghi tài liệu; tool phá hủy được đánh dấu.
- Test tự động gọi từng tool qua một SDK client và phủ thành công, input không hợp lệ và một
  thất bại ở phía dưới.
- Một server stdio không in gì ngoài message protocol lên stdout.
- `alp mcp test <name>` liệt kê đúng các tool mong đợi.

## Xử lý khi thất bại

- `alp mcp test` không khởi động được: chạy trực tiếp lệnh đã cấu hình, kiểm tra `cwd`, đường
  dẫn interpreter và việc làm bẩn stdout; báo lỗi chính xác.
- Tool thiếu hoặc bị đổi tên: so danh sách tool của server với config của agent và
  kiểm tra xem có tên server trùng nhau giữa các lớp không.
- Không có auth: dừng ở một test local không cần auth mà chạy được và báo credential mà
  owner phải cung cấp; đừng bao giờ dán token vào chat hay file.
- API của SDK khác với ví dụ: tin tài liệu và source của version đã cài; ghi lại version đó.

## Tài liệu tham khảo

- [references/tool-design.md](references/tool-design.md) — đọc khi đặt tên tool, viết description và schema, hay định nghĩa lỗi ở bước 2.
- [references/server-implementation.md](references/server-implementation.md) — đọc khi chọn transport, thêm auth, hay hiện thực lifecycle, logging, timeout và phân trang ở bước 3-4.
- [references/testing.md](references/testing.md) — đọc khi test một server bằng tay hoặc tự động ở bước 5.
