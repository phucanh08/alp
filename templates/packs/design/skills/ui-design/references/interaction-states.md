# Trạng thái tương tác và chuyển động

Đọc khi đặc tả trạng thái cho các phần tử tương tác được hoặc cho view, hoặc khi định nghĩa chuyển động.

## Trạng thái của control

Đặc tả từng trạng thái áp dụng được cho mọi phần tử tương tác được. Đầu ra mong đợi là một
bảng trạng thái cho mỗi component.

| Trạng thái | Mục đích | Yêu cầu |
|---|---|---|
| Default | Hình thức khi nghỉ | Nhận ra được là tương tác được mà không cần hover |
| Hover | Gợi ý cho con trỏ | Thay đổi nhẹ; không bao giờ là tín hiệu duy nhất; không cần trên cảm ứng |
| Focus-visible | Vị trí bàn phím | Chỉ báo thấy được, 3:1 so với màu kề, không bị nội dung sticky che |
| Active / được nhấn | Phản hồi khi nhấn | Tức thì; khác biệt với hover |
| Selected / checked | Lựa chọn còn lưu lại | Không chỉ bằng màu; dùng dấu check, tô nền, độ dày hoặc chữ |
| Disabled | Hiện không dùng được | Giải thích vì sao nếu có thể; cân nhắc bật kèm thông báo |
| Chỉ đọc | Thấy được, không sửa được | Vẫn focus được và copy được |
| Loading / đang xử lý | Hành động đang diễn ra | Chặn submit hai lần; giữ kích thước ổn định; thông báo cho công nghệ trợ giúp |
| Invalid / lỗi | Dữ liệu nhập bị từ chối | Thông báo cạnh field, chữ kèm icon, chỉ ra cách sửa |
| Success | Hành động đã được xác nhận | Ngắn, không chặn, có thông báo |

Ghi chú:

- Không bao giờ bỏ viền focus mà không có thứ thay thế thấy được.
- Thứ tự focus theo thứ tự đọc; modal giữ focus bên trong và trả nó lại khi đóng.
- Nút disabled không focus được trên nhiều stack, nên người dùng không thể biết vì sao nó bị
  disabled. Nên giải thích yêu cầu còn thiếu ngay cạnh control.
- Giữ vùng bấm ổn định qua các trạng thái; một spinner không được làm nút đổi kích thước.

## Trạng thái của view

Mọi view dựa trên dữ liệu đều cần thiết kế những trạng thái sau, không chỉ trạng thái có dữ liệu:

- **Loading lần đầu:** skeleton khớp layout cuối cho các chờ ngắn; spinner kèm nhãn cho những
  hình dạng chưa biết. Tránh nháy loader với phản hồi rất nhanh (hoãn hiện nó một chút).
- **Rỗng (lần dùng đầu):** giải thích cái gì sẽ xuất hiện và mời hành động chính để tạo nó.
- **Rỗng (không có kết quả):** nói rõ filter hay truy vấn không ra gì; mời xóa nó đi.
- **Một phần:** một phần dữ liệu đã tải, một phần lỗi; hiện cái có và đánh dấu phần thiếu.
- **Lỗi:** nguyên nhân bằng lời thường, người dùng có thể làm gì (thử lại, kiểm tra kết nối, liên hệ),
  và giữ lại dữ liệu người dùng đã nhập. Không hiện stack trace thô.
- **Offline / dữ liệu cũ:** cho biết dữ liệu cũ cỡ nào và khi nào sẽ làm mới, nếu sản phẩm hỗ trợ.
- **Bị từ chối quyền:** nói rõ là thiếu quyền truy cập và ai có thể cấp, mà không để lộ nội dung.
- **Tràn:** tên dài, nhiều mục, số lớn, ảnh bị thiếu.

## Thời điểm phản hồi

- Dưới ~100ms: cảm giác tức thì, không cần chỉ báo.
- ~100ms đến 1s: hiện một chỉ báo nhẹ trên chính control đó.
- Trên ~1s: hiện tiến trình hoặc trạng thái loading cho cả vùng.
- Trên ~10s: hiện tiến trình xác định nếu có thể và cho phép hủy hoặc chạy nền.
- Cập nhật lạc quan cần một đường thoát khi lỗi, thấy được và đảo lại được.

## Chuyển động

- Mục đích trước đã: chuyển động giải thích thay đổi không gian, tính liên tục hoặc phản hồi. Bỏ các
  chuyển động trang trí không phục vụ điều nào trong số đó.
- Thời lượng: khoảng 100-200ms cho control nhỏ, 200-300ms cho panel và overlay, ít khi
  trên 400ms. Lúc ra hơi nhanh hơn lúc vào.
- Easing: ease-out khi vào, ease-in khi ra, ease-in-out chuẩn khi di chuyển trên màn hình.
  Dùng token chuyển động của dự án.
- Hoạt họa opacity và transform; tránh hoạt họa các thuộc tính layout gây reflow.
- **Giảm chuyển động:** khi người dùng yêu cầu giảm chuyển động (`prefers-reduced-motion` hoặc
  thiết lập native), hãy thay chuyển động, parallax, zoom và hoạt họa tự chạy bằng một thay đổi
  tức thì hoặc một crossfade ngắn. Nêu biến thể giảm đó trong spec cho từng hoạt họa.
- Không nội dung nào nháy quá ba lần mỗi giây.
- Nội dung tự chạy hoặc đang chuyển động kéo dài trên 5 giây cần có pause, stop hoặc hide.

## Thông báo

- Thay đổi trạng thái (đã lưu, loading xong, lỗi sau khi submit) được thông báo qua cơ chế live-region
  hoặc cơ chế thông báo accessibility của stack, ở mức lịch sự trừ khi gấp.
- Sau khi submit form mà có lỗi, chuyển focus tới bản tóm tắt lỗi hoặc field không hợp lệ đầu tiên.
