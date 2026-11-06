# Lấy dữ liệu

Đọc khi tải, cache, thay đổi, hoặc làm mới dữ liệu server, hoặc khi xử lý tranh chấp.

Dùng cơ chế đang có của dự án: loader hay server component của framework, một thư viện
query-cache (TanStack Query, SWR, Apollo, RTK Query là các ví dụ), hoặc fetch thuần
gói trong một client dùng chung. Không thêm cơ chế thứ hai.

## Mọi request đều có bốn trạng thái

- Loading: hiện skeleton hoặc spinner có kích thước như nội dung cuối để tránh dịch
  layout. Với lần tải nhanh, hoãn chỉ báo một chút để nó không nháy.
- Lỗi: hiện một thông báo có ích và một hành động thử lại. Phân biệt "không tìm thấy",
  "không được phép", "offline", và "lỗi server" khi API cho phép. Không hiện object
  lỗi thô hay stack trace.
- Rỗng: một trạng thái riêng kèm hướng dẫn hoặc một hành động, không phải một vùng trắng.
- Thành công: render dữ liệu; giữ dữ liệu trước đó hiển thị trong lúc làm mới ở nền thay vì
  nháy trở về trạng thái loading.

Cũng hãy tính tới dữ liệu một phần (một số mục bị lỗi) và dữ liệu cũ (hiện ra trong lúc
đang làm mới).

## Fetch ở đâu

- Ưu tiên tải ở cấp route hoặc phía server khi framework hỗ trợ, để dữ liệu
  bắt đầu tải cùng lúc với điều hướng và tránh được thác nước request.
- Khởi động các request độc lập song song; không xâu chúng lại trong các component lồng nhau
  trừ khi cái này phụ thuộc cái kia.
- Không fetch trong lúc render. Ở client component hãy dùng thư viện cache hoặc một effect
  có dọn dẹp.
- Giữ API client trong một module: base URL, header hay cookie auth, parse JSON,
  và chuẩn hóa lỗi.

## Cache

- Đặt key cho dữ liệu cache theo mọi thứ ảnh hưởng tới phản hồi (tài nguyên, ID, filter,
  trang, người dùng hay tenant).
- Quyết định độ tươi cho từng tài nguyên: dữ liệu được coi là tươi trong bao lâu, và khi nào fetch lại
  (khi focus, khi kết nối lại, theo chu kỳ, hoặc khi vô hiệu tường minh).
- Vô hiệu hoặc cập nhật các key bị ảnh hưởng sau một mutation; không để danh sách còn cũ
  sau khi tạo hay xóa.
- Xóa cache riêng của người dùng khi logout hoặc đổi tài khoản.
- Tôn trọng các header cache HTTP mà backend đã đặt; không cache những phản hồi mang tính
  cá nhân vào cache dùng chung.

## Tranh chấp (race condition)

- Một phản hồi đến trước nhưng chậm hơn không được ghi đè lên phản hồi mới hơn. Hãy hủy request
  trước đó (AbortController hoặc cơ chế hủy của thư viện) hoặc bỏ qua kết quả có key
  không còn khớp với dữ liệu nhập hiện tại.
- Debounce việc tìm kiếm khi đang gõ và hủy các request đang bay khi có dữ liệu nhập mới.
- Bỏ qua kết quả sau khi unmount; dọn subscription và abort các request đang bay.
- Chặn việc submit mutation hai lần: vô hiệu hóa khi đang chờ, và gửi một
  idempotency key nếu API hỗ trợ.

## Mutation

- Hiện trạng thái đang chờ trên chính control đã khởi động mutation đó.
- Chỉ cập nhật lạc quan khi thất bại là hiếm và đảo lại được; hoàn tác khi lỗi
  và nói cho người dùng biết.
- Khi server trả lỗi validate, hãy map chúng về từng field.
- Sau khi thành công, cập nhật hoặc vô hiệu cache, rồi chuyển focus hoặc thông báo
  kết quả cho công nghệ trợ giúp.

## Lỗi và thử lại

- Chỉ tự động thử lại các lần đọc idempotent, với giới hạn nhỏ và có backoff. Không
  tự động thử lại mutation trừ khi chúng idempotent.
- Xử lý 401 ở một chỗ duy nhất (refresh hoặc chuyển tới trang login theo quy ước của dự án).
- Dùng error boundary hoặc route lỗi của framework cho những lỗi bất ngờ, để một
  widget vỡ không làm trắng cả trang.
- Báo lỗi qua hệ thống giám sát đang có của dự án, không kèm dữ liệu cá nhân hay
  token.

## Bảo mật

- Không bao giờ nhúng secret hay API key riêng vào code client; hãy đi qua
  backend.
- Chỉ gửi thông tin đăng nhập tới các origin của chính dự án.
- Không tin các kiểm tra phía client về phân quyền; server mới là nơi thực thi.

## Ghi chú về test

- Mock mạng ở tầng HTTP (công cụ mock request của dự án) chứ không
  mock phần bên trong của thư viện cache.
- Test cả bốn trạng thái và một tình huống chậm-rồi-nhanh cho các input tìm kiếm.
