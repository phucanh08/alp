# Framework, render, và routing

Đọc khi chọn SSR, SSG, hay CSR, server hay client component, hoặc chỗ đặt
routing.

Quy ước của framework đổi giữa các bản major. Hãy xác định đúng framework
và phiên bản từ `package.json` và lockfile, theo quy ước của chính
phiên bản đó, và xem tài liệu chính thức của nó (hoặc tài liệu và type của package đã
cài) trước khi dựa vào một API. Nếu dự án trộn quy ước cũ và mới (ví
dụ vừa pages router vừa app router), hãy theo cái đang dùng ở vùng bạn
đang sửa và không tự ý chuyển đổi nó.

## Các chế độ render

| Chế độ | Render ở đâu | Phù hợp cho | Cái giá |
| --- | --- | --- | --- |
| CSR (phía client) | trong browser | màn hình dạng app sau khi đăng nhập | first paint chậm hơn, SEO tùy crawler |
| SSR (mỗi request) | trên server mỗi request | nội dung cá nhân hóa hay tươi mới, SEO | tốn server, có độ trễ mỗi request |
| SSG (lúc build) | một lần khi build | nội dung ổn định, tài liệu, marketing | phải build lại hoặc revalidate để cập nhật |
| Static tăng dần / có revalidate | khi build, làm mới theo chu kỳ hay theo trigger | nội dung phần lớn tĩnh nhưng có đổi | có khoảng thời gian dữ liệu cũ |
| Streaming / một phần | server stream từng phần khi sẵn sàng | phần chậm trên bộ khung nhanh | trạng thái loading phức tạp hơn |

- Theo đúng chế độ mà các route xung quanh đang dùng, trừ khi brief yêu cầu đổi.
- Đổi chế độ render của một route ảnh hưởng tới cache, hosting, và SEO; hãy chuyển
  quyết định đó lên trên.

## Server component và client component

Áp dụng cho framework có tách server/client (React Server Component trong
app router của Next.js và tương tự; khái niệm tương đương ở Nuxt, SvelteKit, island của Astro).

- Server component: fetch dữ liệu, đọc config chỉ có ở server, render markup tĩnh,
  không gửi JS của component. Chúng không dùng được state client, effect, hay API browser.
- Client component: tính tương tác, state, effect, API browser. Đánh dấu chúng theo
  cách framework yêu cầu (ví dụ chỉ thị `"use client"`) ở vị trí càng thấp trong cây càng
  tốt, để phần lớn markup vẫn được render ở server.
- Props truyền từ server sang client phải serialize được; không truyền hàm hay
  instance của class.
- Không bao giờ import module chỉ dành cho server (client database, secret) vào code client.
  Dùng cơ chế chặn server-only của framework nếu nó có.
- Server action hay form action là endpoint công khai: hãy validate dữ liệu nhập và kiểm tra
  phân quyền trong chúng như với bất kỳ API nào.

## Hydration

- Server và client phải render ra cùng một markup ban đầu. Tránh dùng khi render các thứ như
  `Date.now()`, giá trị ngẫu nhiên, `window`, hay định dạng phụ thuộc locale mà không có
  dữ liệu nhập ổn định.
- Đọc các giá trị chỉ có ở browser sau khi mount, hoặc chỉ render chúng ở client qua
  cơ chế của framework.
- Coi cảnh báo hydration là bug.

## Quy ước routing

- Theo hệ thống routing của dự án: dựa trên file (Next.js, Nuxt, SvelteKit, Remix
  hay React Router ở chế độ framework) hoặc dựa trên config (React Router, Vue Router).
- Đặt phần tải dữ liệu ở nơi framework mong đợi (loader, server component,
  hàm `load`, route guard) để tránh thác nước request ở client.
- Dùng component link của framework cho điều hướng nội bộ, để prefetch và
  chuyển trang ở client hoạt động.
- Dùng cơ chế xử lý loading, lỗi, và không-tìm-thấy ở cấp route mà framework cung cấp.
- Giữ state thuộc URL (filter, phân trang, tab) trong tham số hoặc query string.
- Bảo vệ route ở server (middleware, loader) chứ không chỉ ở UI; chỉ redirect
  ở client thì không bảo vệ được dữ liệu.

## Môi trường và config

- Biến env công khai (tiền tố như `NEXT_PUBLIC_` hay `VITE_`) được nhúng vào
  bundle client; không bao giờ đặt secret vào chúng.
- Tôn trọng dạng output build của dự án (static export, Node server, edge runtime);
  API lúc chạy khác nhau giữa chúng.

## Khi không chắc

- Tìm route đang có gần nhất làm cùng loại việc đó và làm theo nó.
- Nếu tài liệu của phiên bản đã cài trái với ký ức hay với ví dụ, hãy theo tài liệu
  và ghi lại khác biệt đó trong handoff.
