---
name: web-testing
description: "Viết và chạy test web bằng công cụ của dự án: e2e (kiểu Playwright), unit và component (kiểu Vitest hay Jest), kiểm thị giác và accessibility, test hiệu năng và tải (kiểu k6), và các kiểm tra bảo mật cơ bản, chỉ trên môi trường test. Dùng khi thêm, sửa, hay chạy các bộ test web. Không dùng cho thiết kế test (test-strategy) hay chẩn đoán lỗi (bug-loop)."
---

# Test web

## Khi nào dùng

- Thêm hoặc cập nhật test e2e, unit, component, thị giác, hay accessibility cho một app
  web.
- Làm cho một bộ test web chập chờn hay chậm trở nên tin cậy ở tầng công cụ (selector, chờ,
  cách ly, fixture, trace).
- Chạy một mốc hiệu năng cơ sở hoặc test tải trên một môi trường test.
- Chạy các kiểm tra bảo mật cơ bản đã được phép (audit phụ thuộc, kiểm header, test luồng
  auth) trên một môi trường test.
- Một reviewer chỉ đọc được nhờ đánh giá code test (chỉ tư vấn).

## Không dùng cho

- Quyết định test cái gì, ở tầng nào, và vì sao: dùng test-strategy.
- Một test fail hay hồi quy mà chưa rõ nguyên nhân: dùng bug-loop.
- Audit bảo mật hay review mối đe dọa của code: dùng security-review.
- Dựng chính tính năng đang được test: dùng frontend-development hay backend-development.
- Chọn framework test, runner, hay dịch vụ mới: quyết định của chủ sở hữu.

## Điều kiện tiên quyết

- Đường dẫn sở hữu và tiêu chí nghiệm thu trong brief; ALP.md và chỉ dẫn của dự án.
- Công cụ test và các lệnh đang có, đọc từ phần scripts của `package.json` (hoặc
  tương đương), file config của runner, và config CI. Không suy ra từ tên thư mục.
- Các test đang có gần chỗ thay đổi. Chúng định ra cách đặt tên, fixture, helper, và cách
  app được khởi động để test.
- Một môi trường test: dev server cục bộ, bản build preview, hoặc một bản
  deploy test riêng. Không bao giờ là production trừ khi chủ sở hữu cho phép tường minh.
- Tài khoản và dữ liệu test lấy từ fixture hay script seed của dự án; không bao giờ dùng thông tin
  đăng nhập của người dùng thật.

## Quy trình

1. Lấy các ca cần bao phủ từ brief hoặc từ đầu ra của test-strategy. Nếu chưa có,
   hãy liệt kê các hành vi người dùng thấy được và chuyển việc chọn lên trên khi nó quan trọng.
2. Chọn tầng rẻ nhất chứng minh được từng ca: unit cho logic, component cho
   render và tương tác, e2e cho một ít luồng liên trang then chốt. Đọc
   unit-and-component.md hoặc e2e.md.
3. Dùng lại fixture, page object, factory, và helper đang có trước khi viết cái
   mới.
4. Viết mỗi test sao cho nó độc lập: dữ liệu riêng, không phụ thuộc thứ tự, không dùng chung
   state thay đổi được, dọn dẹp hoặc có state mới cho mỗi test.
5. Truy vấn phần tử theo vai trò, nhãn, hay chữ thấy được; chờ theo điều kiện, không bao giờ
   chờ theo thời gian ngủ cố định.
6. Chỉ thêm kiểm thị giác hay accessibility ở nơi dự án đã chạy chúng hoặc
   brief yêu cầu; giữ snapshot nhỏ và tất định.
7. Với việc hiệu năng hay tải, hãy đọc performance-testing.md; lập mốc cơ sở
   trước khi so sánh, và xin phép tường minh cho bất kỳ đích dùng chung nào.
8. Với kiểm tra bảo mật, hãy đọc security-testing.md; chỉ chạy những kiểm tra an toàn trên
   môi trường bạn được phép test.
9. Chạy các test mới và bộ test xung quanh bằng lệnh của dự án. Chạy một
   test e2e mới vài lần ở máy cục bộ để lộ ra sự chập chờn.
10. Handoff: test đã thêm hay đổi, lệnh kèm kết quả, các lần chạy kiểm chập chờn, chỗ chứa
    artifact (trace, báo cáo), các khoảng trống, và những gì cần chủ sở hữu quyết định.

## Ràng buộc

- Trước hết hãy theo stack test và quy ước đang có của dự án. Playwright,
  Cypress, Vitest, Jest, Testing Library, axe, k6, hay Lighthouse chỉ là ví dụ, không phải
  khuyến nghị.
- Không thêm framework test, browser, plugin, hay dịch vụ mà không có quyết định của
  chủ sở hữu. Không tự động cài; nếu thiếu một binary browser hay một công cụ, hãy báo lại.
- Không bao giờ test tải, quét, hay thăm dò production hay hệ thống của bên thứ ba mà không có
  văn bản cho phép tường minh của chủ sở hữu.
- Không bao giờ dùng thông tin đăng nhập thật hay dữ liệu cá nhân; dùng tài khoản test và dữ liệu tổng hợp.
- Không làm yếu các assertion, không thêm retry, không skip test để bộ test pass; một test
  chập chờn hay fail thì chuyển sang bug-loop.
- Không cập nhật snapshot hay mốc cơ sở mà chưa kiểm rằng output mới đúng là
  hành vi mong muốn.
- Ở trong đường dẫn sở hữu. Sửa cấu hình CI là ngoài phạm vi trừ khi được giao.

## Kiểm chứng

- Test mới phải fail khi không có hành vi nó bao phủ (hoặc khi hành vi đó bị vỡ) và pass
  khi có.
- Test e2e mới pass qua nhiều lần chạy lặp lại (ví dụ ba tới năm lần) mà không cần retry.
- Bộ test xung quanh vẫn pass với lệnh của dự án.
- Không có thời gian ngủ cố định, không phụ thuộc thứ tự, không có secret thật trong test mới.
- Kết quả hiệu năng kèm mốc cơ sở, điều kiện đo, và môi trường đích.

## Xử lý khi thất bại

- Thiếu công cụ hay browser, hoặc app không khởi động được ở đây: báo đúng lệnh
  và lỗi đó; không khẳng định là test đã chạy.
- Một test chập chờn: ghi lại trace hay log, rồi chuyển sang bug-loop để tìm nguyên nhân.
- Một test lộ ra bug của sản phẩm: báo nó kèm cách tái hiện; không sửa
  test cho khớp với hành vi sai.
- Chưa rõ việc cho phép với một đích tải hay bảo mật: dừng lại và chuyển lên trên.

## Tài liệu tham chiếu

- [references/e2e.md](references/e2e.md) — đọc khi viết hay làm ổn định test end-to-end trên browser (bước 2-5).
- [references/unit-and-component.md](references/unit-and-component.md) — đọc khi viết test unit hay component, mock, hay snapshot (bước 2-6).
- [references/performance-testing.md](references/performance-testing.md) — đọc khi chạy mốc hiệu năng cơ sở, ngân sách, hay test tải (bước 7).
- [references/security-testing.md](references/security-testing.md) — đọc khi chạy audit phụ thuộc, kiểm header, hay test luồng auth (bước 8).
