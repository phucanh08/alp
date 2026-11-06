# Khung mức nghiêm trọng và mẫu báo cáo

Đọc khi xếp mức các phát hiện và viết báo cáo review bảo mật.

## Xếp mức

Xếp theo tác động nếu bị khai thác và theo mức dễ với tới của vấn đề. Bắt đầu từ tác động, rồi
hạ một mức nếu việc khai thác cần những điều kiện tiên quyết hiếm gặp, hoặc nâng một mức nếu
một kẻ tấn công chưa xác thực với tới nó một cách dễ dàng.

| Mức nghiêm trọng | Tác động điển hình | Mức dễ với tới điển hình |
| --- | --- | --- |
| critical | Thực thi code từ xa, lách hoàn toàn xác thực, lộ dữ liệu hàng loạt, rò một secret đang dùng thật | Chưa xác thực hoặc người dùng nào cũng được, không cần điều kiện đặc biệt |
| high | Leo thang đặc quyền, truy cập dữ liệu của người dùng khác, injection vào một điểm tiêu có đặc quyền | Người dùng đã xác thực hoặc một cấu hình phổ biến |
| medium | Lộ dữ liệu có giới hạn, XSS dạng lưu trữ hay phản chiếu, SSRF tới các đích hạn chế, DoS một thành phần | Cần người dùng tương tác, cần config cụ thể, hay cần ở vị trí nội bộ |
| low | Tiết lộ thông tin ít giá trị, thiếu biện pháp làm cứng, khoảng trống phòng thủ theo lớp | Khó với tới hoặc không có đường khai thác trực tiếp |

Độ tự tin là chuyện tách riêng với mức nghiêm trọng:

- confirmed: đường từ input không đáng tin tới điểm tiêu đã được truy vết trong code hoặc được
  chứng minh bằng một test cục bộ, và không có cơ chế kiểm soát nào chặn nó.
- suspected: một đường hợp lý nhưng còn một hay nhiều mắt nối chưa kiểm chứng; hãy nêu rõ mắt
  nào.

Đừng xếp các vấn đề về phong cách hay các điểm yếu lý thuyết không có đường đi nào thành phát
hiện; hãy liệt kê chúng dưới phần ghi chú làm cứng.

## Mẫu báo cáo

```text
Security review: <target (diff range, PR, component)>
Scope reviewed: <paths/modules>   Not reviewed: <paths/areas and why>
Tools run: <command -> result> | none (reason)

Confirmed findings
1. [<severity>] <short title>
   Evidence: <file:line> (source) -> <file:line> (sink)
   Exploit scenario: <who does what, and what they gain>
   Fix suggestion: <specific change; reference the project's existing helper if any>

Suspected findings
1. [<severity>] <short title>
   Evidence: <file:line>
   Unverified link: <what is not yet confirmed and how to confirm it>
   Exploit scenario: <...>
   Fix suggestion: <...>

Hardening notes (not findings)
- <item>

Checked and clean
- <category>: <what was checked>

Summary: <counts by severity>; blocking: <yes/no, which>
```

Secret chỉ được dẫn bằng path:line và loại của nó ("AWS-style key"), không bao giờ dẫn giá trị.
