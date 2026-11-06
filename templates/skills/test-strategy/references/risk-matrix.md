# Bảng rủi ro và các ca biên

Đọc khi biến hành vi thành rủi ro, khi chọn mức test cho từng rủi ro, hoặc khi liệt kê các ca biên.

## Từ rủi ro sang mức test
| Rủi ro | Mức rẻ nhất mà chứng minh được | Ghi chú |
|---|---|---|
| Tính toán, phân tích cú pháp, rẽ nhánh sai | Unit | Các ca theo bảng trên nhiều input |
| Input không hợp lệ bị nhận hoặc input hợp lệ bị từ chối | Unit, cộng một integration tại biên | Kiểm tra ngay tại chỗ input đi vào |
| Nối dây: config, dependency injection, định tuyến | Integration | Đồ thị module thật, bên ngoài là fake |
| Lưu trữ: truy vấn, migration, transaction | Integration với store thật hoặc nhúng | Dùng chỗ dựng DB test đang có của project |
| Đổi hình dạng làm vỡ một bên tiêu thụ | Contract | Xem reference contract-tests |
| Một hành trình người dùng tối quan trọng vỡ từ đầu tới cuối | End-to-end, một đường | Chỉ khi các mức thấp hơn không thấy được |
| Một bug đã sửa trước đây quay lại | Regression tại đường ráp của bug gốc | Giữ lại bản tái lập gốc |
| Dependency chết, chậm hay báo lỗi | Integration với một fake biết chèn lỗi | Khẳng định timeout, retry, thông điệp lỗi |
| Lách quyền hay lách phân quyền | Integration xuyên qua chính phép kiểm thật | Test cả ca được phép và ca bị từ chối |
| Đồng thời: race, gửi hai lần, mất bản cập nhật | Integration với cách xen kẽ được kiểm soát | Lập lịch tất định, không dùng sleep |
| Regression hiệu năng trên một đường nóng đã biết | Benchmark hay phép kiểm ngân sách nếu project có | So các khối việc tương đương |

Ưu tiên theo khả năng xảy ra nhân với chi phí. Các rủi ro ít khả năng và ít tốn kém có thể được
chấp nhận mà không test; hãy nói rõ điều đó trong kế hoạch.

## Checklist ca biên theo loại input
**Chuỗi:** rỗng, chỉ có khoảng trắng, rất dài, Unicode (dấu kết hợp, emoji, RTL), khác nhau về
chữ hoa chữ thường, khoảng trắng ở đầu hay ở cuối, có ngắt dòng hay NUL bên trong, các ký tự
injection ứng với điểm tiêu đang dùng (SQL, shell, HTML, dấu phân cách đường dẫn).

**Số:** không, số âm, số một, giá trị lớn nhất và nhỏ nhất của kiểu, vừa vượt mỗi giới hạn,
số không nguyên ở chỗ mong đợi số nguyên, NaN và vô cực, làm tròn và độ chính xác
tiền tệ, số được mã hoá dưới dạng chuỗi.

**Tập hợp:** rỗng, một phần tử, có trùng, rất lớn, chưa sắp xếp, lồng nhau mà rỗng,
phần tử null, các biên phân trang (trang đầu, trang cuối, vượt quá cuối).

**Thời gian:** múi giờ và các lần chuyển DST, ngày nhuận, cuối tháng và cuối năm, lệch đồng hồ,
timestamp ở quá khứ hay tương lai xa, khoảng thời gian bằng không, hết hạn đúng tại biên.
Hãy đóng băng hoặc chèn đồng hồ vào.

**Đồng thời:** hai người ghi trên một bản ghi, retry sau khi thành công một phần, cùng một
message được giao trùng, hủy giữa lúc đang xử lý, các giả định về thứ tự.

**I/O và service bên ngoài:** thiếu file, bị từ chối quyền, đĩa đầy, đọc hay ghi
một phần, response sai dạng, timeout, response chậm, kết nối bị reset, hết lượt
retry, nội dung không phải UTF-8, symlink và path traversal.

**Quyền và danh tính:** ẩn danh, đã xác thực nhưng không có role, chủ sở hữu so với người dùng
khác, credential bị thu hồi hay hết hạn, các hành động chỉ dành cho admin bị gọi từ người dùng
thường.

**Trạng thái và vòng đời:** lần chạy đầu khi chưa có dữ liệu, nâng cấp từ dữ liệu của version
trước, gọi lặp lại (tính idempotent), các thao tác sau khi đã xoá hay đã đóng.

Hãy chọn những mục mà thay đổi thực sự với tới được; đừng mặc định test mọi dòng.
