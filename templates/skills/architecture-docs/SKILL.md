---
name: architecture-docs
description: "Tạo và bảo trì tài liệu kiến trúc dựa trên bằng chứng trong repository: tổng quan, ranh giới, phụ thuộc giữa các module, luồng dữ liệu, API contract, quyết định, ADR, sơ đồ Mermaid và quy ước. Dùng khi tài liệu còn thiếu, đã lỗi thời, hoặc khi một thay đổi làm đổi ranh giới hay contract. Không dùng để thiết kế feature mới (dùng feature-architecture) hay nghiên cứu khả năng tái dùng (dùng xia)."
---

# Ghi lại kiến trúc mà code chứng minh được

## Khi dùng
- Project chưa có tổng quan kiến trúc, hoặc bản đang có mâu thuẫn với code.
- Một thay đổi thêm, bỏ hoặc di chuyển ranh giới module, public API, schema hay luồng dữ liệu.
- Một quyết định về công nghệ hoặc cấu trúc đã được xác nhận và cần một ADR.
- Người bảo trì tài liệu hoặc reviewer được yêu cầu kiểm tra tài liệu kiến trúc xem có lệch.

## Không dùng cho
- Thiết kế cách xây một feature mới: dùng feature-architecture.
- So sánh thư viện hay tìm code tái dùng được: dùng xia.
- Hướng dẫn người dùng, README và changelog không liên quan tới cấu trúc.
- Đoán ý định của code mà không ai giải thích được: hãy ghi lại một câu hỏi mở.

## Điều kiện tiên quyết
- Đọc ALP.md và mọi index tài liệu, cây `docs/` hoặc hướng dẫn đóng góp đang có.
- Biết rõ các đường dẫn sở hữu (owned paths): người ghi chỉ sửa các file tài liệu được giao;
  role chỉ đọc thì báo cáo.
- Xác định thay đổi hoặc câu hỏi đã kích hoạt công việc này; giới hạn phạm vi tài liệu theo đó.

## Quy trình
1. **Tìm bố cục.** Theo bố cục tài liệu project đang dùng. Nếu chưa có, hãy đề xuất
   `docs/architecture/overview.md`, `boundaries.md`, `conventions.md` và
   `decisions/NNNN-title.md`, và xác nhận trước khi tạo cấu trúc cấp cao mới.
2. **Thu bằng chứng.** Đọc manifest, entry point, config build và deploy, file khai báo
   route, schema, đồ thị import và test của khu vực trong phạm vi. Ghi mỗi dữ kiện kèm
   đường dẫn file chứng minh nó.
3. **Tổng quan.** Mục đích, các đơn vị runtime (process, package, service), chúng khởi động
   và nói chuyện với nhau ra sao, và các hệ thống bên ngoài. Một trang ngắn.
4. **Ranh giới và phụ thuộc.** Trách nhiệm của từng module, nó được import gì, ai import nó,
   và bề mặt public mà người khác dựa vào. Ghi lại các vòng lặp và chỗ rò rỉ phát hiện được.
5. **Luồng dữ liệu và contract.** Truy vết đường đi chính của request hoặc job từ đầu tới cuối.
   Với mỗi API, event hay schema, dẫn file định nghĩa và quy tắc đánh version của nó.
6. **Quyết định.** Ghi lại các lựa chọn công nghệ và cấu trúc đã được xác nhận, kèm bằng chứng
   hoặc người đã xác nhận. Chỉ viết ADR khi đạt tiêu chí trong tài liệu tham chiếu về ADR;
   nếu không thì một dòng trong phần tổng quan là đủ.
7. **Sơ đồ.** Chỉ thêm sơ đồ Mermaid ở chỗ chữ khó theo dõi hơn. Giữ sơ đồ nhỏ và suy ra từ
   code: mỗi node ứng với một đường dẫn thật.
8. **Quy ước.** Ghi lại các mẫu đặt tên, phân lớp, xử lý lỗi, logging và test mà code đã theo
   một cách nhất quán, mỗi mẫu kèm một đường dẫn ví dụ.
9. **Điều chưa biết.** Đánh dấu mọi thứ chưa chứng minh được là "Unverified" và liệt kê các câu
   hỏi mở kèm người có thể trả lời. Chuyển quyết định lên trên; đừng tự bịa ra.
10. **Kiểm tra.** Xác minh link, đường dẫn và ví dụ (xem Kiểm chứng), rồi handoff kèm danh sách
    bằng chứng.

## Ràng buộc
- Chỉ mô tả những gì code, config, test hoặc quyết định đã xác nhận chứng minh được. Không
  trình bày kiến trúc mong muốn như thể nó đang là hiện trạng.
- Dẫn bằng chứng bằng đường dẫn file tương đối, kèm tên symbol hoặc khoảng dòng khi hữu ích.
- Giữ tài liệu đồng bộ: một thay đổi làm đổi ranh giới hay contract phải cập nhật tài liệu của
  nó trong cùng thay đổi đó. Thay đổi nội bộ nhỏ không cần ADR và thường không cần sửa tài
  liệu.
- Đừng refactor code cho khớp tài liệu; hãy báo cáo chỗ lệch.
- Các role chỉ đọc (architect, reviewer) trả về phát hiện và bản văn đề xuất, không sửa file.

## Kiểm chứng
- Mọi link tương đối và đường dẫn được dẫn đều phân giải được; chạy bộ kiểm tra link của
  project nếu có, nếu không thì kiểm từng đường dẫn có tồn tại.
- Ví dụ code và câu lệnh trong tài liệu chạy hoặc biên dịch được trên cây hiện tại, hoặc được
  đánh dấu là minh hoạ.
- Mỗi node và mũi nối trong sơ đồ khớp với một import, lời gọi, route hay mục config.
- Không có phát biểu nào thiếu bằng chứng hoặc thiếu dấu "Unverified".

## Xử lý khi thất bại
- Bằng chứng xung đột (code nói một đằng, config hoặc tài liệu nói một nẻo): ghi lại cái đang
  chạy, nêu xung đột thành câu hỏi mở, và báo cáo.
- Khu vực quá lớn so với việc được giao: ghi lại ranh giới và entry point, liệt kê các module
  chưa phủ, rồi trả về; đừng mở rộng phạm vi.
- Cần một quyết định nhưng chưa được xác nhận: soạn ADR ở trạng thái `Proposed` và chuyển cho
  main.
- Bố cục tài liệu hiện tại không rõ hoặc đang tranh cãi: hỏi trước khi cấu trúc lại.

## Tài liệu tham chiếu
- [references/evidence-rules.md](references/evidence-rules.md) — đọc khi thu dữ kiện và dẫn nguồn (bước 2-5, 9).
- [references/adr.md](references/adr.md) — đọc khi quyết định một thay đổi có cần ADR hay không, và khi viết ADR (bước 6).
- [references/diagrams.md](references/diagrams.md) — đọc khi thêm hoặc cập nhật sơ đồ Mermaid (bước 7).
