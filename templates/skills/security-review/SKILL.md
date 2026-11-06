---
name: security-review
description: "Review một thay đổi hay thành phần để tìm lỗ hổng bảo mật: xác thực, ranh giới quyền, lộ secret, injection, chuỗi cung ứng, filesystem không an toàn, thực thi từ xa, và ghi log dữ liệu nhạy cảm, rồi báo phát hiện có xếp mức kèm bằng chứng. Dùng khi một diff, PR hay thành phần cần một lượt soát bảo mật. Không dùng để sửa bug đã báo (bug-loop) hay phán xét cả một bản phát hành (release-readiness)."
---

# Review bảo mật

## Khi dùng

- Một thay đổi chạm tới xác thực, phân quyền, xử lý input, secret, file,
  process, lời gọi mạng, dependency, hay logging.
- Một thành phần hay một tích hợp cần một lượt soát bảo mật tập trung trước khi merge hay phát
  hành.
- Một reviewer hay một agent chỉ đọc được yêu cầu nêu các phát hiện về bảo mật.

## Không dùng cho

- Sửa một lỗ hổng đã xác nhận từ đầu tới cuối: hãy báo nó, rồi dùng bug-loop.
- Quyết định một version có xuất bản được không: dùng release-readiness (nó tiêu thụ các phát
  hiện này).
- Kiểm thử xâm nhập hay quét các hệ thống đang chạy thật.

## Điều kiện tiên quyết

- Một mục tiêu đã xác định: một diff, một khoảng commit, một PR, hay một thành phần được nêu
  tên, cùng phạm vi từ agent giao việc.
- Đọc ALP.md và hướng dẫn của project để biết các câu lệnh được phép và các công cụ bảo mật
  đang có.

## Quy trình

1. Xác định mục tiêu và các ranh giới tin cậy của nó: ai gọi nó, với đặc quyền nào,
   và input nào đến từ nguồn không đáng tin (người dùng, mạng, file, biến môi trường, service
   khác).
2. Vẽ luồng dữ liệu từ mỗi input không đáng tin tới các điểm tiêu nhạy cảm: truy vấn, shell,
   filesystem, eval hay deserialize, request đi ra, log, response.
3. Đi qua các hạng mục trong checklist có áp dụng cho mục tiêu: xác thực,
   phân quyền và ranh giới quyền, lộ secret, kiểm tra input và
   injection, rủi ro về dependency và chuỗi cung ứng, các thao tác filesystem không an toàn,
   ranh giới thực thi từ xa, ghi log dữ liệu nhạy cảm.
4. Với mỗi vấn đề bị nghi, hãy tìm bằng chứng: file:line của nguồn, của điểm tiêu, và mọi
   cơ chế kiểm soát còn thiếu hay có thể lách. Truy vết đủ xa để xác nhận nó với tới được.
5. Chạy các công cụ bảo mật đang có của project (ví dụ `npm audit`, một linter hay một bộ quét
   secret đã cấu hình) chỉ khi chúng đã có sẵn và mode của phiên cho phép chạy chúng. Ghi lại
   câu lệnh và kết quả.
6. Xếp mức cho từng phát hiện bằng khung mức nghiêm trọng và tách cái đã xác nhận với cái còn
   nghi.
7. Viết báo cáo: các phát hiện kèm mức nghiêm trọng, bằng chứng, tình huống khai thác, đề xuất
   sửa; rồi các khu vực đã kiểm và thấy sạch; rồi phần nào chưa được review.

## Ràng buộc

- Skill này không cấp thêm quyền nào. Hãy review trong phạm vi và mode được giao.
- Đừng bao giờ chạy mã khai thác hay lưu lượng tấn công vào hệ thống thật, môi trường dùng
  chung, hay service của bên thứ ba. Hãy chứng minh khả năng với tới bằng cách đọc code hoặc
  bằng một test cục bộ trong không gian scratch, và chỉ khi đã được cấp quyền ghi.
- Đừng bao giờ đọc, in ra hay sao chép secret thật. Chỉ ghi nhận sự hiện diện của chúng bằng
  đường dẫn (và số dòng), ví dụ "credential-like value in config/prod.env:3".
- Đừng bao giờ cài bộ quét hay dependency mới khi chưa có lần duyệt rõ ràng chuyển
  qua agent giao việc.
- Các agent chỉ đọc báo phát hiện; họ không vá code.
- Đừng thổi mức nghiêm trọng lên để buộc người khác hành động, cũng đừng dìm nó xuống để tránh
  ma sát; hãy áp dụng khung đúng như nó được viết.

## Kiểm chứng

- Mọi phát hiện đều có mức nghiêm trọng, bằng chứng file:line, tình huống khai thác, và cách
  sửa.
- Các phát hiện đã xác nhận cho thấy một đường đã truy vết từ input tới điểm tiêu; mọi thứ khác
  đều được dán nhãn là còn nghi, kèm phát biểu rõ mắt nối nào còn thiếu.
- Các lần chạy công cụ nêu đúng câu lệnh và kết quả, hoặc ghi "not run" kèm lý do.
- Handoff bản báo cáo cho agent giao việc (peer -> lead -> main).

## Xử lý khi thất bại

- Không truy vết được khả năng với tới: báo là còn nghi, kèm điều gì sẽ xác nhận được nó.
- Context cần có nằm ngoài phạm vi (một service khác, config hạ tầng): liệt kê nó dưới
  "not reviewed" và nêu tên người kiểm được.
- Tìm thấy một secret đang dùng thật: chỉ báo đường dẫn và số dòng, khuyến nghị xoay vòng nó,
  và nêu ngay cho agent giao việc ở mức critical hoặc high.
- Công cụ không có hoặc không được phép: hãy nói rõ; đừng thay bằng một lần cài chưa được
  duyệt.

## Tài liệu tham chiếu

- [references/checklist.md](references/checklist.md) — đọc khi đi qua các hạng mục review (bước 3).
- [references/severity.md](references/severity.md) — đọc khi xếp mức các phát hiện và viết báo cáo (bước 6-7).
