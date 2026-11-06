# Hiệu năng frontend

Đọc khi một màn hình chậm, bundle phình ra, hoặc ảnh và danh sách quá nặng.

Đo trước, rồi đổi một thứ, rồi đo lại trong cùng điều kiện
(cùng chế độ build, cùng thiết bị hay cấu hình giới hạn, cùng lượng dữ liệu). Bản build dev
chậm hơn và nhiễu hơn bản production; muốn khẳng định điều gì thì hãy profile bản production.

## Đo cái gì

- Core Web Vitals cho trải nghiệm trang: Largest Contentful Paint (tải),
  Interaction to Next Paint (độ đáp ứng), Cumulative Layout Shift (độ ổn định).
  Dùng công cụ đang có của dự án (Lighthouse, panel performance của browser, một dashboard
  RUM) và báo lại điều kiện đo.
- Chi phí render: profiler của framework (React DevTools Profiler, Vue DevTools) để
  thấy component nào render, bao nhiêu lần, và mất bao lâu.
- Kích thước bundle: công cụ phân tích hoặc output thống kê của build cho các route bị ảnh hưởng.
- Mạng: biểu đồ thác nước của route; tìm những request nối tiếp nhau và payload lớn.

Dùng ngân sách mà dự án đã định ra. Đừng tự nghĩ ra một ngưỡng cố định; hãy báo
các con số trước và sau.

## Chi phí render

- Trước hết hãy bỏ những việc không cần: state đặt quá cao làm render lại cả vùng rộng,
  dữ liệu suy ra bị tính lại trong lúc render trên dữ liệu nhập lớn, effect đặt state ở
  mỗi lần render, và giá trị context bị tạo lại mỗi lần render.
- Đưa state xuống đúng chỗ nó được dùng, hoặc chia component ra để state đổi nhanh
  chỉ render lại một nhánh nhỏ.
- Chỉ ghi nhớ (`memo`, `useMemo`, `useCallback`, giá trị computed) ở nơi
  profiler cho thấy một chi phí đo được, hoặc ở nơi compiler hay luật lint của dự án
  đã xử lý giúp. Ghi nhớ mà không đo thì thêm phức tạp và có thể che bug do
  phụ thuộc đã cũ.
- Virtual hóa danh sách dài (hàng trăm dòng hoặc hơn) theo cách đang có của
  dự án; phân trang khi chưa đáng để virtual hóa.
- Chỉ đưa phần tính toán nặng ra khỏi luồng chính (một web worker) khi đã đo.
- Hoãn các cập nhật không gấp bằng API transition hay lập lịch của framework khi
  gõ chữ thấy có cảm giác trễ.

## Bundle và tải

- Chia theo route; lazy-load những component nặng, ít dùng (editor, biểu đồ, bản đồ)
  đặt sau tương tác hoặc view thực sự cần chúng.
- Kiểm tra một phụ thuộc mới tốn bao nhiêu trước khi đề xuất nó; ưu tiên API của nền tảng và
  các phụ thuộc đang có. Thêm một cái là quyết định của chủ sở hữu.
- Chỉ import những gì bạn dùng; tránh import kiểu barrel làm mất tác dụng tree shaking khi
  bundler xử lý chúng không tốt.
- Đừng vô tình gửi code chỉ dành cho server, file dữ liệu lớn, hay source map
  xuống client.
- Preload các tài nguyên quan trọng (ảnh LCP, font chính) khi số đo cho thấy có
  độ trễ; đừng preload mọi thứ.
- Render ở server hay sinh tĩnh giúp cải thiện first paint cho các trang nội dung; xem
  frameworks.md.

## Ảnh và media

- Phục vụ ảnh đã đúng kích thước, đã nén, ở các định dạng hiện đại, qua pipeline hay
  component ảnh của dự án.
- Luôn đặt width và height (hoặc tỉ lệ khung) để tránh dịch layout.
- Lazy-load các ảnh nằm dưới màn hình đầu; không lazy-load ảnh LCP.
- Dùng `srcset` và `sizes` responsive để màn hình nhỏ tải file nhỏ.
- Ưu tiên CSS hoặc SVG cho icon và hình đơn giản.

## Độ ổn định layout và độ đáp ứng

- Dành sẵn chỗ cho nội dung bất đồng bộ, quảng cáo, và nội dung nhúng.
- Tránh chèn nội dung lên phía trên nội dung đang có sau khi tải xong.
- Tải font với một chiến lược hiển thị tránh chữ vô hình, dùng thiết lập font
  của dự án.
- Giữ các handler nhập liệu ngắn gọn; chia nhỏ task dài; tránh giật layout (đọc
  layout rồi ghi style trong một vòng lặp).

## Báo cáo

- Nêu rõ chỉ số, công cụ, chế độ build, thiết bị hay cấu hình giới hạn, lượng dữ liệu, và
  giá trị trước và sau.
- Nếu một thay đổi không làm chỉ số đo được nhúc nhích, hãy hoàn tác nó chứ đừng giữ lại
  cho chắc.
