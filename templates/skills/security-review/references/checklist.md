# Checklist review bảo mật

Đọc khi đi qua các hạng mục review; chỉ kiểm những hạng mục mà mục tiêu có chạm tới.

## Xác thực

- Mọi entry point đáng lẽ phải đòi danh tính thì đều kiểm nó, kể cả route mới,
  RPC handler, lần nâng cấp websocket, daemon CLI, và các endpoint admin hay debug.
- Token và session: chữ ký được xác minh, hạn dùng được thực thi, việc thu hồi được tôn trọng,
  thuật toán được cố định (không có "none" hay thuật toán do bên gọi chọn).
- So sánh credential là thời gian hằng; lưu mật khẩu dùng một hàm băm chậm có salt.
- Các endpoint đăng nhập, đặt lại mật khẩu và cấp token chống được dò danh sách và thử vét cạn.

## Phân quyền và ranh giới quyền

- Các phép kiểm diễn ra ở phía server trên mọi request, không chỉ ở UI hay client.
- Kiểm ở mức đối tượng: bên gọi sở hữu hoặc được phép truy cập đúng ID bản ghi đó.
- Các phép kiểm role hay scope không thể bị lách bằng route khác, endpoint xử lý theo lô,
  hay bằng cách can thiệp tham số (gán hàng loạt vào `role`, `owner`, `isAdmin`).
- Các thao tác đặc quyền (xoá, xuất dữ liệu, mạo danh, đổi config) đều có cổng kiểm.
- Mặc định là từ chối; feature mới không vô tình thừa hưởng quyền rộng.

## Lộ secret

- Không có credential, key hay token nào bị commit vào code, config, fixture hay tài liệu.
  Chỉ báo path:line; đừng tái hiện giá trị.
- Secret không được trả về trong response API, thông điệp lỗi, hay bundle phía client.
- Secret đến từ cơ chế đã được project thiết lập (biến môi trường, vault, keychain).

## Kiểm tra input và injection

- SQL/NoSQL: dùng truy vấn tham số hoá; không dựng truy vấn bằng chuỗi từ input.
- Command injection: không dựng chuỗi shell từ input; dùng mảng tham số.
- Output template, HTML và markdown được escape theo ngữ cảnh (XSS).
- Input dạng path, URL, header, regex (ReDoS), XML (XXE) và LDAP đều được kiểm tra.
- Kiểm tra ngay tại ranh giới tin cậy, ưu tiên danh sách cho phép hơn danh sách cấm.

## Rủi ro về dependency và chuỗi cung ứng

- Dependency mới: cần thiết, còn được bảo trì, có uy tín, tương thích giấy phép.
- Các script cài đặt (`preinstall`, `postinstall`, hook build) trong dep mới hoặc vừa cập nhật.
- Thay đổi lockfile khớp với thay đổi manifest; không có URL registry hay URL nguồn nào không
  giải thích được.
- Version được ghim hay cho khoảng theo chính sách của project; không dùng URL git hay tarball
  mà không có lý do.
- Output của công cụ audit đang có cho các package đã đổi, nếu được phép chạy.

## Thao tác filesystem không an toàn

- Path traversal: các đường dẫn do người dùng kiểm soát được chuẩn hoá và giam trong một thư
  mục gốc.
- Symlink: lần theo một link không được thoát khỏi thư mục gốc hay ghi đè đích.
- File tạm được tạo với tên độc nhất và quyền hạn chế; được dọn sau khi dùng.
- Mode file của các secret và config được ghi ra không phải là ai cũng đọc được.
- Lúc giải nén, kiểm đường dẫn từng mục (zip slip) và kích thước.

## Ranh giới thực thi từ xa

- Process được sinh ra: executable cố định, mảng tham số, không dùng shell trừ khi bắt buộc,
  env và cwd được kiểm soát.
- Không dùng `eval`, `Function`, hay `require`/`import` động với tên suy ra từ input.
- Việc deserialize dữ liệu không đáng tin dùng một định dạng an toàn hoặc có kiểm tra schema.
- SSRF: các URL đi ra suy từ input phải nằm trong danh sách cho phép; các địa chỉ nội bộ và
  địa chỉ metadata bị chặn; các lần redirect được kiểm lại.
- Plugin, hook hay script nạp từ những nơi người dùng ghi được thì phải được tin một cách
  rõ ràng, không phải mặc nhiên.

## Ghi log dữ liệu nhạy cảm

- Log, trace và báo cáo lỗi bỏ qua mật khẩu, token, key, session ID
  và dữ liệu cá nhân, hoặc che chúng đi.
- Các bản dump request/response và chế độ debug mặc định tắt và không được bật trong
  config production.
- Log injection: các ký tự xuống dòng và ký tự điều khiển đến từ input đều được escape.
