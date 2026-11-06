# Accessibility

Đọc khi dựng control tương tác, form, dialog, hay widget tự tạo.

Nhắm tới WCAG 2.2 AA trừ khi dự án nêu mục tiêu khác. Trước hết hãy dùng các component
design-system đã đạt accessibility của dự án; chúng thường đã xử lý focus và ARIA.

## HTML semantic trước đã

- Dùng phần tử native đúng mục đích của nó: `button` cho hành động, `a href` cho
  điều hướng, `input`/`select`/`textarea` cho dữ liệu, `label` cho nhãn, `table` cho
  dữ liệu dạng bảng, danh sách cho danh sách.
- Không bao giờ dùng `div` hay `span` gắn click handler làm nút; nó thiếu hỗ trợ bàn phím
  và vai trò.
- Một `h1` cho mỗi trang và tiêu đề theo thứ tự; có landmark (`header`, `nav`, `main`,
  `footer`) để người dùng trình đọc màn hình nhảy được.
- Đặt `lang` cho trang và một tiêu đề tài liệu có nghĩa cho mỗi route.

## Bàn phím

- Mọi thứ điều khiển được bằng chuột đều điều khiển được bằng bàn phím: Tab và Shift+Tab để di chuyển,
  Enter hoặc Space để kích hoạt, Escape để bỏ qua, các mũi tên bên trong widget phức hợp
  (menu, tab, listbox) theo các pattern của ARIA Authoring Practices.
- Thứ tự Tab theo thứ tự thị giác. Tránh `tabindex` dương; chỉ dùng `tabindex="0"`
  cho widget tự tạo cần focus được và `-1` cho các đích focus bằng chương trình.
- Không có bẫy bàn phím, trừ dialog dạng modal giữ focus trong lúc nó đang mở.
- Cung cấp link bỏ qua để tới nội dung chính trên những trang có phần điều hướng dài.

## Quản lý focus

- Focus phải thấy được; không bỏ viền mà không có một kiểu khác thấy được tương đương.
- Dialog: chuyển focus vào dialog khi mở, giữ nó trong lúc mở, đóng khi nhấn Escape,
  trả focus về phần tử đã mở nó khi đóng. Ưu tiên phần tử `dialog` native hoặc
  component dialog của dự án.
- Sau khi điều hướng ở client, chuyển focus tới tiêu đề của trang mới hoặc vùng chính,
  hoặc dùng cơ chế thông báo route của framework.
- Sau một lỗi form, focus vào field không hợp lệ đầu tiên hoặc vào bản tóm tắt lỗi.
- Sau khi xóa một mục, chuyển focus tới một mục lân cận hợp lý.

## Chỉ dùng ARIA khi cần

- Không có ARIA còn tốt hơn ARIA sai. Chỉ dùng khi HTML native không diễn đạt được
  vai trò, trạng thái, hay quan hệ.
- Những cách dùng chính đáng thường gặp: `aria-expanded` và `aria-controls` trên phần tử
  mở ra nội dung, `aria-current` cho mục điều hướng hiện tại, `aria-describedby` cho gợi ý và
  lỗi, vùng `aria-live` cho các thông báo trạng thái bất đồng bộ, `aria-label` cho nút
  chỉ có icon.
- Widget tự tạo phải cài đặt đầy đủ pattern bàn phím của vai trò nó; chỉ thêm một
  `role` thì không đủ.
- Không ẩn nội dung focus được bằng `aria-hidden`.

## Form

- Mọi input đều có nhãn gắn được bằng chương trình (nên có `label` thấy được). Placeholder
  không phải nhãn.
- Đánh dấu field bắt buộc bằng chữ và bằng `required` hoặc `aria-required`.
- Gắn thông báo lỗi với field (`aria-describedby`) và đặt
  `aria-invalid` khi không hợp lệ. Không dựa vào màu đơn thuần.
- Nhóm các control liên quan bằng `fieldset` và `legend`.
- Dùng đúng loại input và đúng giá trị `autocomplete`.

## Thị giác

- Tương phản chữ ít nhất 4.5:1 (3:1 với chữ lớn); tương phản của component UI và chỉ báo
  focus ít nhất 3:1. Dùng token của dự án; báo token không đạt cho
  ui-design chứ đừng tự nghĩ ra màu.
- Không truyền tải thông tin chỉ bằng màu; hãy thêm chữ, icon, hay họa tiết.
- Hỗ trợ zoom 200% và khung nhìn hẹp mà không mất nội dung và không phải cuộn
  ngang để đọc chữ.
- Đích tương tác đủ lớn để bấm (ít nhất 24 nhân 24 CSS pixel).
- Tôn trọng `prefers-reduced-motion` với những hoạt họa không thiết yếu.

## Media và nội dung

- Ảnh mang nghĩa thì có chữ `alt` mô tả mục đích của nó; ảnh trang trí thì dùng
  `alt=""`.
- Nút chỉ có icon thì có tên truy cập được.
- Video có phụ đề; audio có bản ghi lời khi dự án hỗ trợ.
- Chữ của link mô tả đích đến; tránh kiểu "bấm vào đây".

## Cách kiểm

- Vận hành tính năng chỉ bằng bàn phím.
- Chạy công cụ kiểm tự động của dự án (ví dụ công cụ dựa trên axe) nếu có;
  công cụ tự động chỉ tìm ra một phần số vấn đề.
- Kiểm thử nhanh bằng trình đọc màn hình khi thay đổi có đưa vào một widget tự tạo.
