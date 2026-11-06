# Danh sách kiểm tương thích

Đọc khi một lần refactor chạm tới bất cứ thứ gì thấy được từ bên ngoài module đang bị đổi.

Với mỗi mục có áp dụng, hãy ghi lại: cái gì lộ ra, ai tiêu thụ nó, bạn kiểm bằng cách
nào, và kết quả (không đổi / đã đổi kèm quyết định đã duyệt / đã đặt shim).

## Public API và các symbol được export

- Tên, chữ ký, thứ tự tham số, giá trị mặc định, tham số tuỳ chọn so với bắt buộc.
- Kiểu và hình dạng giá trị trả về, kể cả các ca null/undefined và rỗng.
- Kiểu lỗi được ném ra, mã lỗi, và các thông điệp mà bên gọi đối sánh.
- Sync so với async, callback so với promise, thứ tự lặp, tính lười.
- Các lần re-export và entry point của package (map `exports`, file index, public header).
- Các khai báo type giao cho bên tiêu thụ.

## Định dạng config

- Khoá, mức lồng, kiểu, giá trị mặc định, và thứ tự ưu tiên giữa các nguồn.
- Tên biến môi trường và cách phân tích chúng.
- Hành vi với khoá lạ hay khoá thiếu; các khoá cũ có còn được nhận.

## Dữ liệu đã lưu

- File trên đĩa, schema cơ sở dữ liệu, cache, và định dạng serialize của chúng.
- Tên field, giá trị enum, ID, và thứ tự mà bên đọc dựa vào.
- Dữ liệu do code cũ ghi phải vẫn đọc được bằng code mới, và nếu có khả năng
  rollback thì cả chiều ngược lại.

## Cờ CLI và output

- Tên cờ, bí danh, dạng ngắn, thứ tự tham số, mã thoát.
- Output máy đọc được (JSON, phân cách bằng tab) mà script phân tích.
- Chữ trợ giúp chỉ tính khi có test hay tài liệu khẳng định nó.

## Protocol và định dạng trên đường truyền

- Kiểu message, tên field, version, và cách thương lượng.
- Route HTTP, method, mã trạng thái, header, và payload.
- Event cùng tên, payload, và các bảo đảm về thứ tự của chúng.

## Tìm bên tiêu thụ

- Tìm tên symbol, khoá chuỗi, tên file và đường dẫn route trên toàn repo,
  kể cả test, script, tài liệu, ví dụ, và code sinh ra.
- Kiểm các lần truy cập động: reflection, import dựng bằng chuỗi, bảng định tuyến, sổ
  đăng ký plugin, serialize theo tên field.
- Bên tiêu thụ ngoài repo (package đã publish, service khác, config của người dùng)
  không tìm được: hãy coi bề mặt của họ là đã đóng băng, trừ khi có quyết định nói khác.

## Khi buộc phải đổi một thứ

- Ưu tiên một thay đổi dạng thêm vào: giữ tên hay định dạng cũ như một shim chuyển tiếp
  sang cái mới, kèm một ghi chú khai tử dần.
- Nếu buộc phải xoá, hãy dừng và chuyển quyết định lên trên kèm danh sách bên tiêu thụ
  và một đường migration. Ghi lại quyết định đã duyệt vào một ADR hay note của task.
