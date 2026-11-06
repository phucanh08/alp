# Xử lý lỗi

Đọc khi map lỗi sang response, thêm retry hay timeout, hoặc quyết định
log những gì.

## Phân loại lỗi

Phân loại mọi thất bại trước khi quyết định xử lý thế nào.

| Lớp | Ví dụ | Xử lý | Response thường dùng |
| --- | --- | --- | --- |
| Input không hợp lệ | sai kiểu, thiếu field | từ chối ở biên | 400/422 |
| Chưa authenticate / bị cấm | thiếu token, sai chủ sở hữu | từ chối, không lộ chi tiết | 401/403/404 |
| Không tìm thấy | ID không biết | lỗi nghiệp vụ | 404 |
| Xung đột | trùng lặp, version cũ, chuyển trạng thái không hợp lệ | lỗi nghiệp vụ | 409/412 |
| Tần suất hoặc quota | client vượt giới hạn | từ chối kèm gợi ý | 429 |
| Dependency lỗi tạm thời | timeout, mất kết nối, upstream 503 | retry nếu idempotent, nếu không thì đẩy ra | 502/503/504 |
| Dependency lỗi vĩnh viễn | upstream trả 4xx, config sai | đừng retry; báo động | 500/502 |
| Bug / vỡ bất biến | null ở chỗ không thể null | fail nhanh, log kèm ngữ cảnh | 500 |

- Biểu diễn các thất bại nghiệp vụ dự kiến thành lỗi có kiểu hoặc giá trị kết quả,
  theo mẫu của dự án (exception kèm code, error value trong Go, result type).
- Đừng dùng exception cho luồng điều khiển bình thường ở nơi dự án không làm vậy.
- Đừng bao giờ lặng lẽ nuốt một lỗi. Hãy xử lý nó, bọc nó kèm ngữ cảnh rồi đẩy lên,
  hoặc log nó ở biên nơi nó kết thúc.

## Map sang response

- Map lỗi sang response ở một chỗ (error middleware, exception handler, hay một
  helper dùng chung), không phải trong từng handler.
- Trả về hình dạng lỗi chuẩn của dự án với một code ổn định.
- Không phơi nội bộ: không stack trace, SQL, đường dẫn file, hay body của upstream.
- Đưa một request ID hoặc correlation ID vào response và vào log để có thể truy vết
  một báo cáo.
- Lỗi không biết trở thành một 500 chung và được log đầy đủ ở phía server.

## Timeout

- Mọi lời gọi ra ngoài (HTTP, database, cache, queue) đều có timeout. Dùng mặc định
  đã cấu hình của client nếu dự án có; nếu không, hãy đề xuất một giá trị.
- Lan truyền deadline hoặc tín hiệu hủy của request (context trong Go, AbortSignal
  trong Node, timeout hay task cancellation trong Python) để công việc dừng khi người
  gọi đã bỏ cuộc.
- Timeout bên trong phải ngắn hơn timeout bên ngoài.

## Retry

- Chỉ retry các thất bại tạm thời của thao tác idempotent, hoặc thao tác đã được làm
  cho idempotent bằng một key.
- Giới hạn số lần thử (một số nhỏ), dùng exponential backoff kèm jitter, và tôn trọng
  Retry-After.
- Chỉ retry ở một lớp; retry xếp lồng nhau nhân tải lên.
- Đừng retry lỗi validation, auth, hay các lỗi vĩnh viễn khác.
- Với một dependency cứ fail liên tục, dùng circuit breaker hoặc fallback của dự án
  nếu có; đừng thêm library mới mà không có quyết định.
- Background job: sau lần thử cuối, chuyển sang trạng thái thất bại hoặc dead-letter
  queue kèm lý do; đừng lặp mãi.

## Thất bại một phần

- Giữ transaction database ngắn và cục bộ. Đừng gọi service bên ngoài bên trong nó.
- Khi một lần ghi database và một hiệu ứng bên ngoài (message, email, thanh toán)
  đều phải xảy ra, dùng outbox của dự án hoặc một bước bù; nêu rõ khoảng trống nếu
  không có cả hai.
- Làm handler an toàn khi chạy lại.

## Log mà không lộ secret

- Log ở biên nơi một lỗi được xử lý, một lần, với: code lỗi, message, request ID,
  thao tác, các ID không nhạy cảm liên quan, và chuỗi nguyên nhân.
- Dùng logger và field có cấu trúc của dự án; khớp với các level đang có (lỗi client
  thường là info hoặc warn, lỗi server là error).
- Đừng bao giờ log: password, token, API key, session ID, header authorization, số
  thẻ đầy đủ, secret từ config, hay toàn bộ body request có thể chứa chúng.
- Che hoặc bỏ dữ liệu cá nhân (email, điện thoại, địa chỉ) trừ khi policy của dự án
  cho phép.
- Kiểm tra rằng message lỗi dựng từ response của upstream không vọng lại credential.
- Đừng log ở level error cho những lỗi client dự kiến; nó che mất sự cố thật.

## Những kiểm tra cần thêm

- Mỗi lớp lỗi đã map trả về đúng status và code đã ghi trong tài liệu.
- Một exception bất ngờ trả về 500 chung mà không có chi tiết nội bộ.
- Một dependency bị timeout tạo ra response đã ghi trong tài liệu trong hạn deadline.
- Retry dừng sau giới hạn và không retry các lỗi vĩnh viễn.
- Log của một request auth thất bại không chứa token hay password.
