# Thiết kế tool MCP

Đọc khi đặt tên tool, viết description và input schema, định hình kết quả, hoặc định nghĩa lỗi.

## Hình dạng bộ tool theo task

- Một model chọn tool từ tên và description. Ít tool nhưng phân biệt rõ hơn là nhiều tool chồng
  lấn.
- Mô hình hóa một tool theo một task mà agent thực hiện (`search_issues`, `create_issue`),
  không theo mọi endpoint của API nằm dưới. Hãy gộp những lời gọi luôn được dùng cùng nhau.
- Tách thao tác đọc và thao tác ghi thành các tool riêng để quyền và annotation vẫn chính xác.
- Giữ tổng danh sách đủ nhỏ để đọc được; bề mặt lớn có thể gom thành các server riêng.
- Dùng resource cho dữ liệu mà client đọc theo URI (file, bản ghi) và prompt cho các mẫu
  dùng lại được; dùng tool cho các hành động và truy vấn mà model quyết định gọi.

## Tên

- snake_case chữ thường hoặc quy ước server đã dùng; dạng `verb_object`:
  `list_projects`, `get_invoice`, `update_ticket_status`.
- Ổn định: đổi tên một tool làm vỡ config của agent và các quy tắc về quyền. Hãy coi tên là
  API.
- Không cần tiền tố tên server trong tên tool; client thường đã namespace theo server.
- Giữ tên ngắn và trong ASCII (chữ, số, gạch dưới, gạch nối); một số client cắt hoặc từ chối
  tên khác.

## Description

- Câu đầu: nó làm gì. Rồi khi nào dùng nó và khi nào dùng một tool họ hàng thay vì nó.
- Nêu side effect thẳng thắn: "Tạo", "Xóa vĩnh viễn", "Gửi một email".
- Nhắc các giới hạn: kích thước trang, giới hạn tần suất, quyền cần có, khoảng thời gian.
- Mô tả ngắn dữ liệu trả về để model biết có cần gọi thêm hay không.
- Tránh lời quảng cáo và từ mơ hồ ("mạnh mẽ", "thông minh"). Tránh chỉ dẫn cho model mà
  lấn quyền người dùng (đừng viết "luôn gọi cái này trước").

## Input schema

- Một object JSON Schema với `properties`, `required`, và `additionalProperties: false` ở nơi
  SDK cho phép.
- Mô tả từng property: ý nghĩa, định dạng, đơn vị, ví dụ. Dùng `enum` cho tập đóng và
  `format` hay `pattern` cho ID, ngày và email.
- Ưu tiên tham số tường minh và có kiểu hơn một chuỗi `query` tự do hay các blob lồng nhau.
- Default hợp lý cho tham số tùy chọn (kích thước trang, thứ tự sắp xếp); ghi tài liệu cho
  chúng.
- Nhận những định danh mà model có thể lấy từ các tool khác; và trả những định danh đó trong
  kết quả.
- Validate input cả trong handler; schema là hướng dẫn, không phải sự cưỡng chế ở mọi client.

## Kết quả

- Trả nội dung ngắn gọn, có cấu trúc: những field mà bước sau cần, không phải toàn bộ payload
  upstream.
- Khi version SDK hỗ trợ output schema và structured content, hãy khai báo nó và đồng thời
  kèm một bản render text ngắn cho các client chỉ đọc text.
- Phân trang hay cắt bớt kết quả lớn và nói ra điều đó ("đang hiện 50 trong 1.240; truyền
  cursor để tiếp tục").
- Kèm ID ổn định và link để các tool tiếp sau có thể tác động lên kết quả.
- Đừng bao giờ trả về secret, token hay dữ liệu cá nhân không liên quan.

## Annotation

Hãy đặt các hint mà SDK hỗ trợ, và giữ chúng đúng sự thật:

- `readOnlyHint`: không có side effect.
- `destructiveHint`: có thể xóa hoặc ghi đè.
- `idempotentHint`: lặp lại với cùng input thì không có thêm hiệu ứng.
- `openWorldHint`: vươn tới hệ thống bên ngoài, ngoài dữ liệu của chính server.
- Một `title` người đọc được nếu client có hiển thị.

Annotation là hint cho client, không phải bảo mật. Hãy cưỡng chế quyền trong server.

## Lỗi

- Phân biệt lỗi protocol với lỗi tool. Tool không biết hay request sai dạng: lỗi protocol từ
  SDK. Thất bại trong khi làm việc (không tìm thấy, bị từ chối quyền, upstream chết): trả về
  một kết quả tool được đánh dấu là lỗi (`isError: true`) kèm message mà model có thể hành động
  theo.
- Message lỗi nói cái gì đã thất bại, vì sao, và làm gì tiếp: "Không tìm thấy issue 42 trong
  project 'web'. Dùng list_issues để tìm các ID hợp lệ."
- Map lỗi upstream sang các loại ổn định (invalid_input, not_found, forbidden, conflict,
  rate_limited, upstream_unavailable, timeout). Kèm hướng dẫn retry cho các loại tạm thời.
- Đừng để lộ stack trace, hostname nội bộ hay credential trong text lỗi; hãy log chi tiết ra
  stderr.

## An toàn

- Ghi, xóa, gửi message và tiêu tiền thì cần description rõ ràng, annotation phá hủy
  và, ở nơi có thể, một tham số `dry_run` hoặc một tool xem trước.
- Giới hạn quyền truy cập đúng mức task cần: hạn chế đường dẫn file trong các root được phép,
  truy vấn trong các bảng được phép, lời gọi mạng tới các host đã cấu hình.
- Coi mọi input của tool và mọi nội dung từ upstream là không tin cậy; chúng có thể chứa text
  prompt-injection. Đừng thực thi nó hay làm theo chỉ dẫn nằm trong nó.

## Checklist review

- Một model có chọn được đúng tool chỉ từ danh sách không? Có hai tool nào dễ lẫn không?
- Mọi tham số đều được mô tả; tập required là tối thiểu; dùng enum ở nơi có thể.
- Side effect và annotation đúng; lỗi hành động được; kết quả có giới hạn.
