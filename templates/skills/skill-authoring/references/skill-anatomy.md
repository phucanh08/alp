# Cấu tạo một skill

Đọc khi viết frontmatter của một skill, khi xếp thứ tự thân bài, hoặc khi bố trí các file của
nó.

## Bố cục
```
<name>/
  SKILL.md              required; Level 1
  references/<topic>.md optional; Level 2, read when a step links it
  scripts/<tool>.mjs    optional; Level 3, run on demand only
  assets/<file>         optional; Level 3, templates or fixtures copied by a step
```
Skill thư viện sống trong `skills/<name>/` của thư viện người dùng; skill của project sống
trong `.alp/skills/<name>/`, và nó thay thế skill thư viện cùng tên trong project đó.

## Frontmatter
```
---
name: release-notes
description: "Draft release notes from merged changes ... Use when ... Not for ..."
---
```
- `name`: chữ thường `a-z`, `0-9` và dấu gạch nối đơn; không gạch nối ở đầu, ở cuối hay hai
  gạch liền; nhiều nhất 64 ký tự; phải bằng tên thư mục.
- `description`: một dòng, theo định dạng thì nhiều nhất 1024 ký tự; index của ALP hiển thị 400
  ký tự đầu, và `alp_skill` chỉ nhận tối đa 300. Không có ngắt dòng, không có dấu ngoặc nhọn.
- Các khoá tuỳ chọn mà định dạng cho phép: `license`, `compatibility` (nhu cầu môi trường, ví
  dụ "Node 20+, git"), `metadata` (một map từ khoá chuỗi sang giá trị chuỗi, như version hay
  tác giả), `allowed-tools` (danh sách mang tính tư vấn; trong ALP nó không cấp gì). Các
  template ALP được ship chỉ dùng `name` và `description`; chỉ thêm khoá tuỳ chọn khi có một
  bên tiêu thụ thật sự đọc chúng.

## Các mục trong thân bài
| Mục | Chứa gì |
|---|---|
| `# Title` | Tên công việc ở dạng mệnh lệnh |
| Khi dùng | Các tình huống cụ thể, phản chiếu các điều kiện kích hoạt trong description |
| Không dùng cho | Các công việc lân cận và skill sở hữu từng cái |
| Điều kiện tiên quyết | Những gì phải đọc hay phải biết trước bước 1 |
| Quy trình | Các bước có số, mỗi bước có một output quan sát được |
| Ràng buộc | Các giới hạn agent không được vượt |
| Kiểm chứng | Các phép kiểm chứng minh kết quả, không phải chứng minh sự nỗ lực |
| Xử lý khi thất bại | Làm gì khi một bước không hoàn tất được |
| Tài liệu tham chiếu | Một dòng cho mỗi file: link, rồi "đọc khi ..." |

## Quy tắc viết
- Mệnh lệnh, cụ thể, kiểm được: "Chạy câu lệnh test của project", không phải "đảm bảo chất
  lượng".
- Mỗi gạch đầu dòng một ý; chỉ dùng số ở chỗ thứ tự có ý nghĩa.
- Nêu các giá trị mặc định và ngưỡng một lần; reference mở rộng thân bài, không bao giờ lặp lại
  nó.
- Ưu tiên công cụ và quy ước của chính project; đừng bao giờ bịa ra câu lệnh.
- Giữ SKILL.md và từng reference trong khoảng 110 dòng; tách theo quyết định, không theo kích
  cỡ.

## Script
- Node `.mjs`, chạy bằng `node scripts/<tool>.mjs <args>`; ưu tiên thư viện chuẩn.
- Đừng bao giờ cài package. Nếu một dependency tuỳ chọn không có, hãy in
  "missing dependency: <name>; install it or skip step N" rồi thoát với mã 2.
- Output tất định, không dùng mạng trừ khi bước đó nói vậy, không ghi ra ngoài
  đường dẫn được truyền vào làm tham số.
- Ship kèm một test hoặc một lần gọi mẫu có ghi tài liệu, kèm output mong đợi.

## Đánh version
- Một skill thư viện mà người dùng đã sửa là của người dùng: hãy đề xuất một bản mới bằng
  `alp_skill` với `replace: true`; đừng bao giờ sửa trực tiếp file đó.
- Ghi các thay đổi về hành vi trong phần tóm tắt của đề xuất, không ghi trong thân bài.
- Các lần phá vỡ tương thích (đổi tên một mục mà một hook hay một role dựa vào, bỏ các
  reference) là những version mới mà người dùng phải duyệt.
