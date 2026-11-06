# Tiêu chí sẵn sàng phát hành

Đọc khi đánh giá từng tiêu chí phát hành và khi quyết định tiêu chí nào là chặn.

Dưới đây là mặc định; checklist phát hành của chính project hoặc ALP.md ghi đè trạng thái
chặn. Các giá trị trạng thái: PASS, FAIL, NOT VERIFIED, N/A (kèm lý do).

| # | Tiêu chí | Chặn | Bằng chứng được tính | Bẫy thường gặp |
| --- | --- | --- | --- | --- |
| 1 | Bản ứng viên đã ghim | có | SHA, chuỗi version, cây sạch (`git status`, `git rev-parse HEAD`) | Đánh giá một tên nhánh thay vì một SHA |
| 2 | CI xanh trên đúng SHA | có | Tên các check bắt buộc kèm trạng thái cho SHA đó | Xanh trên head của PR, không phải trên merge commit; một check bắt buộc bị skip |
| 3 | Bộ test phát hành | có | Câu lệnh, số pass/fail/skip, chạy trên SHA đó | Test bị skip giấu trong tổng số; test chập chờn chạy lại tới khi xanh mà không ghi chú |
| 4 | Artifact từ SHA | có | Log build hay provenance nêu tên SHA; dấu version trong artifact; checksum khớp | Artifact build lại cục bộ từ một cây bẩn; artifact cache cũ |
| 5 | Phát hiện bảo mật | có, với critical/high | Danh sách phát hiện còn mở kèm mức nghiêm trọng và trạng thái | Phát hiện theo dõi ở nơi khác mà không kiểm; chưa chạy audit mà đã gọi là sạch |
| 6 | Tương thích protocol/API | có, nếu phá vỡ mà chưa thông báo | Diff của bề mặt public kể từ bản phát hành trước; mục changelog | Bỏ sót thay đổi về config hay cờ CLI |
| 7 | Migration đã test | có, nếu có migration | Migration chạy trên dữ liệu tiêu biểu; kết quả | Chỉ test trên dữ liệu rỗng |
| 8 | Migration đảo ngược được | có, nếu không đảo ngược được mà không có backup | Test migration xuống, hoặc kế hoạch backup và sửa tiến | Cho rằng đảo ngược được mà không chạy thử |
| 9 | Kế hoạch rollback | có | Các bước đã viết ra, ai chạy chúng, kết quả diễn thử nếu có | Rollback bị một migration không đảo ngược được chặn lại |
| 10 | Release note | không | Đường dẫn hay link; phủ các thay đổi phá vỡ và các migration | Note sinh từ commit, thiếu phần ảnh hưởng tới người dùng |
| 11 | Tài liệu đã cập nhật | không | Các đường dẫn tài liệu đã đổi | Tài liệu mô tả hành vi chưa phát hành |
| 12 | Monitoring và cảnh báo | không, có với thay đổi nhiều rủi ro | Tên dashboard hay cảnh báo phủ hành vi mới | Một kiểu lỗi mới mà không có tín hiệu nào |
| 13 | On-call / người sở hữu đã biết | không | Người sở hữu được nêu tên và đã xác nhận | Khung giờ phát hành nằm ngoài lúc người sở hữu có mặt |

## Thu bằng chứng

- Ưu tiên các câu lệnh có output tái lập được: ghi lại dòng lệnh và các dòng output liên quan,
  không phải một bản diễn giải.
- Khi CI hay nơi lưu artifact không tới được từ phiên này, hãy xin agent giao việc một link
  hoặc một bản xuất; tới lúc đó tiêu chí vẫn là NOT VERIFIED.
- Dùng lại output của security-review cho tiêu chí 5 nếu nó đã phủ SHA ứng viên;
  nếu không thì nêu rõ khoảng trống về độ phủ của nó.
- N/A cần một lý do ("không có migration: không có thay đổi schema hay định dạng config kể từ
  v1.4.0, đã kiểm bằng diff của migrations/ và schema config").

## Ghi đè trạng thái chặn

- Một quy tắc của project có thể biến một mục không chặn thành chặn (ví dụ release note bị
  chính sách yêu cầu). Hãy dẫn quy tắc đó.
- Hạ một mục chặn xuống không chặn thì cần một quyết định rõ ràng từ người dùng hoặc từ một
  người sở hữu mà người dùng nêu tên; hãy ghi lại ai đã quyết.
