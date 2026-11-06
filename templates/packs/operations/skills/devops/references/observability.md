# Observability

Đọc khi thêm hay review log, metric, trace, SLO, alert hay dashboard.

Hãy dùng stack telemetry mà dự án đã có. Thêm một agent, nhà cung cấp, collector hay gói
trả phí là quyết định của chủ sở hữu.

## Log

- Có cấu trúc (JSON hoặc định dạng của dự án) với các field nhất quán: timestamp, level, service,
  môi trường, phiên bản, ID của request hay của trace, tên event, kết quả, thời lượng.
- Các level phải có ý nghĩa: error = cần ai đó để ý, warn = suy giảm nhưng đã xử lý được, info = những
  event nghiệp vụ hay vòng đời đáng kể, debug = mặc định tắt ở production.
- Hãy ghi log dạng event, không kể chuyện: `event=payment_failed reason=card_declined order_id=...`.
- Không bao giờ ghi log secret, token, mật khẩu, số thẻ đầy đủ hay dữ liệu cá nhân không cần thiết. Hãy che
  ngay tại logger, không chỉ dựa vào quy ước.
- Ghi ra stdout/stderr trong container; để nền tảng thu thập và chuyển đi.
- Kiểm soát lượng log: lấy mẫu các log thành công ồn ào, không lấy mẫu các log lỗi. Tránh ghi log trong vòng lặp chặt.

## Metric

- Request (RED): tần suất, lỗi, thời lượng cho mọi endpoint service hay consumer hàng đợi.
- Tài nguyên (USE): mức sử dụng, độ bão hòa, lỗi cho CPU, bộ nhớ, đĩa, pool kết nối, hàng đợi.
- Những tín hiệu nghiệp vụ cho thấy tác động tới người dùng: số lần đăng ký xong, số đơn đã đặt, số job đã xử lý.
- Thời lượng thì dùng histogram, không dùng giá trị trung bình; hãy báo p50, p95, p99.
- Giữ lực lượng của label có giới hạn: không dùng ID người dùng, ID request hay URL thô làm label; hãy dùng mẫu route.
- Đặt tên metric kèm đơn vị và theo quy ước đặt tên của dự án.

## Trace

- Truyền ngữ cảnh qua các biên service bằng những header chuẩn mà stack dùng
  (W3C trace context là phổ biến); kèm ID của trace vào log để liên kết chúng lại.
- Tạo span cho những đơn vị đáng quan tâm: request vào, các lệnh gọi ra, truy vấn database, publish và
  consume hàng đợi. Tránh tạo một span cho mỗi hàm.
- Ghi những thuộc tính giúp chẩn đoán (route, status, số lần retry), không ghi payload.
- Lấy mẫu ở mức mà backend chịu được; hãy giữ lại các trace lỗi và trace chậm khi công cụ hỗ trợ.

## SLO

- Hãy bắt đầu từ hành vi người dùng thấy được: độ khả dụng (request thành công / request hợp lệ) và
  độ trễ (tỉ lệ request dưới một ngưỡng), cho từng hành trình người dùng quan trọng.
- Định nghĩa rõ: công thức SLI, mục tiêu (ví dụ 99.5% trong 28 ngày), khung thời gian, và cái gì được tính là hợp lệ.
- Ngân sách lỗi là 100% trừ đi mục tiêu. Mức tiêu ngân sách định hướng nhịp phát hành và việc làm độ tin cậy;
  còn đội phản ứng với nó thế nào là chính sách của chủ sở hữu.
- Chọn mục tiêu từ hiệu năng đang đo được và từ nhu cầu người dùng, không chọn những con số tròn trịa mang tính khát vọng.
- Mỗi service chỉ vài SLO; mỗi cái đều có một người sở hữu.

## Alert hành động được

- Mỗi lần gọi người phải trả lời được: cái gì đang vỡ với người dùng, nặng tới đâu, và phải làm gì trước.
- Gọi người theo triệu chứng (mức tiêu SLO, tỉ lệ lỗi, độ trễ, độ bão hòa gần cạn), không gọi theo mọi
  nguyên nhân (CPU một host vọt lên, một lần retry thất bại).
- Ưu tiên alert theo tốc độ tiêu ngân sách trên nhiều khung thời gian cho SLO: khung nhanh bắt các sự cố gắt, khung chậm
  bắt sự suy giảm đều đều.
- Mỗi alert đều có: tên rõ ràng, mức nghiêm trọng, ngưỡng và thời lượng, người sở hữu, link runbook hay bước
  chẩn đoán đầu tiên, và một link dashboard.
- Những điều kiện không gấp thì thành ticket hay báo cáo, không thành cuộc gọi người.
- Hãy test alert: kích hoạt nó trong môi trường không phải production hoặc bằng một điều kiện tổng hợp và xác nhận
  là nó được gửi tới và runbook là đúng.
- Hãy xem lại những alert đã nổ mà không ai làm gì hoặc bị tắt tiếng; hãy chỉnh lại hoặc xóa chúng.

## Dashboard

- Một trang tổng quan cho mỗi service: trạng thái SLO, các chỉ số RED, độ bão hòa, có đánh dấu các lần deploy gần đây.
- Dashboard đi sâu cho từng phụ thuộc. Cùng khoảng thời gian và cùng đơn vị trên khắp các panel.
- Ưu tiên ít panel nhưng ghi nhãn tốt, hơn là nhiều panel không ai giải thích.

## Runbook

- Ngắn: triệu chứng, tác động, các bước kiểm đầu tiên (dashboard, truy vấn log), các cách giảm thiểu an toàn (rollback,
  scale, tắt flag), đường chuyển lên.
- Những cách giảm thiểu có làm đổi production thì vẫn cần đúng sự cho phép mà runbook nêu ra.

## Thêm telemetry cho một thay đổi

- Xác định những chế độ lỗi mới mà thay đổi đó đưa vào và làm cho từng cái thấy được: một event log,
  một metric lỗi, hoặc một thuộc tính span.
- Thêm tín hiệu đó trước hoặc cùng lúc với thay đổi, để có thể theo dõi được lần rollout.
- Nêu trong handoff những tín hiệu nào cho thấy thành công và những tín hiệu nào cho thấy thất bại.

## Checklist review

- Không có secret hay dữ liệu cá nhân quá mức trong log, label hay span.
- Lực lượng label có giới hạn; độ trễ dùng histogram.
- Alert dựa trên triệu chứng, có người sở hữu, có runbook; không có alert nào mà không kèm hành động.
- SLO được định nghĩa từ các hành trình người dùng với mốc cơ sở đã đo.
