# Container

Đọc khi viết hay review một Dockerfile, file compose hoặc một lần build container.

## Base image

- Ghim base image theo tag phiên bản và, ở nơi dự án làm vậy, theo digest
  (`image:1.2.3@sha256:...`). Không bao giờ dựa vào `latest`.
- Ưu tiên base nhỏ nhất mà vẫn chạy được workload: biến thể slim hay distroless, hoặc một
  image OS tối giản. Khớp đúng libc mà ứng dụng cần (glibc hay musl) để tránh bất ngờ lúc chạy.
- Dùng cùng một họ base image qua các service khi dự án đã có một họ như vậy.
- Tính trước việc cập nhật base: ghi lại chỗ ghim phiên bản để có thể nâng nó một cách có chủ ý.

## Build nhiều tầng

- Tầng build: compiler, phụ thuộc dev, công cụ build. Tầng runtime: chỉ có artifact và
  các phụ thuộc lúc chạy.
- Chỉ copy những gì cần từ tầng build (`COPY --from=build /app/dist /app`).
- Cài phụ thuộc production từ lockfile bằng chế độ frozen hay clean-install của trình
  quản lý package.

## Thứ tự layer và cache

- Sắp từ thứ ít đổi nhất tới thứ đổi thường xuyên nhất: base, package hệ thống, manifest phụ thuộc và
  lockfile, lệnh cài phụ thuộc, rồi mới tới source.
- Gộp việc cài package và việc dọn cache vào cùng một layer; xóa cache của trình quản lý package.
- Dùng một `.dockerignore` loại trừ `.git`, `node_modules` hay tương đương, output build, file
  env cục bộ, artifact test và file của editor. Nó làm context nhỏ lại và giữ secret ở ngoài.
- Dùng cache mount lúc build nếu builder của dự án hỗ trợ và đã dùng chúng.

## Không phải root và quyền

- Tạo hoặc dùng một user không đặc quyền và chuyển sang nó bằng `USER` trước entrypoint.
- Những file app chỉ đọc thì nên thuộc root và không cho user của app ghi.
- Các đường dẫn cần ghi (temp, cache, upload) là những thư mục hay volume tường minh.
- Tránh chế độ privileged, networking của host và các capability thêm vào; nếu cần, hãy ghi rõ vì sao.
- Ưu tiên hệ thống file gốc chỉ đọc lúc chạy ở nơi nền tảng hỗ trợ.

## Không có secret trong layer

- Không bao giờ `COPY` file env, khóa hay file thông tin đăng nhập vào một image. Xóa chúng ở một layer sau
  cũng không loại chúng khỏi lịch sử.
- Không truyền secret qua `ARG` hay `ENV`; cả hai đều còn lại trong metadata của image.
- Với secret lúc build (token của registry riêng), hãy dùng tính năng secret mount của builder và
  xác nhận là secret không có trong image cuối.
- Secret lúc chạy đến từ kho secret của orchestrator hoặc từ môi trường được tiêm vào.
- Soi lịch sử và hệ thống file của image đã build để tìm file bị lộ, trước khi handoff.

## Hành vi lúc chạy

- Một process chính cho mỗi container. Dùng `ENTRYPOINT`/`CMD` dạng exec (mảng JSON) để tín hiệu tới được
  process; thêm một init tối giản nếu process không tự thu dọn process con.
- Xử lý SIGTERM: ngừng nhận việc mới, hoàn tất các request đang bay trong thời gian ân hạn, rồi thoát.
- Ghi log ra stdout/stderr, không ghi ra file bên trong container.
- Cấu hình qua biến môi trường với các giá trị mặc định đã được ghi rõ.
- Chỉ mở đúng những port mà service dùng.

## Healthcheck

- Liveness: process còn sống và không bị deadlock. Rẻ; không kiểm tra phụ thuộc.
- Readiness: đã phục vụ được lưu lượng (phụ thuộc tới được, đã khởi động xong). Dùng để chặn lưu lượng.
- Cài đặt thành một endpoint hay lệnh nhẹ với timeout ngắn. Hãy dùng các probe của orchestrator
  khi deploy lên một orchestrator; `HEALTHCHECK` trong Dockerfile chủ yếu dành cho Docker thuần và compose.
- Không để liveness phụ thuộc vào một service phía sau; sự cố ở đó sẽ khiến mọi replica bị khởi động lại.

## Label và metadata

- Thêm những label mà dự án dùng (repository nguồn, revision, phiên bản) để image truy vết được.
- Gắn tag cho image bằng một định danh bất biến (SHA của commit hay số phiên bản), không chỉ một tag di động.

## Compose và phát triển cục bộ

- Ghim image của các service trong file compose theo đúng cách đó.
- Giữ những tiện lợi chỉ dùng ở cục bộ (bind mount, port debug) trong một file override, không ở file gốc.
- Thông tin đăng nhập cục bộ trong compose đến từ một file env không commit, có liệt kê trong `.gitignore`.

## Lệnh kiểm chứng (điều chỉnh theo công cụ của dự án)

- Build: lệnh build của dự án hoặc `docker build` với context và target đang có.
- Kích thước và layer: soi kích thước image và lịch sử của nó; so với image trước đó.
- User: xác nhận user hiệu lực của container không phải root.
- Secret: tìm trong hệ thống file và lịch sử của image cuối xem có file env, khóa và token không.
- Quét: chạy công cụ quét lỗ hổng mà dự án đã dùng, nếu có; thêm một công cụ mới là
  quyết định của chủ sở hữu.
- Chạy: khởi động container, gọi healthcheck, gửi SIGTERM và xác nhận nó tắt sạch sẽ.
