# Review UI

Đọc khi review một màn hình, component hay spec thiết kế đang có về mức khả dụng,
accessibility và tính nhất quán với design system.

## Phạm vi và cách làm

- Review bề mặt được nêu trong việc được giao (assignment). Không mở rộng ra toàn bộ ứng dụng.
- Dùng bằng chứng có sẵn: source (markup, style, token), ảnh chụp, file thiết kế trong repo,
  và chạy ứng dụng cục bộ nếu lệnh chạy của dự án có sẵn và được phép.
- Kiểm tra chỉ bằng bàn phím, ở chiều rộng hẹp, ở zoom 200%, và trong từng theme được hỗ trợ khi bạn
  chạy được UI. Nếu không chạy được, hãy nói rõ và review từ source; đánh dấu những mục chỉ kiểm được
  khi chạy là chưa kiểm chứng.
- Reviewer chỉ đọc thì báo các phát hiện; họ không sửa file.

## Checklist

Thứ bậc và layout
- Một hành động chính cho mỗi view; hành động phá hủy tách riêng và có xác nhận hoặc hoàn tác được.
- Khoảng cách và kích thước lấy từ thang đo của dự án; không có giá trị lệch thang lạc vào.
- Căn theo một tập nhỏ các đường biên; mật độ nhất quán trong một view.

Typography
- Chữ nội dung đọc được (cỡ, chiều cao dòng, chiều dài dòng); chữ co giãn theo thiết lập người dùng.
- Cấp tiêu đề theo cấu trúc, không chỉ theo cỡ thị giác.

Màu và token
- Component dùng token semantic, không dùng giá trị thô.
- Tương phản của chữ và UI đạt ngưỡng trong mọi theme và trên mọi surface được dùng.
- Không có ý nghĩa nào chỉ truyền tải bằng màu.

Trạng thái
- Có hover, focus-visible, active, disabled, loading, lỗi, rỗng ở nơi áp dụng được.
- Focus thấy được trên mọi phần tử tương tác được; thứ tự focus hợp lý; focus được trả lại sau overlay.

Form
- Mọi input đều có nhãn thấy được và gắn kết được bằng chương trình; placeholder không phải là nhãn.
- Lỗi phải cụ thể, nằm cạnh field, và giữ lại dữ liệu người dùng đã nhập.
- Field bắt buộc được đánh dấu; loại input và gợi ý autocomplete phù hợp với dữ liệu.

Ngữ nghĩa accessibility
- Dùng phần tử native theo đúng vai trò của chúng (button, link, input) trước khi dùng vai trò tự tạo.
- Ảnh có chữ thay thế mang nghĩa hoặc được đánh dấu là trang trí.
- Control chỉ có icon thì có tên truy cập được.
- Kích thước đích ít nhất 24x24 CSS px; nội dung dùng được ở chiều rộng 320 CSS px.
- Tùy chọn giảm chuyển động được tôn trọng.

Tính nhất quán
- Cùng một pattern cho cùng một việc trên khắp sản phẩm (dialog, toast, bảng, trạng thái rỗng).
- Dùng lại component đang có thay vì tạo bản gần giống.
- Câu chữ và thuật ngữ nhất quán với phần còn lại của sản phẩm.

## Mức nghiêm trọng

| Mức | Nghĩa | Ví dụ |
|---|---|---|
| Blocker | Người dùng không hoàn thành được tác vụ, hoặc vi phạm một yêu cầu accessibility pháp lý | Bẫy bàn phím, field bắt buộc không nhãn, tương phản chữ 2:1 |
| Major | Làm được tác vụ nhưng dễ sai hoặc chậm với nhiều người dùng | Thiếu trạng thái lỗi, không có chỉ báo focus, hành động chính bị ẩn trên mobile |
| Minor | Không nhất quán hoặc gây vướng nhưng có cách lách | Khoảng cách lệch thang, kiểu nút trùng lặp, trạng thái rỗng yếu |
| Nit | Tinh chỉnh | Lệch căn chút ít, độ dày icon không khớp |

Xếp hạng theo tác động tới người dùng, không theo công sức sửa.

## Định dạng một phát hiện

```text
[Major] Settings > Save button has no visible focus state
Where: src/components/SettingsForm.tsx:84 (class .save-btn), dark theme
Evidence: outline: none in styles/buttons.css:12; no :focus-visible rule; tabbing shows no indicator
Guideline: focus visible, 3:1 indicator contrast
Fix: add focus-visible ring using token color-focus-ring (exists in tokens.css:40)
Verified: yes (keyboard, local run) | no (source only)
```

- Một phát hiện cho mỗi vấn đề; gom các lần lặp của cùng vấn đề thành một danh sách vị trí.
- Bằng chứng phải cụ thể: file và dòng, tỉ lệ tương phản đo được, đường dẫn ảnh chụp, hoặc đúng
  các bước đã làm. "Trông không ổn" không phải bằng chứng.
- Gợi ý sửa nên dùng lại token và component đang có khi có thể.

## Hình thức báo cáo

Tóm tắt (bề mặt đã review, đã kiểm thế nào, cái gì không kiểm được), các phát hiện xếp theo
mức nghiêm trọng, rồi những điểm tốt nên giữ và các câu hỏi còn mở cho chủ sở hữu.
