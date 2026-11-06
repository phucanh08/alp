# Test unit và component

Đọc khi viết test unit hay component, mock, hay snapshot cho code web.

Ví dụ dùng Vitest hoặc Jest với truy vấn kiểu Testing Library; Vue Test Utils,
Svelte Testing Library, và Angular TestBed có cái tương đương. Hãy dùng runner,
môi trường (jsdom, happy-dom, hay chế độ browser thật), và file setup của dự án.

## Test unit

- Nhắm vào logic thuần: định dạng, parse, validate, reducer, máy trạng thái,
  selector, hàm tiện ích.
- Ca dạng bảng cho các biến thể dữ liệu nhập; gồm cả giá trị biên, giá trị rỗng, và
  dữ liệu nhập không hợp lệ.
- Không cần DOM hay mạng; nếu một test unit cần nhiều mock, có thể code cần một
  đường tách, hoặc test đó thuộc về một tầng khác.
- Kiểm soát thời gian và tính ngẫu nhiên bằng fake timer của runner hoặc đồng hồ được tiêm vào;
  khôi phục chúng sau mỗi test.

## Test component

- Render component với props thực tế và các provider nó cần (router,
  theme, query client, i18n) qua một helper test dùng chung nếu dự án có.
- Tương tác như một người dùng: gõ chữ, bấm, và hành động bàn phím kiểu user-event
  chứ không phát ra các event tổng hợp ở tầng thấp.
- Truy vấn theo vai trò, nhãn, và chữ; chỉ dùng test ID khi không có gì truy cập được.
- Khẳng định những gì người dùng thấy hoặc những gì component phát ra, không khẳng định state nội bộ,
  phương thức của instance, hay hook riêng tư.
- Bao phủ từng trạng thái thấy được: loading, rỗng, lỗi, thành công, disabled, và lỗi
  validate.
- Dùng truy vấn bất đồng bộ (`findBy...`, `waitFor`) cho các cập nhật bất đồng bộ; không bao giờ dùng
  khoảng chờ cố định.

## Mock

- Mock ở các biên: mạng (mock ở mức request, như handler kiểu MSW
  hoặc công cụ của dự án), timer, các API browser mà môi trường test không có.
- Ưu tiên một mock thực tế của tầng HTTP hơn là mock từng module mà component
  import.
- Không mock chính unit đang được test hay mock bản thân framework.
- Reset mock và handler giữa các test; những request không được xử lý và ngoài dự kiến thì nên làm
  test fail.
- Giữ dữ liệu mock sát với hình dạng API thật, tốt nhất là lấy từ type hay fixture dùng chung.

## Snapshot

- Tránh snapshot DOM lớn; chúng vỡ khi markup đổi dù chẳng liên quan, và rồi bị
  chấp nhận mà không ai review.
- Dùng snapshot inline nhỏ cho những output serialize ổn định (một chuỗi đã định dạng, một
  config được sinh ra).
- Hãy review mọi thay đổi snapshot như một thay đổi hành vi trước khi cập nhật nó.

## Cách ly và vệ sinh

- Mỗi test tự dựng state của nó; không phụ thuộc thứ tự.
- Dọn các component đã render, timer, và thay đổi toàn cục (runner thường tự
  dọn; hãy kiểm lại với các setup tự tạo).
- Không dùng mạng thật, không ghi file ngoài thư mục tạm, không có secret thật.
- Giữ test nhanh; bộ test chậm sẽ bị bỏ qua. Đánh dấu test chậm theo cách dự án làm.

## Độ bao phủ

- Dùng báo cáo coverage để tìm những nhánh chưa được test trong code đã đổi, không dùng nó như một
  chỉ tiêu phải đạt. Không thêm test không có assertion để nâng con số.

## Lưu ý về môi trường

- jsdom và những môi trường tương tự không có layout, không có CSS thật, và thiếu một số API
  (IntersectionObserver, ResizeObserver, matchMedia); hãy stub chúng trong setup hoặc test
  những hành vi phụ thuộc layout trên browser thật (e2e hoặc chế độ browser).
- Server component hay loader của framework có thể cần chính tiện ích test của
  framework hoặc cần một test e2e; hãy xem tài liệu framework cho phiên bản đã cài.

## Accessibility trong test component

- Truy vấn theo vai trò vốn đã phát hiện được việc thiếu tên và thiếu vai trò.
- Nếu dự án dùng một matcher kiểu axe, hãy chạy nó trên các trạng thái đã render với dialog
  và menu đang mở.
