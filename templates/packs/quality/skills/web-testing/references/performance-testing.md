# Test hiệu năng và test tải

Đọc khi chạy mốc hiệu năng cơ sở, ngân sách, hay test tải.

Ví dụ dùng script kiểu k6 cho phần tải và audit kiểu Lighthouse cho hiệu năng
trang; Artillery, Gatling, Locust, hay WebPageTest là tương đương. Hãy dùng
những công cụ dự án đã có.

## Xin phép trước đã

- Không bao giờ test tải hay gây áp lực lên production, một môi trường staging dùng chung, hay bất kỳ
  API bên thứ ba nào mà không có phép tường minh của chủ sở hữu, nêu rõ đích,
  khung thời gian, và mức tải tối đa.
- Dồn tải lên dịch vụ bên thứ ba (thanh toán, email, bản đồ) có thể vi phạm điều khoản của họ
  và tốn tiền; hãy stub chúng hoặc dùng sandbox của họ với các giới hạn của nó.
- Một test tải có thể trông như một cuộc tấn công với nhà cung cấp hosting; chủ sở hữu là người lo
  việc thông báo nếu cần.
- Đích mặc định: một bản build cục bộ hoặc một môi trường test riêng mà bạn kiểm soát.
- Dừng ngay nếu lỗi vọt lên trên một môi trường dùng chung hoặc có người dùng khác bị
  ảnh hưởng, và báo lại.

## Xác định câu hỏi

- Nêu rõ bạn đang đo cái gì và vì sao: kiểm hồi quy, ước lượng năng lực,
  độ trễ dưới mức tải dự kiến, hay chạy dài để tìm rò rỉ.
- Chọn loại test: smoke (tải rất nhỏ, kiểm chính script), load (lưu lượng dự kiến),
  stress (vượt mức dự kiến, tìm điểm vỡ), spike (bùng lên đột ngột), soak
  (tải đều trong thời gian dài).
- Dùng tình huống thực tế: đúng tỉ lệ pha trộn endpoint và hành trình người dùng mà lưu lượng thật
  có, thời gian nghĩ giữa các bước, payload và lượng dữ liệu thực tế.

## Mốc cơ sở

- Đo một mốc cơ sở trên bản main hay bản release hiện tại, trong cùng môi trường,
  trước khi test một thay đổi.
- Giữ điều kiện giống nhau giữa các lần chạy: cỡ môi trường, lượng dữ liệu, chế độ
  build, cấu hình mạng, cache nóng hay nguội, thời lượng test.
- Chạy nhiều hơn một lần; báo cả độ phân tán, không chỉ một lần chạy tốt nhất.
- Ghi lại điều kiện cùng với mỗi kết quả để có thể tái hiện.

## Chỉ số

- Server và API: các phân vị độ trễ (p50, p95, p99) thay vì giá trị trung bình,
  thông lượng, tỉ lệ lỗi, và độ bão hòa (CPU, bộ nhớ, kết nối, độ sâu hàng đợi) nếu
  quan sát được.
- Hiệu năng trang: Core Web Vitals (LCP, INP, CLS), thời gian tới byte đầu tiên, tổng
  kích thước truyền, và các task dài, dưới một cấu hình thiết bị và mạng đã nêu rõ.
- Tách giới hạn của công cụ phía client khỏi giới hạn của server; một máy phát tải đang 100% CPU
  cho ra những con số vô nghĩa.

## Ngân sách và ngưỡng

- Dùng ngân sách mà dự án đã định ra (kích thước bundle, LCP, độ trễ p95, tỉ lệ lỗi).
- Nếu chưa có, hãy báo các giá trị đo được và đề xuất ngân sách cho chủ sở hữu; đừng
  tự nghĩ ra ngưỡng pass/fail rồi trình bày chúng như yêu cầu.
- Mã hóa các ngưỡng đã thống nhất vào cơ chế threshold của công cụ, để một lần chạy fail
  một cách khách quan.

## Script

- Giữ script trong thư mục test của dự án, theo quy ước của dự án.
- Tham số hóa URL đích, số người dùng, và thời lượng qua biến môi trường;
  mặc định trỏ tới đích cục bộ hay đích test, không bao giờ production.
- Dùng tài khoản test và dữ liệu tổng hợp; không bao giờ dùng thông tin đăng nhập thật. Tạo và dọn
  dữ liệu test mà lần chạy đó cần.
- Kiểm cả phản hồi (status, một field quan trọng), không chỉ kiểm là request đã trả về;
  lỗi nhanh trông giống như độ trễ tốt.
- Tăng tải dần dần; có một chặng smoke ngắn trước khi vào tải đầy.

## Đọc hiểu kết quả

- So với mốc cơ sở trong cùng điều kiện; coi những chênh lệch nằm trong
  độ phân tán giữa các lần chạy là nhiễu.
- Tìm chỗ độ trễ bắt đầu bật lên khi tải tăng; đó là giới hạn năng lực.
- Đối chiếu với chỉ số và log của server ở nơi có, để xác định điểm nghẽn,
  rồi giao việc chẩn đoán cho bug-loop hoặc cho skill phụ trách (databases,
  backend-development, frontend-development).

## Báo cáo

- Môi trường đích và tham chiếu tới việc cho phép, công cụ và phiên b��n, tình huống, cấu hình
  tải, thời lượng, lượng dữ liệu.
- Kết quả mốc cơ sở và kết quả mới kèm các phân vị, tỉ lệ lỗi, và độ phân tán.
- Các quan sát về điểm nghẽn, có ghi rõ là bằng chứng hay là suy luận.
- Những gì chưa chạy và vì sao.
