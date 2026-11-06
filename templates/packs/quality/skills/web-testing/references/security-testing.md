# Test bảo mật cơ bản

Đọc khi chạy audit phụ thuộc, kiểm header, hay test luồng auth.

Phần này nói về các kiểm tra an toàn, thường lệ, trong môi trường test. Review bảo mật của code hay
thiết kế thuộc về security-review. Viết mã khai thác, kiểm thử xâm nhập, và
quét những hệ thống bạn không sở hữu đều nằm ngoài phạm vi.

## Việc cho phép và an toàn

- Chỉ test những môi trường chủ sở hữu đã cho phép: cục bộ, CI, hoặc một bản
  deploy test riêng. Không bao giờ test production hay hệ thống bên thứ ba mà không có văn bản
  cho phép tường minh, nêu rõ đích và các kiểm tra được phép.
- Chỉ dùng tài khoản test và dữ liệu tổng hợp. Không đọc, in ra, hay lưu secret,
  token, hay dữ liệu cá nhân thật.
- Dùng các kiểm tra không phá hoại. Không chạy scanner hung hãn, fuzzer, hay
  công cụ dò vét cạn, trừ khi chủ sở hữu đã cho phép dùng chúng trên đích đó.
- Nếu một kiểm tra phát hiện một lỗ hổng thật, hãy dừng việc thăm dò nó, ghi lại các bước
  tái hiện tối thiểu, và báo lên trên một cách riêng tư; không dán chi tiết khai thác
  hay secret vào log dùng chung.

## Audit phụ thuộc

- Chạy công cụ audit có sẵn của trình quản lý package (ví dụ `npm audit`, `pnpm audit`,
  `pip-audit`, `govulncheck`) hoặc scanner mà dự án đã dùng. Không
  cài scanner mới mà không có quyết định.
- Báo lại: package, phiên bản đã cài, cảnh báo bảo mật, mức nghiêm trọng, đường chạy code có lỗ hổng
  có với tới được hay không nếu biết, và phiên bản đã sửa.
- Không chạy các lệnh tự động sửa để nâng cấp phụ thuộc; nâng cấp là một
  thay đổi riêng, phải được chủ sở hữu chấp thuận và có test riêng của nó.
- Ghi riêng các phụ thuộc chỉ dùng khi dev, tách khỏi phụ thuộc lúc chạy.

## Kiểm header HTTP

Gửi request tới các trang chính và các phản hồi API từ môi trường test rồi kiểm:

- `Strict-Transport-Security` trên các phản hồi HTTPS.
- `Content-Security-Policy` có mặt và không có `unsafe-inline` rộng hay nguồn script
  dạng ký tự đại diện, theo chính sách của dự án.
- `X-Content-Type-Options: nosniff`.
- Kiểm soát việc nhúng khung: CSP `frame-ancestors` hoặc `X-Frame-Options`.
- `Referrer-Policy` đã được đặt.
- Cookie cho session: `Secure`, `HttpOnly`, và một `SameSite` phù hợp.
- CORS: không có origin dạng ký tự đại diện đi kèm thông tin đăng nhập; các origin được phép khớp với danh sách
  đã định.
- Không có header tiết lộ phiên bản hay stack trace trong các phản hồi lỗi.

Hãy viết những cái này thành test tự động (test e2e hay test API) khi dự án muốn giữ chúng lại.

## Test luồng xác thực

- Truy cập chưa đăng nhập vào trang và API được bảo vệ thì bị từ chối hoặc bị chuyển hướng.
- Người dùng A không đọc hay sửa được tài nguyên của người dùng B bằng cách đổi một ID (IDOR).
- Một người dùng không có vai trò thì không tới được trang admin hay gọi được API admin trực tiếp, chứ không
  phải chỉ chặn bằng cách ẩn nút.
- Logout làm session mất hiệu lực; cookie hay token session cũ thôi hoạt động.
- Token đã hết hạn hoặc bị can thiệp thì bị từ chối.
- Token đặt lại mật khẩu chỉ dùng được một lần và có hết hạn.
- Endpoint đăng nhập và đặt lại mật khẩu có giới hạn tần suất với các lần thử lặp lại (hãy test bằng một số nhỏ
  request, không phải một lượt dò vét cạn).
- Thông báo lỗi không tiết lộ việc một tài khoản có tồn tại hay không, theo chính sách của dự án.
- Request làm đổi state phải có bảo vệ CSRF khi việc xác thực dựa vào cookie.

## Kiểm việc xử lý dữ liệu nhập

- Dữ liệu người dùng nhập được phản chiếu lại thì phải được escape trong trang đã render (hãy gửi một dấu hiệu vô hại,
  ví dụ một chuỗi có dấu ngoặc nhọn và dấu nháy, rồi kiểm xem nó render ra như chữ).
- Tải file lên thì từ chối các loại không được phép và file quá lớn.
- Tham số chuyển hướng chỉ nhận những đích được phép.
- API từ chối những field ngoài dự kiến có thể đặt được các thuộc tính đặc quyền.

## Báo cáo

- Môi trường đã test và việc cho phép tương ứng.
- Từng kiểm tra: pass, fail, hay chưa chạy kèm lý do.
- Các phát hiện kèm mức nghiêm trọng, endpoint hay trang bị ảnh hưởng, cách tái hiện tối thiểu, và một
  chủ sở hữu được gợi ý (backend-development, frontend-development, hay security-review).
- Các cảnh báo bảo mật của phụ thuộc kèm đường nâng cấp, nhưng không tự áp dụng chúng.
