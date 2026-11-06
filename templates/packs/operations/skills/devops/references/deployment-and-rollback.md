# Deploy và rollback

Đọc khi lên kế hoạch rollout, sắp thứ tự migration database, hoặc viết và diễn tập một lần rollback.

Đầu ra mặc định là bản kế hoạch. Thực thi bất kỳ bước nào lên môi trường dùng chung hay production
đều cần phép tường minh cho đúng bước đó.

## Chọn một chiến lược

| Chiến lược | Cách làm | Phù hợp với | Cái giá |
|---|---|---|---|
| Rolling | Thay instance theo từng lô | Service không giữ state, các phiên bản tương thích nhau | Lẫn nhiều phiên bản trong lúc rollout |
| Blue/green | Chạy stack mới song song stack cũ, chuyển lưu lượng một lần | Rollback nhanh và gọn; đổi config hay runtime | Cần gấp đôi năng lực trong lúc chuyển |
| Canary | Đẩy một phần nhỏ lưu lượng sang bản mới, rồi mở rộng dần | Thay đổi rủi ro, lưu lượng lớn, có chỉ số tốt | Cần chia lưu lượng và cần so sánh |
| Feature flag | Đưa code lên nhưng tắt, rồi bật theo từng nhóm | Thay đổi hành vi độc lập với việc deploy | Nợ flag; cần dọn về sau |
| Recreate | Tắt bản cũ, bật bản mới | Môi trường dev hay job theo lô, nơi downtime không sao | Có downtime |

Hãy dùng chiến lược mà nền tảng và dự án đã hỗ trợ. Đưa vào việc chia lưu lượng, một
dịch vụ flag hay thêm môi trường là quyết định của chủ sở hữu.

## Nội dung của một kế hoạch rollout

- Định danh phiên bản hay artifact đang được deploy, và cái đang bị thay thế.
- Tiền điều kiện: test đã pass, đã xác nhận migration tương thích, người trực đã biết nếu dự án
  yêu cầu, và khung thời gian thay đổi nếu có.
- Các bước kèm đúng lệnh hay đúng hành động pipeline, theo thứ tự.
- Tín hiệu thành công: những chỉ số, log hay kiểm tra nào, kèm ngưỡng và thời gian theo dõi cho mỗi bước.
- Tiêu chí hủy: cái gì làm khởi động rollback (tỉ lệ lỗi, độ trễ, độ bão hòa, healthcheck fail).
- Các bước rollback (bên dưới) và ai được phép thực hiện chúng.

## Canary và giao hàng tăng dần

- Các bước như 1% rồi 5%, 25%, 50%, 100%, kèm một khoảng theo dõi ở mỗi mức. Hãy dùng cái nền tảng hỗ trợ.
- So canary với mốc cơ sở trên cùng các chỉ số trong cùng một khoảng thời gian, không so với
  hôm qua.
- Tự động hủy khi vượt ngưỡng rõ rệt, ở nơi có công cụ; nếu không, hãy chỉ định một người theo dõi.
- Bảo đảm canary nhận được lưu lượng mang tính đại diện (các vùng, các loại client).

## Blue/green

- Làm nóng stack mới và chạy các kiểm tra smoke trước khi chuyển.
- Giữ stack cũ vẫn chạy và không chạm tới nó cho tới khi hết khoảng theo dõi.
- Chuyển đi và chuyển lại bằng cùng một cơ chế (load balancer, DNS với TTL thấp, router).
- Để ý các kết nối sống lâu, session và cache khi chuyển qua.

## Thứ tự migration database (mở rộng rồi thu hẹp)

Code và schema phải tương thích nhau suốt cả lần rollout và cả lần rollback.

1. **Mở rộng:** thêm cột, bảng hay index mới theo cách tương thích ngược (cho phép null hoặc có
   giá trị mặc định; tạo index mà không khóa lâu, ở nơi database hỗ trợ).
2. **Deploy code** ghi cả hình dạng cũ và mới, hoặc đọc hình dạng mới và quay về cũ khi cần.
3. **Backfill** theo từng lô nhỏ có điều tiết; làm nó tiếp tục được và idempotent.
4. **Chuyển phần đọc** sang hình dạng mới; rồi kiểm chứng.
5. **Thu hẹp:** bỏ cột cũ hay các đường code cũ ở một bản release sau, sau khi hết khung rollback.

- Không bao giờ gộp một migration phá hủy với chính thay đổi code phụ thuộc vào nó.
- Hãy ước lượng tác động khóa và thời lượng trên dữ liệu cỡ production trước khi chạy.
- Backup hay snapshot trước những bước không đảo lại được, và xác nhận là quy trình phục hồi chạy được.
- Migration chạy một lần, từ một chỗ duy nhất (job pipeline hay bước release), không chạy từ mỗi instance.

## Rollback

- Ứng dụng: deploy lại artifact bất biến trước đó qua pipeline bình thường, hoặc chuyển
  lưu lượng về (blue/green), hoặc giảm canary về 0%.
- Cấu hình và flag: hoàn tác đúng thay đổi đó; giữ config có phiên bản.
- Schema: với mở rộng/thu hẹp, code cũ vẫn chạy được, nên chỉ cần rollback code. Một lần rollback cần tới
  một migration đi xuống là rất rủi ro; hãy ưu tiên sửa tiến lên, trừ khi đường đi xuống đã được test.
- Hạ tầng: hoàn tác thay đổi IaC rồi chạy plan; kiểm xem có tài nguyên nào không tạo lại được
  (kho dữ liệu, IP tĩnh) trước khi destroy bất cứ gì.
- Dữ liệu do bản mới ghi ra phải vẫn đọc được bởi bản cũ, hoặc kế hoạch rollback
  phải nói rõ nó được xử lý thế nào.

## Diễn tập

- Hãy diễn tập rollback trong một môi trường không phải production với những thay đổi mới, rủi ro hoặc chạm tới
  schema. Ghi lại lệnh, thời lượng và kết quả.
- Nếu không diễn tập được, hãy ghi vào kế hoạch là "rollback chưa diễn tập" và nêu rủi ro.
- Bấm thời gian từng bước; một lần rollback chậm hơn mức downtime chịu được thì cần một chiến lược khác.

## Sau khi deploy

- Theo dõi các tín hiệu thành công trong khoảng thời gian đã nêu; xác nhận ngân sách lỗi và các alert đều im.
- Ghi lại cái gì đã được deploy, khi nào, bởi ai, và mọi chỗ lệch khỏi kế hoạch.
- Lên lịch cho bước thu hẹp và việc dọn flag.
