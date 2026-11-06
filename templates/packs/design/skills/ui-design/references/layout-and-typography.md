# Layout và typography

Đọc khi chọn grid, khoảng cách, thang chữ, độ dài dòng hoặc breakpoint responsive.

## Thang khoảng cách

- Một đơn vị cơ sở, thường là 4px hoặc 8px. Ví dụ thang: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Dùng thang đang có. Giá trị lệch thang (13px, 22px) là một phát hiện (finding) khi review, trừ khi
  nó đến từ một chỉnh sửa thị giác đã được ghi lại.
- Sự gần nhau thể hiện việc nhóm: khoảng cách trong một nhóm nhỏ hơn khoảng cách giữa các nhóm.
  Tỉ lệ thường dùng là 1:2 (ví dụ 8 bên trong, 16 ở giữa; 16 bên trong, 32 giữa các mục lớn).
- Ưu tiên gap của layout trên container hơn margin trên phần tử con; nó tránh khoảng cách bị gộp hay nhân đôi.

## Grid

- Trang nội dung: một cột căn giữa có chiều rộng tối đa, hoặc grid 12 cột với gutter cố định
  (16-32px) và lề ngoài co lại trên màn hình nhỏ (16px là mức tối thiểu thường dùng).
- Khung ứng dụng: thanh điều hướng rộng cố định, vùng chính linh động, pane chi tiết tùy chọn. Hãy quyết
  pane nào co lại trước khi chiều rộng hẹp dần.
- Căn theo một số ít đường biên dọc. Mỗi đường biên thêm vào là thêm nhiễu thị giác.
- Dữ liệu dày (bảng, dashboard) có thể dùng thang chặt hơn, nhưng giữ nó nhất quán trong một view.

## Thang chữ

- Dùng thang theo module (tỉ lệ khoảng 1.2-1.25 cho ứng dụng, tới 1.333 cho dạng báo chí) hoặc
  các bậc đã có của dự án. 5-7 cỡ là đủ cho phần lớn sản phẩm.
- Chữ nội dung: mặc định 16px trên web; không bao giờ dưới 14px cho chữ nội dung, 12px chỉ dành cho
  nhãn phụ với tương phản đủ.
- Dùng `rem` (hoặc đơn vị co giãn được của nền tảng) để chữ đi theo thiết lập cỡ chữ của người dùng.
- Chiều cao dòng: khoảng 1.4-1.6 cho nội dung, 1.1-1.3 cho tiêu đề. Chữ lớn hơn cần ít hơn.
- Độ dày: hai hoặc ba mức (regular, medium hoặc semibold, bold). Thứ bậc đến từ cỡ,
  độ dày và màu cùng nhau, không phải từ nhiều độ dày.
- Giới hạn một hoặc hai họ chữ, tốt nhất là họ dự án đã tải sẵn; thêm một font
  là một quyết định về phụ thuộc, thuộc về chủ sở hữu.
- Dùng chữ số dạng bảng cho các cột số và bộ đếm thời gian.

## Độ dài dòng và tính dễ đọc

- Chiều dài dòng nội dung: khoảng 45-75 ký tự mỗi dòng; chặn container văn bản (ví dụ `max-width: 65ch`).
- Căn lề trái cho chữ nội dung ở ngôn ngữ viết trái sang phải; tránh chữ căn đều hai bên trên web.
- Khoảng cách giữa các đoạn xấp xỉ bằng chiều cao dòng.
- Tính trước việc chữ dài ra: bản dịch có thể dài hơn 30-40%; tránh nhãn có chiều rộng cố định.
- Hỗ trợ viết phải sang trái bằng các thuộc tính logic (start/end) ở nơi stack cho phép.

## Checklist thứ bậc cho mỗi view

- Một hành động chính rõ ràng; hành động phụ yếu hơn về thị giác; hành động phá hủy để tách riêng.
- Tiêu đề trang là chữ lớn nhất trong vùng nội dung.
- Các control liên quan đặt cạnh nhau; nhãn đặt cạnh input của nó (đặt trên với form trên màn hình hẹp).
- Đường quét mắt: tiêu đề và giá trị quan trọng đọc được khi nhìn nhanh mà không đọc phần nội dung.

## Hành vi responsive

- Dùng breakpoint của dự án. Nếu chưa có, hãy bắt đầu từ nội dung: thêm breakpoint ở nơi
  layout bị vỡ, không phải ở các chiều rộng thiết bị. Các mốc tham chiếu thường gặp: ~640, ~768, ~1024, ~1280px.
- Thiết kế cho màn hình nhỏ trước; rồi nâng cấp cho màn hình rộng hơn.
- Với mỗi component hãy quyết: reflow, xếp dọc, co lại (vào menu hoặc phần mở ra), cắt bớt
  (vẫn truy cập được giá trị đầy đủ), hoặc ẩn (chỉ khi không thiết yếu và có ở nơi khác).
- Ưu tiên quy tắc theo container cho những component dùng lại trong các pane rộng khác nhau, khi
  stack hỗ trợ.
- Reflow: ở chiều rộng 320 CSS px (tương đương 1280px ở zoom 400%), nội dung không được cần
  cuộn theo hai chiều, trừ bảng dữ liệu, bản đồ và những thứ tương tự.
- Cảm ứng: đích ít nhất 24x24 CSS px (WCAG 2.2 AA), khuyến nghị 44x44 cho hành động cảm ứng chính,
  và có khoảng cách giữa các đích kề nhau.
- Không dựa vào hover cho thông tin thiết yếu trên thiết bị cảm ứng.
- Tôn trọng vùng an toàn và bàn phím trên màn hình ở mobile; giữ các hành động chính trong tầm với.

## Spec đầu ra

Với mỗi breakpoint: grid/số cột, những vùng nào hiện ra, thay đổi thứ tự, các cỡ chữ thay đổi,
và những component đổi hình thức. Ghi chú hành vi ở zoom 200% và ở chiều rộng hẹp nhất được hỗ trợ.
