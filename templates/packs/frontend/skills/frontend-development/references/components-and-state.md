# Component và state

Đọc khi chia component, chọn chỗ đặt state, hoặc xử lý form.

Ví dụ dùng thuật ngữ React; cùng ý tưởng đó map sang Vue (props, emits, refs, computed,
composable) và Svelte (props, store, rune hoặc câu lệnh reactive). Hãy theo
pattern và bố trí file đang có của dự án.

## Cấu trúc component

- Một component, một việc. Chia khi một phần có state riêng, được dùng lại, hoặc làm
  component cha khó đọc; không chia chỉ để file ngắn đi.
- Tách container tải dữ liệu khỏi component trình bày khi dự án làm vậy;
  component trình bày nhận props và dễ test.
- Props chảy xuống, event chảy lên. Đặt tên callback theo ý định (`onSubmit`,
  `onSelect`), không theo tên event của DOM.
- Ưu tiên composition (children, slot) hơn là nhiều props boolean bật tắt layout.
- Giữ component thuần khi render: không fetch, không subscribe, không thay đổi dữ liệu trong
  thân render; dùng cơ chế effect hoặc lifecycle của framework.
- Dùng key ổn định từ ID của dữ liệu trong danh sách, không bao giờ dùng chỉ số mảng cho danh sách xếp lại được.
- Chỉ bóc logic dùng lại ra thành hook hoặc composable khi đã có chỗ dùng thứ hai.

## State nằm ở đâu

Chọn chỗ ở hẹp nhất mà vẫn chạy được:

| Loại | Chỗ ở |
| --- | --- |
| Giá trị chỉ một component dùng | state cục bộ của component |
| Giá trị dùng chung giữa các component cùng cấp | đưa lên component cha gần nhất |
| Giá trị suy ra được từ state hay props khác | tính nó ra; đừng lưu lại |
| Dữ liệu từ server | cache lấy dữ liệu của dự án, không phải state toàn cục |
| Đáng nằm trên URL (filter, tab, trang, ID đang chọn) | tham số route hoặc query string |
| Dữ liệu nhập trong form | state của form (cục bộ hoặc thư viện form của dự án) |
| Thực sự dùng toàn app (theme, session, locale) | context hoặc store của dự án |

- State bị trùng lặp sẽ lệch nhau. Nếu hai chỗ giữ cùng một sự thật, hãy giữ một nguồn và
  suy ra chỗ kia.
- Tránh đồng bộ state bằng effect (`useEffect` copy props vào state); hãy suy ra
  trong lúc render hoặc reset bằng key.
- Context render lại mọi consumer khi đổi; hãy tách context hoặc dùng store nếu một
  giá trị đổi liên tục được dùng chung rộng khắp.
- Đặt lên URL những state đáng sống sót qua lần tải lại hoặc đáng chia sẻ được.
- Không thêm thư viện store toàn cục mà không có quyết định của chủ sở hữu.

## Effect và lifecycle

- Dùng effect để đồng bộ với thứ gì bên ngoài (subscription, timer, DOM
  API), không để tính giá trị hay phản ứng với event của người dùng.
- Mọi subscription, listener, timer, hay observer đều phải được dọn.
- Xử lý việc effect bị gọi hai lần ở strict mode khi dev: effect phải an toàn khi chạy,
  dọn, rồi chạy lại.

## Form

- Dùng cách làm form của dự án (form native, input có kiểm soát, hoặc thư viện form
  của nó) một cách nhất quán.
- Mọi input đều có nhãn. Hiện lỗi validate ngay cạnh field và tóm tắt lại
  khi submit; chuyển focus tới lỗi đầu tiên.
- Validate ở client để phản hồi nhanh; server vẫn là nơi có thẩm quyền.
- Vô hiệu hóa hoặc chặn hành động submit khi đang chờ để tránh submit hai lần;
  hiện tiến trình.
- Giữ lại dữ liệu đã nhập khi submit thất bại.
- Coi phản hồi validate của server là nguồn của các lỗi theo field.

## Kiểu và hợp đồng

- Khai kiểu cho props và event bằng hệ kiểu của dự án (TypeScript, PropTypes, hoặc
  kiểu riêng của framework).
- Chỉ chia sẻ kiểu của phản hồi API với backend qua cơ chế đang có của dự án
  (kiểu được sinh ra, package dùng chung); không copy tay những kiểu rồi sẽ lệch nhau.
- Thu hẹp dữ liệu có thể null ngay tại biên để component nhận được giá trị đầy đủ hoặc một
  trạng thái rỗng tường minh.

## Styling

- Dùng hệ thống styling của dự án (CSS module, utility class, CSS-in-JS, style có
  phạm vi) và các design token. Không trộn thêm cách thứ hai.
- Tránh giá trị thần kỳ viết thẳng cho khoảng cách và màu khi đã có token.
