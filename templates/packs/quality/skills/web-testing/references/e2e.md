# Test end-to-end

Đọc khi viết hay làm ổn định test end-to-end trên browser.

Ví dụ dùng API kiểu Playwright; Cypress và các công cụ dựa trên WebDriver đều có
cái tương đương. Hãy dùng runner, config, và helper của dự án.

## Phạm vi

- Giữ số test e2e ít và tập trung vào các hành trình người dùng then chốt: đăng nhập, luồng
  tạo/đọc/cập nhật chính, thanh toán hay gửi biểu mẫu, các ranh giới phân quyền.
- Đẩy các ca biên và biến thể validate xuống tầng test component hoặc unit.
- Một test chứng minh một hành trình; tránh những script khổng lồ test mọi thứ theo thứ tự.

## Selector

Ưu tiên những selector mà người dùng cũng nhận ra, theo thứ tự sau:

1. Vai trò kèm tên truy cập được: `getByRole('button', { name: 'Save' })`.
2. Nhãn: `getByLabel('Email')`.
3. Chữ thấy được hoặc placeholder cho nội dung không tương tác.
4. Một test ID riêng (`data-testid`) khi không có chỗ nắm nào truy cập được, theo
   quy ước của dự án.

Tránh class CSS, cấu trúc DOM, nth-child, và XPath; chúng vỡ khi markup
đổi. Thiếu tên truy cập được thường là một bug accessibility thật; hãy báo lại.

## Chờ theo điều kiện, không ngủ

- Không bao giờ dùng thời gian ngủ cố định (`waitForTimeout`, `sleep`) để đồng bộ.
- Dùng các hành động tự chờ và những assertion ưu tiên web, tự thử lại tới khi một điều kiện
  thành đúng (`expect(locator).toBeVisible()`, `toHaveText`, `toHaveURL`).
- Chờ đúng phản hồi mạng hay trạng thái UI mà bước kế tiếp phụ thuộc vào.
- Giữ timeout ở mức mặc định của dự án; nâng timeout lên để test pass là che đi một
  đường đi chậm hoặc đã vỡ.

## Cách ly

- Mỗi test tự tạo hoặc tự seed dữ liệu của nó (gọi API, helper seed, hoặc fixture)
  và không dựa vào test khác hay thứ tự chạy.
- Dùng một context browser mới cho mỗi test; dùng lại trạng thái lưu trữ đã đăng nhập từ một
  bước setup thay vì đăng nhập qua UI mỗi lần, nếu dự án làm vậy.
- Dùng tên độc nhất (thêm hậu tố là ID của lần chạy) để tránh xung đột khi chạy song song.
- Dọn dữ liệu đã tạo khi môi trường là dùng chung, hoặc dùng một môi trường
  dùng một lần rồi bỏ.
- Không dùng chung state thay đổi được ở cấp module giữa các test.

## Phụ thuộc bên ngoài

- Thay thế các dịch vụ bên thứ ba (thanh toán, email, bản đồ, analytics) ở tầng mạng
  hoặc trỏ chúng tới các chế độ sandbox mà dự án đã dùng.
- Không bao giờ gửi email, SMS, hay thanh toán thật từ test.
- Kiểm soát thời gian và tính ngẫu nhiên ở nơi app cho phép (mock đồng hồ, dữ liệu có seed).

## Assertion

- Khẳng định các kết quả người dùng thấy được: chữ, URL, trạng thái bật, một dòng xuất hiện.
- Khẳng định là không có toast lỗi hay lỗi console, khi dự án cũng làm vậy.
- Tránh khẳng định layout chính xác tới từng pixel trong test chức năng; đó là việc của test thị giác.

## Kiểm thị giác và accessibility

- Snapshot thị giác: khung nhìn, font, và dữ liệu ổn định; che các vùng động (ngày,
  ảnh đại diện); tắt hoạt họa. Hãy xem lại mọi khác biệt snapshot trước khi chấp nhận nó.
- Snapshot khác nhau giữa các OS và bản build browser; hãy sinh mốc cơ sở trong cùng
  môi trường mà CI dùng.
- Quét accessibility (kiểu axe) trên các trang và trạng thái chính, gồm cả dialog đang mở.
  Coi chúng là mức sàn, không phải bằng chứng đã đạt accessibility.

## Gỡ lỗi và trace

- Bật trace, ảnh chụp, hay video khi fail hoặc ở lần retry đầu, theo config của dự án.
- Đọc trace trước khi sửa test: xác định bước nào, trạng thái DOM, và các
  lệnh gọi mạng tại thời điểm fail.
- Tái hiện sự chập chờn bằng cách chạy lặp lại (`--repeat-each` hoặc tương đương) và với
  nhiều worker song song; ghi lại tỉ lệ fail.
- Retry trong CI có thể tồn tại như một chính sách; một test cần tới chúng thì vẫn là chập chờn và phải
  chuyển sang bug-loop.

## Chạy test

- Chạy trên một server cục bộ hay bản build preview, khởi động theo đúng cách dự án làm
  (config web-server của runner hoặc một script).
- Chạy headless trong CI, và chạy có giao diện hoặc kèm inspector ở cục bộ khi gỡ lỗi.
- Chạy đúng những browser mà dự án nhắm tới; không thêm browser mà không có quyết định.
