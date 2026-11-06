# Design token

Đọc khi định nghĩa, đặt tên hay tạo theme cho token, hoặc khi kiểm tra tương phản màu.

## Các tầng

1. **Nguyên thủy** (palette và thang đo thô): `color-blue-600`, `space-4`, `radius-2`, `font-size-3`.
   Đặt tên theo đúng bản chất của chúng. Không bao giờ dùng trực tiếp trong component.
2. **Semantic** (vai trò): `color-text-primary`, `color-surface-raised`, `color-border-subtle`,
   `color-accent`, `color-danger`, `space-inset-md`. Đặt tên theo việc chúng làm. Các theme map
   những token này sang các giá trị nguyên thủy khác nhau.
3. **Component** (không bắt buộc, chỉ khi một component lệch khỏi chuẩn): `button-primary-bg`,
   `input-border-focus`. Trỏ vào token semantic. Thêm dè dặt; mỗi cái là một nhánh rẽ.

Component chỉ tiêu thụ token semantic hoặc token component. Đổi một theme đáng ra chỉ cần
sửa các map semantic, không phải sửa code component.

## Đặt tên

- Theo lược đồ đã có trong dự án. Nếu chưa có: `category-role-variant-state`, chữ thường,
  nối bằng gạch ngang, ví dụ `color-text-secondary`, `color-accent-hover`.
- Tên mô tả vai trò, không mô tả giá trị: `color-danger`, không phải `color-red`; `space-stack-lg`,
  không phải `space-24` ở tầng semantic.
- Giữ thang đo theo thứ tự và chịu được khoảng trống (`100`..`900`, hoặc `1`..`8`) để chèn thêm bậc.
- Một nguồn chân lý duy nhất. Nếu token tồn tại ở nhiều định dạng (CSS variable, theme object, hằng
  số native), hãy sinh ra hoặc đồng bộ từ một file chứ không sửa tay từng cái.

## Sáng và tối

- Định nghĩa mọi màu semantic cho cả hai theme. Một token thiếu giá trị tối là một lỗi.
- Theme tối không phải theme sáng đảo ngược: dùng surface trung tính tối thay vì đen tuyệt đối,
  nâng độ cao bằng surface sáng hơn thay vì bóng đậm hơn, và giảm độ bão hòa của những vùng
  accent lớn.
- Tôn trọng tùy chọn của nền tảng (`prefers-color-scheme` hoặc tương đương native) và cho phép
  ghi đè tường minh nếu sản phẩm đã có sẵn lựa chọn đó.
- Kiểm tra ảnh, hình minh họa, biểu đồ và vòng focus ở cả hai theme, không chỉ riêng chữ.

## Ngưỡng tương phản (WCAG 2.2)

| Cặp màu | Tối thiểu AA | AAA |
|---|---|---|
| Chữ nội dung so với nền | 4.5:1 | 7:1 |
| Chữ lớn (24px+, hoặc 18.66px+ in đậm) | 3:1 | 4.5:1 |
| Đường biên component UI, icon mang nghĩa | 3:1 | - |
| Chỉ báo focus so với các màu kề nó | 3:1 | - |
| Control bị disabled, phần trang trí thuần túy | miễn | - |

- Tính tỉ lệ từ độ sáng tương đối của hai màu sRGB:
  `(L1 + 0.05) / (L2 + 0.05)` với L1 là màu sáng hơn. Ghi lại con số, không ghi "trông ổn".
- Kiểm tra chữ trên mọi surface nó có thể xuất hiện (nền cơ sở, nền nổi, overlay, dòng được chọn, hover).
- Chữ placeholder vẫn là chữ: nó cần 4.5:1, hoặc nó không nên chứa hướng dẫn.
- Màu bán trong suốt: tính dựa trên nền thực tế sau khi ghép lớp.
- Không bao giờ truyền tải trạng thái chỉ bằng màu; luôn kèm chữ, icon, hình dạng hoặc vị trí.

## Các loại token khác

- Khoảng cách: một đơn vị cơ sở (thường là 4 hoặc 8) và một thang ngắn; xem layout-and-typography.md.
- Bán kính: 3-5 bậc cộng thêm `full`. Phần tử lồng trong dùng bán kính nhỏ hơn phần tử chứa nó.
- Độ cao: vài mức có tên, map đổ bóng và màu surface cùng với nhau.
- Chuyển động: token thời lượng (`fast`, `base`, `slow`) và token easing; xem interaction-states.md.
- Z-index: một tập có tên và có thứ tự (`dropdown`, `sticky`, `overlay`, `modal`, `toast`) thay cho
  các con số đặt tùy hứng.

## Spec đầu ra cho một thay đổi token

Liệt kê từng token: tầng, tên, giá trị sáng, giá trị tối, tương phản với các surface đi kèm,
và nó thay thế những giá trị hard-code nào đang có (file và dòng).
