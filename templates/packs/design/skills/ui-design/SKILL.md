---
name: ui-design
description: "Ra quyết định và review thiết kế UI/UX: layout, typography, màu và token, trạng thái tương tác, hành vi responsive và tính nhất quán với design system. Dùng khi thiết kế hình thức của một màn hình hay component, định nghĩa token, hoặc review UI theo chuẩn khả dụng và accessibility. Không dùng để viết code component (frontend-development) hay viết nội dung."
---

# Ra quyết định và review thiết kế UI

## Khi nào dùng

- Một màn hình, luồng hay component cần quyết định về layout, thứ bậc, khoảng cách hoặc kiểu chữ.
- Màu, khoảng cách, bán kính, đổ bóng hoặc kiểu chữ cần thành token, hoặc token cần biến thể sáng/tối.
- Một thiết kế cần đặc tả trạng thái tương tác: hover, focus, active, disabled, loading, rỗng, lỗi.
- UI đang có cần được review về khả dụng, accessibility và tính nhất quán với design system.
- Hành vi responsive theo chiều rộng, cách nhập liệu hoặc mức zoom chưa được quyết hoặc đang sai.

## Không dùng cho

- Viết hay refactor code component, hạ tầng styling hoặc quản lý state: frontend-development.
- Nội dung marketing hoặc đặt tên sản phẩm.
- Nhận diện thương hiệu, logo hoặc sản xuất hình minh họa.
- Tối ưu hiệu năng render: dùng quy trình profiling của dự án.

## Điều kiện tiên quyết

- Việc được giao (assignment) nêu rõ bề mặt (màn hình, component, luồng) và ai dùng nó trên thiết bị nào.
- Đọc ALP.md và design system đang có của dự án: file token, config theme, thư viện component,
  style guide, ảnh chụp hoặc file thiết kế đã có trong repository.
- Biết cơ chế styling của stack (CSS variable, utility class, theme object, native style) qua
  manifest và config, không phải qua tên thư mục.

## Quy trình

1. Kiểm kê những gì đã có. Tìm token, component và pattern hiện tại đã giải quyết được một phần
   vấn đề. Ghi lại bạn đã tìm ở đâu trước khi nói là thiếu một thứ gì.
2. Nêu tác vụ người dùng mà bề mặt này phục vụ và một hành động chính duy nhất cho mỗi view. Thiết kế
   thứ bậc quanh hành động đó; hạ bậc mọi thứ còn lại.
3. Quyết định layout và kiểu chữ từ thang đo đang có. Dùng thang khoảng cách và thang chữ của dự án;
   chỉ thêm một bậc khi không bậc nào vừa, và nói rõ vì sao.
4. Quyết định màu qua token, không bao giờ dùng giá trị thô trong component. Map token semantic (surface,
   text, border, accent, danger) sang palette nguyên thủy cho cả theme sáng và tối, và kiểm tra tương phản.
5. Đặc tả mọi trạng thái tương tác cho từng phần tử tương tác được, gồm cả focus bàn phím,
   loading, rỗng và lỗi. Đặc tả chuyển động kèm một phương án giảm chuyển động.
6. Đặc tả hành vi responsive: cái gì reflow, co lại, ẩn đi hoặc đổi thứ tự ở mỗi breakpoint,
   và layout hoạt động thế nào ở zoom 200% và trên thiết bị cảm ứng.
7. Viết quyết định thành một spec ngắn: token đã dùng hoặc thêm, layout theo từng breakpoint, bảng
   trạng thái, ghi chú accessibility, và các câu hỏi còn mở. Giao phần cài đặt cho role triển khai.
8. Khi review, dùng checklist review, xếp các phát hiện theo mức nghiêm trọng và dẫn bằng chứng
   (file và dòng, ảnh chụp, tỉ lệ tương phản đo được) cho từng cái.

## Ràng buộc

- Trước hết hãy tuân theo design system, stack và quy ước đang có của dự án. Chỉ đề xuất token,
  component hay pattern mới khi cái đang có không đáp ứng được, và nêu rõ nó thay thế cái gì.
- Không thêm thư viện UI, bộ icon, dịch vụ font hoặc phụ thuộc công cụ thiết kế mà không có
  quyết định của chủ sở hữu. Không tự động cài.
- Không tải dữ liệu thiết kế, font hay ảnh từ xa. Chỉ làm với những gì có trong repository và brief.
- Agent chỉ đọc (oracle, reviewer, architect) dừng ở spec hoặc các phát hiện; chúng không sửa file.
- Accessibility là yêu cầu, không phải bước làm đẹp: tương phản WCAG 2.2 AA, focus thấy được,
  kích thước đích, và không có thông tin nào chỉ truyền tải bằng màu.
- Skill không cấp thẩm quyền: quyết định thiếu về sản phẩm hay thương hiệu chuyển lên main và người dùng.

## Kiểm chứng

- Mọi cặp màu trong spec đều có tỉ lệ tương phản được nêu và đạt ngưỡng của nó ở cả hai theme.
- Mọi phần tử tương tác được đều có đủ các trạng thái áp dụng được, gồm cả focus và disabled.
- Layout được mô tả tại các breakpoint của dự án và ở zoom 200% mà nội dung chữ không bị cuộn
  ngang.
- Token mới theo đúng lược đồ đặt tên đang có và có giá trị cho cả hai theme.
- Mỗi phát hiện khi review đều có mức nghiêm trọng, vị trí, bằng chứng và một cách sửa cụ thể.

## Xử lý khi thất bại

- Chưa có design system: đề xuất một bộ token tối thiểu suy ra từ các giá trị đã dùng trong code,
  và đánh dấu nó là một quyết định cho chủ sở hữu thay vì tự nghĩ ra cả một hệ thống.
- Đang dùng những pattern xung đột nhau: liệt kê kèm vị trí và khuyến nghị một cái; không
  im lặng tự chọn.
- Màu thương hiệu không đạt tương phản: giữ giá trị thương hiệu cho phần trang trí và đề xuất một
  biến thể đã điều chỉnh, đạt accessibility, cho chữ và control; chuyển lựa chọn lên trên.
- Chưa rõ thiết bị hay người dùng mục tiêu: nêu giả định đó trong spec và đánh dấu là còn mở.

## Tài liệu tham chiếu

- [references/design-tokens.md](references/design-tokens.md) — đọc khi định nghĩa, đặt tên hay tạo theme cho token, hoặc kiểm tra tương phản ở bước 4.
- [references/layout-and-typography.md](references/layout-and-typography.md) — đọc khi chọn grid, khoảng cách, thang chữ hay breakpoint ở bước 3 và 6.
- [references/interaction-states.md](references/interaction-states.md) — đọc khi đặc tả trạng thái hoặc chuyển động ở bước 5.
- [references/ui-review.md](references/ui-review.md) — đọc khi review UI đang có ở bước 8.
