---
name: release-readiness
description: "Đánh giá xem một build hay version cụ thể đã sẵn sàng phát hành chưa và trả về verdict GO, CONDITIONAL hay NO-GO kèm bằng chứng cho từng tiêu chí: CI, test, artifact, bảo mật, tương thích, migration, rollback, vận hành. Dùng khi được hỏi một version có phát hành được không. Không dùng để tag hay publish, để review một thay đổi đơn lẻ (security-review), hay để sửa lỗi (bug-loop)."
---

# Mức sẵn sàng phát hành

## Khi dùng

- Có người hỏi liệu một commit, build hay version có phát hành được không.
- Một bản ứng viên phát hành cần một quyết định go/no-go được ghi lại trước khi người dùng cho
  phép xuất bản.
- Một reviewer được yêu cầu soát lại một checklist phát hành hoặc một tuyên bố đã có.

## Không dùng cho

- Tag, publish, push hay deploy: những việc đó cần người dùng cho phép rõ ràng và
  nằm ngoài skill này.
- Một lượt soát bảo mật cho một thay đổi: dùng security-review, rồi đưa các phát hiện của nó
  vào đây.
- Sửa một test hay build đang fail: dùng bug-loop.

## Điều kiện tiên quyết

- Bản ứng viên chính xác: commit SHA (và tag hay chuỗi version nếu đã chọn).
- Đọc ALP.md và hướng dẫn của project để biết quy trình phát hành, CI, câu lệnh build
  và test, cùng mọi checklist phát hành đang có.

## Quy trình

1. Ghim bản ứng viên: ghi lại commit SHA, nhánh, chuỗi version, và cây làm việc có sạch
   hay không. Mọi phép kiểm sau đó đều quy về SHA này.
2. Trạng thái CI: xác nhận các check bắt buộc đã pass trên đúng commit đó, không phải một
   commit lân cận hay một đầu nhánh đã dịch chuyển. Ghi lại tên check và link hoặc output.
3. Test: chạy hoặc tìm kết quả của bộ test phát hành của project trên SHA đó. Ghi lại câu
   lệnh, số pass/fail, test bị skip, và các test đã biết là chập chờn.
4. Artifact build: xác nhận chúng được build từ SHA đó, mang đúng dấu version, và khớp các
   checksum đã ghi. Ghi lại mọi artifact chưa xem xét.
5. Bảo mật: liệt kê các phát hiện còn mở ảnh hưởng tới bản ứng viên (từ security-review, từ
   các công cụ audit mà phiên cho phép, từ issue tracker) kèm mức nghiêm trọng và trạng thái.
6. Tương thích: các thay đổi về protocol, public API, CLI, config và định dạng dữ liệu kể từ
   bản phát hành trước, kèm việc bên tiêu thụ buộc phải làm gì.
7. Migration: các migration về dữ liệu hay config, từng cái đã được test chưa, và có đảo ngược
   được không; nếu không đảo ngược được thì bản backup hay bản sửa tiến nào phủ cho nó.
8. Kế hoạch rollback: các bước cụ thể và ai thực thi được; rollback đã được diễn thử chưa.
9. Mức sẵn sàng vận hành: release note, tài liệu, monitoring và cảnh báo cho hành vi mới,
   người on-call hay người sở hữu đã biết chưa.
10. Quyết định verdict và viết nó bằng mẫu verdict.

## Ràng buộc

- Mọi tiêu chí đều có bằng chứng (câu lệnh và kết quả, link, hay đường dẫn file) hoặc được
  đánh dấu "not verified" kèm lý do. Đừng bao giờ ghi PASS cho thứ chưa chạy
  hoặc chưa xem xét.
- Bằng chứng phải thuộc về SHA đã ghim. Kết quả từ một commit khác là "not
  verified".
- Đừng tag, publish, push, deploy hay nâng version. Hãy báo verdict; main
  xin phép người dùng cho mọi hành động phát hành.
- Đừng cài công cụ hay sửa config CI để một phép kiểm pass.
- Các agent chỉ đọc chỉ đánh giá và báo cáo.

## Kiểm chứng

- Verdict tuân theo đúng quy tắc: bất kỳ tiêu chí chặn nào fail thì là NO-GO; các mục không
  chặn mà chưa kiểm chứng hoặc fail, nếu có người sở hữu và hạn chót, thì có thể là
  CONDITIONAL; chỉ GO khi mọi tiêu chí chặn đều pass kèm bằng chứng.
- Mỗi điều kiện của CONDITIONAL nêu rõ một người sở hữu và cái gì đóng được nó.
- Handoff bản báo cáo verdict cho agent giao việc (peer -> lead -> main).

## Xử lý khi thất bại

- CI hay artifact không tới được từ phiên này: đánh dấu "not verified", nêu tên người
  xác nhận được, và đừng ra verdict GO.
- SHA ứng viên đổi giữa lúc đang đánh giá: bắt đầu lại từ bước 1 với SHA mới.
- Tìm thấy một lỗi chặn: ra verdict NO-GO kèm bằng chứng; đề xuất các việc tiếp theo bằng
  bug-loop hay security-review như những task riêng.
- Project không có đường rollback: đó là một khoảng trống chặn, trừ khi người dùng chấp nhận
  rủi ro một cách rõ ràng; hãy ghi lại ai đã chấp nhận.

## Tài liệu tham chiếu

- [references/checklist.md](references/checklist.md) — đọc khi đánh giá từng tiêu chí (bước 2-9).
- [references/verdict-template.md](references/verdict-template.md) — đọc khi quyết định và viết verdict (bước 10).
