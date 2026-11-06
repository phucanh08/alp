---
name: test-strategy
description: "Thiết kế test cho một feature hay một thay đổi theo hành vi và rủi ro: unit, integration, contract, end-to-end, regression, các đường lỗi và ca biên, dùng chính các framework project đang có. Dùng khi lập kế hoạch hay review test cho hành vi mới hoặc hành vi đã đổi. Không dùng để gỡ một lỗi đang có (dùng bug-loop) hay để dựng test riêng cho một công cụ (dùng web-testing nếu đã cài)."
---

# Test theo hành vi và rủi ro

## Khi dùng
- Một feature, endpoint, schema hay một thay đổi hành vi cần kế hoạch test trước hoặc trong lúc
  làm.
- Một lead đang viết phần test của một brief cho peer.
- Một reviewer hỏi liệu các test của một thay đổi có chứng minh được điều nó tuyên bố.
- Một contract public (API, CLI, định dạng file, event) đổi và tính tương thích là quan trọng.

## Không dùng cho
- Một test hay một hành vi vốn đã fail: dùng bug-loop để tái lập và sửa nó.
- Dựng môi trường riêng cho framework hay tự động hoá trình duyệt: dùng web-testing nếu đã cài.
- Chạy theo một con số phần trăm coverage; skill này không đặt mục tiêu cố định nào.

## Điều kiện tiên quyết
- Đọc ALP.md và câu lệnh test, bố cục, framework, fixture và helper của project.
- Biết hành vi dự kiến từ yêu cầu của người dùng, từ spec hay từ contract, không phải từ
  implementation đang được kiểm.
- Biết các đường dẫn sở hữu; peer chỉ thêm test ở bên trong chúng.

## Quy trình
1. **Liệt kê các hành vi.** Viết từng hành vi quan sát được của thay đổi thành một câu:
   input hay event, kết quả mong đợi, và ai phụ thuộc vào nó.
2. **Liệt kê các rủi ro.** Với mỗi hành vi, cái gì có thể hỏng, khả năng bao nhiêu, và tốn kém
   cỡ nào. Bao gồm các đường lỗi (input không hợp lệ, dependency không có, timeout, bị từ chối
   quyền) và các ca biên trong checklist risk-matrix có áp dụng.
3. **Chọn phép test rẻ nhất mà chứng minh được.** Với mỗi rủi ro, hãy chọn mức thấp nhất mà sẽ
   fail nếu rủi ro đó xảy ra: unit cho logic thuần, integration cho việc nối dây và lưu trữ
   thật, contract cho các hình dạng mà người khác dựa vào, end-to-end chỉ cho một đường người
   dùng tối quan trọng mà không mức thấp nào phủ. Một test tốt cho mỗi rủi ro; bỏ các test
   không chứng minh thêm điều gì.
4. **Tái dùng.** Dùng framework, fixture, factory và helper đang có. Chỉ thêm một
   helper mới khi có hai test trở lên cần nó; đừng bao giờ thêm một dependency test mà không có
   lần duyệt được chuyển lên main.
5. **Viết kế hoạch.** Một bảng ngắn: hành vi, rủi ro, mức, chỗ đặt test, và nó
   đã tồn tại hay chưa. Đặt nó vào brief, note của task hay handoff.
6. **Viết các test.** Đặt tên mỗi test theo hành vi của nó. Khẳng định các kết quả quan sát
   được, không khẳng định các lời gọi nội bộ. Chỉ mock các biên bên ngoài, và giữ hành vi được
   tuyên bố nằm trong phạm vi kiểm.
7. **Cho thấy chúng fail khi chưa có thay đổi.** Chạy các test mới trên code trước khi
   thay đổi (stash hoặc comment phần thay đổi trong một bản sao riêng, hoặc viết test trước)
   và ghi lại lần fail. Sau đó chạy chúng với thay đổi và ghi lại lần pass.
8. **Chạy bộ test xung quanh** bằng câu lệnh test của project và báo kết quả.

## Ràng buộc
- Giá trị mong đợi đến từ yêu cầu hoặc từ các ví dụ tự tính ra một cách độc lập, không bao giờ
  đến từ việc chạy implementation.
- Đừng làm yếu, bỏ qua hay xoá một test đang có để một thay đổi pass; hãy báo nó.
- Test phải tất định: kiểm soát thời gian, phần ngẫu nhiên (seed cố định), thứ tự,
  mạng và trạng thái dùng chung. Không dùng sleep để đồng bộ.
- Quy tắc về test chập chờn: đừng merge một test đã biết là chập chờn; nếu xuất hiện một cái,
  hãy ghi lại tỉ lệ fail và các điều kiện, chỉ cách ly nó bằng cơ chế của project và có người
  sở hữu, rồi chuyển việc chẩn đoán sang bug-loop.
- Một test regression nằm đúng tại đường ráp mà bug hay rủi ro thực sự trú ở đó.

## Kiểm chứng
- Mỗi rủi ro đã liệt kê đều ứng với một test hoặc với một dòng "accepted, not tested" rõ ràng
  kèm lý do.
- Mỗi test mới đều đã được quan sát là fail khi chưa có thay đổi và pass khi có nó, hoặc
  handoff nói rõ vì sao lần chạy đó không thực hiện được.
- Câu lệnh test của project pass cho khu vực bị ảnh hưởng; các câu lệnh và kết quả đều có
  trong handoff.
- Không có test mới nào phụ thuộc vào thời gian thực, vào thứ tự test hay vào service bên
  ngoài.

## Xử lý khi thất bại
- Không có đường ráp test dùng được: đề xuất thay đổi đường ráp nhỏ nhất cho lead hay main;
  đừng tự ý cấu trúc lại code.
- Không chạy được lần trước khi thay đổi (không có lịch sử, code sinh ra): nêu rõ giới hạn và
  dùng cách chèn lỗi trong một bản sao riêng nếu rủi ro biện minh được.
- Một test đang có fail trước cả thay đổi của bạn: hãy dừng, ghi lại, và chuyển nó sang
  bug-loop.
- Yêu cầu chưa rõ với một ca biên: liệt kê nó thành một câu hỏi mở; đừng mã hoá một phỏng đoán
  vào test.

## Tài liệu tham chiếu
- [references/risk-matrix.md](references/risk-matrix.md) — đọc khi liệt kê rủi ro và ca biên, và khi chọn mức test (bước 2-3).
- [references/contract-tests.md](references/contract-tests.md) — đọc khi thay đổi chạm tới một API, protocol, schema, định dạng file hay một contract khác hướng ra bên tiêu thụ.
