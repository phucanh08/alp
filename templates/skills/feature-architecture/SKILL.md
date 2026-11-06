---
name: feature-architecture
description: "Hiện thực một feature mới sao cho nó khớp với các quy tắc kiến trúc, boilerplate và hướng phụ thuộc đang có của project, với một bản thiết kế ngắn trước và các phép kiểm ranh giới sau. Dùng khi thêm feature vào một codebase có tài liệu kiến trúc, ADR, template hoặc một contract về ranh giới. Không dùng cho việc cấu trúc lại mà giữ nguyên hành vi (safe-refactor) hay sửa một regression (bug-loop)."
---

# Kiến trúc feature

## Khi dùng

- Một feature, endpoint, module hay câu lệnh mới phải đưa được vào một project đã có
  tài liệu kiến trúc, ADR, quy tắc về lớp hoặc package, hay boilerplate cho feature.
- Một architect hoặc reviewer chỉ đọc được hỏi xem một feature đã lên kế hoạch có khớp
  với kiến trúc của project hay không (chỉ tư vấn).

## Không dùng cho

- Cấu trúc lại code đang có mà không đổi hành vi: dùng safe-refactor.
- Tái lập và sửa một bug hay regression: dùng bug-loop.
- Viết hay sắp xếp lại chính tài liệu kiến trúc: dùng architecture-docs.
- Chọn một phong cách kiến trúc mới cho project: đó là quyết định của người dùng.

## Điều kiện tiên quyết

- Một phạm vi được giao (đường dẫn hoặc module) và tiêu chí nghiệm thu lấy từ brief.
- Quyền đọc ALP.md, hướng dẫn của project, và tài liệu kiến trúc nếu có.

## Quy trình

1. Đọc ALP.md và hướng dẫn riêng của project; ghi lại câu lệnh build, test, lint và
   kiểm ranh giới.
2. Đọc các tài liệu kiến trúc liên quan (ví dụ `docs/architecture/`, các ADR, README của
   package). Chỉ đọc phần dính tới các module mà feature này chạm vào.
3. Liệt kê các quy tắc thành hai nhóm. Ràng buộc cứng: quy tắc phụ thuộc, chỗ đặt file,
   tương thích public API, interface hay điểm đăng ký bắt buộc. Quy ước mềm: cách đặt tên,
   hình dạng thư mục, phong cách test. Dẫn nguồn của từng quy tắc.
4. Tìm boilerplate hoặc template (ví dụ `templates/features/`) và feature đang có giống
   nhất. Lặp lại cấu trúc, cách nối dây và test của nó.
5. Vẽ ra các module bị chạm và hướng của từng phụ thuộc mới. Một cạnh mới phải chỉ cùng
   hướng với các cạnh cùng loại đang có.
6. Viết một bản thiết kế feature ngắn: file sẽ thêm hoặc sửa, module sở hữu, bề mặt public,
   test. Đặt nó vào brief của lead/peer hoặc vào note của task.
7. Hiện thực theo các quy ước đang có. Ở trong các đường dẫn sở hữu.
8. Chạy các phép kiểm kiến trúc. Dùng công cụ lint và kiểm ranh giới của chính project
   trước. Nếu project đã nhận file contract của ALP, hãy chạy thêm
   `node <this skill dir>/scripts/check-boundaries.mjs --root <repo>`; mặc định nó đọc
   `docs/architecture/contract.json` và thoát với mã 1 khi có vi phạm. Xem
   [scripts/check-boundaries.mjs](scripts/check-boundaries.mjs).
9. Review diff đối chiếu với bản thiết kế. Chỉ cập nhật tài liệu kiến trúc hoặc contract
   nếu một ranh giới hay contract thật sự đã đổi.

Một architect hoặc reviewer chỉ đọc chạy bước 1-6 và 8 trên bản đề xuất hoặc trên cây hiện
tại, rồi báo phát hiện và một bản thiết kế được khuyến nghị, thay vì sửa file.

## Ràng buộc

- Đừng bao giờ áp đặt Clean Architecture, DDD, Hexagonal, hay bất kỳ framework hoặc mẫu nào
  mà project chưa dùng.
- Đừng thêm một abstraction, lớp hay interface chỉ để thoả một mẫu chung chung.
- Nếu kiến trúc không thể thoả yêu cầu, hãy dừng. Nêu rõ xung đột, cái được cái mất, và các
  phương án, rồi chuyển quyết định lên trên
  (peer -> lead -> main -> người dùng).
- Một ngoại lệ với quy tắc cứng cần một quyết định được ghi lại rõ ràng (một ADR hoặc một
  note trong task nêu tên người đã duyệt). Đừng bao giờ lách một quy tắc trong im lặng, và
  đừng sửa contract hay config lint để một vi phạm lọt qua.
- Các agent chỉ đọc (architect, reviewer) báo phát hiện; họ không sửa file.
- Skill này không cấp quyền cài công cụ, mở rộng phạm vi, hay ghi ra ngoài các đường dẫn
  sở hữu.

## Kiểm chứng

- Lint, type check, test và công cụ kiểm ranh giới của project đều pass trên cây cuối cùng.
- `check-boundaries.mjs` thoát với mã 0 khi project dùng file contract.
- Mọi cạnh phụ thuộc mới khớp với hướng đã vẽ ở bước 5.
- Handoff: câu lệnh kiểm kèm output, các file đã đổi nhóm theo module, và mọi ngoại lệ đã
  được duyệt kèm nơi ghi nó và người duyệt.

## Xử lý khi thất bại

- Vi phạm ranh giới: di chuyển code hoặc đảo hướng phụ thuộc theo cách feature tương tự đã
  làm; chạy lại bộ kiểm. Đừng làm yếu quy tắc.
- Không có feature hay template tương tự: hãy nói thẳng, đề xuất phương án gần nhất, và hỏi
  agent giao việc trước khi tự dựng một cấu trúc mới.
- Tài liệu và code xung đột: theo code mà các phép kiểm thực thi, ghi lại chỗ lệch, và báo lên.
- Bộ kiểm thiếu hoặc chạy không được: báo đúng câu lệnh và lỗi; đừng tuyên bố là đã kiểm
  chứng được các ranh giới.

## Tài liệu tham chiếu

- [references/feature-design.md](references/feature-design.md) — đọc khi viết bản thiết kế feature (bước 6), khi chọn feature tương tự (bước 4), hoặc khi kiểm hướng phụ thuộc (bước 5).
- [references/architecture-contract.md](references/architecture-contract.md) — đọc khi project đã có hoặc muốn có một contract kiến trúc máy kiểm được.
