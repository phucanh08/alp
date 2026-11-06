---
name: safe-refactor
description: "Cấu trúc lại code mà vẫn giữ nguyên hành vi quan sát được và các bất biến kiến trúc, bằng characterization test, phân tích tương thích, đánh giá ảnh hưởng tới bên gọi, và những bước nhỏ luôn xanh. Dùng khi đổi tên, di chuyển, tách, chia nhỏ hay đơn giản hoá code mà hành vi phải giữ nguyên. Không dùng để sửa bug (bug-loop) hay thêm feature (feature-architecture)."
---

# Refactor an toàn

## Khi dùng

- Đổi tên, di chuyển, tách ra, nhập vào, chia nhỏ hay gộp code, module hoặc file.
- Thay một implementation nội bộ phía sau một interface không đổi.
- Bỏ phần trùng lặp hay code chết ở chỗ hành vi phải giữ nguyên.

## Không dùng cho

- Sửa hành vi sai hay một regression: dùng bug-loop.
- Thêm một feature hay một bề mặt public mới: dùng feature-architecture.
- Đổi hành vi "nhân lúc đang ở đây": đó là một task riêng với lần duyệt riêng của nó.

## Điều kiện tiên quyết

- Một phạm vi được giao và một mục tiêu đã nêu cho lần refactor (cái gì sẽ gọn hơn hay an toàn
  hơn).
- Một câu lệnh test chạy được, hoặc thẩm quyền thêm test trong các đường dẫn sở hữu.
- Đọc ALP.md và hướng dẫn của project để biết câu lệnh test, lint, type check và build.

## Quy trình

1. Định nghĩa bất biến: hành vi, bề mặt public, và các quy tắc kiến trúc không được phép
   đổi. Viết nó vào brief hoặc vào note của task.
2. Tìm mọi bên gọi và bên phụ thuộc: tìm các import, chỗ tham chiếu symbol, các lần tra
   bằng chuỗi (reflection, bảng định tuyến, khoá config), code sinh ra, tài liệu, và
   script. Ghi lại các câu lệnh tìm và số lượng kết quả.
3. Chạy phân tích tương thích cho mọi thứ lộ ra ngoài module: public API,
   symbol được export, định dạng config, dữ liệu đã lưu, cờ CLI, message protocol.
4. Ghim hành vi hiện tại bằng characterization test trước khi sửa, kể cả những hành vi lạ
   hay gây bất ngờ. Chạy chúng và xác nhận chúng pass trên code chưa đổi.
5. Lên kế hoạch các bước nhỏ, mỗi bước để lại cây vừa build được vừa xanh. Xếp thứ tự sao
   cho bước nào cũng có thể revert một mình.
6. Với mỗi bước: sửa, chạy các characterization test và bộ test liên quan,
   rồi đi tiếp. Chỉ commit hay chốt điểm trong giới hạn quy tắc của phiên cho phép.
7. Với các thay đổi nhiều rủi ro, hãy chọn một cách kiểm soát rủi ro: một feature flag, một
   đường chạy song song có so output, hay một bản rollback đã ghi lại. Ưu tiên cái rẻ nhất mà
   vừa.
8. So trước và sau: cùng test, cùng output cho cùng input, cùng bề mặt
   public; chỉ đo hiệu năng nếu code nằm trên đường nóng.
9. Bỏ các shim, flag và đường chạy trùng tạm thời sau khi đã kiểm chứng việc chuyển sang,
   hoặc ghi lại lý do chúng còn đó và ai sẽ bỏ chúng.

## Ràng buộc

- Không trộn thay đổi hành vi vào lần refactor. Nếu một test buộc phải đổi giá trị mong đợi
  của nó, hãy dừng: đó là một thay đổi hành vi.
- Nếu buộc phải đổi hành vi để hoàn tất lần refactor, hãy dừng, nêu lý do, và chuyển
  quyết định lên trên (peer -> lead -> main -> người dùng).
- Đừng phá một contract public hay một contract về dữ liệu đã lưu khi chưa có quyết định được
  ghi lại rõ ràng; hãy ưu tiên một shim tương thích hoặc một đường khai tử dần.
- Giữ nguyên các quy tắc kiến trúc của project; chạy các phép kiểm ranh giới hay lint của
  project.
- Ở trong các đường dẫn sở hữu. Một bên gọi nằm ngoài đó thì được báo cáo, không sửa.
- Đừng làm yếu, bỏ qua hay xoá test để lấy màu xanh.

## Kiểm chứng

- Các characterization test và bộ test liên quan của project pass cả trước và sau.
- Diff của bề mặt public là rỗng, hoặc mọi thay đổi đều được một quyết định đã duyệt phủ.
- Chạy lại lượt tìm bên gọi sau khi đổi, không còn tham chiếu cũ nào.
- Handoff: bất biến, các câu lệnh tìm bên gọi và kết quả, các lần chạy test trước/sau,
  ghi chú về tương thích, cách kiểm soát rủi ro đã dùng, và mọi shim còn lại.

## Xử lý khi thất bại

- Một characterization test fail sau một bước: revert bước đó, thu nhỏ nó, thử lại.
- Không ghim được hành vi (không có harness, không tất định): báo khoảng trống đó và
  harness đề xuất; đừng tiến hành một thay đổi nhiều rủi ro khi chưa ghim được.
- Một bên gọi nằm ngoài các đường dẫn sở hữu: báo nó kèm thay đổi cần thiết cho
  agent giao việc.
- Hành vi lạ trông giống một bug: hãy giữ nó, ghim nó, và báo nó như một ứng viên
  bug-loop riêng.

## Tài liệu tham chiếu

- [references/characterization-tests.md](references/characterization-tests.md) — đọc khi ghim hành vi hiện tại trước lần sửa đầu tiên (bước 4).
- [references/compatibility-checklist.md](references/compatibility-checklist.md) — đọc khi lần refactor chạm tới bất cứ thứ gì lộ ra ngoài module của nó (bước 3).
