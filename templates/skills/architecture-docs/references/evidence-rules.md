# Quy tắc về bằng chứng

Đọc khi trích xuất dữ kiện kiến trúc từ một repository và khi dẫn nguồn hoặc đánh dấu chúng.

## Dữ kiện đến từ đâu
| Dữ kiện | Bằng chứng chính |
|---|---|
| Ngôn ngữ, runtime, package | Manifest và lockfile (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`) |
| Đơn vị runtime và cách khởi động | Entry point (`bin`, `main`, `scripts`), Dockerfile, config process hoặc service |
| Ranh giới module | Config workspace, export của package, file khai báo sở hữu thư mục, quy tắc lint về import |
| Phụ thuộc giữa các module | Câu lệnh import và đồ thị build; ưu tiên output của công cụ dựng đồ thị đang có |
| Bề mặt HTTP hoặc RPC | File đăng ký route, file OpenAPI hoặc proto, test của handler |
| Hình dạng dữ liệu | Schema, migration, định nghĩa type, validator |
| Hệ thống bên ngoài | Cấu hình client, các chỗ đọc biến môi trường, manifest triển khai |
| Quy ước | Mẫu lặp lại ở ba chỗ trở lên, config lint và format |
| Quyết định | ADR đang có, commit message phát biểu một lựa chọn, xác nhận từ người dùng |

Test là bằng chứng về hành vi mong muốn; config là bằng chứng về cái đang được triển khai chỉ
khi đường deploy thực sự đọc nó.

## Các bước trích xuất
1. Bắt đầu từ entry point rồi lần theo import ra ngoài; đừng bắt đầu từ tên thư mục.
2. Đếm trước khi khái quát: một lần xuất hiện là một ví dụ, không phải một quy ước.
3. Dùng câu lệnh chỉ đọc (tìm, liệt kê, công cụ dựng đồ thị hay build của chính project); đừng
   cài thêm bộ phân tích.
4. Ghi lại câu lệnh và kết quả cho mọi dữ kiện không hiển nhiên.

## Cách dẫn nguồn
- Trong dòng: `The daemon owns session state (packages/daemon/src/sessions.js).`
- Kèm symbol: `(packages/core/src/tasks.js, createTask)`.
- Kèm số dòng chỉ khi chúng ổn định: `(src/router.ts:40-62)`.
- Nhiều nguồn: liệt kê nguồn trực tiếp nhất trước.
- Đường dẫn tương đối từ root của repository; không dùng đường dẫn tuyệt đối hay gắn với một
  máy.

## Đánh dấu điều chưa biết
- Trong dòng: `Unverified: the worker appears to retry three times (src/worker.js:88); no test covers it.`
- Cuối mục: danh sách `Open questions`, mỗi mục kèm người có thể trả lời và bằng chứng nào sẽ
  giải quyết nó.
- Không bao giờ nâng một phát biểu chưa kiểm chứng lên thành dữ kiện mà không có bằng chứng
  mới.

## Dấu hiệu đáng ngại
- Một phát biểu không có đường dẫn, hoặc một đường dẫn không còn tồn tại.
- Những chữ như "should", "will", "designed to" dùng để mô tả hành vi hiện tại.
- Một sơ đồ hay danh sách module sao từ tài liệu cũ mà không kiểm lại cây nguồn.
- Config cho một service mà không có gì khởi động hay triển khai.
- Quy ước được ghi từ một file duy nhất, hoặc từ một style guide mà code bỏ ngoài tai.
- Tên host nội bộ, secret hay dữ liệu khách hàng: hãy xoá chúng.
