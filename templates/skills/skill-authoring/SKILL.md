---
name: skill-authoring
description: "Thiết kế, viết, kiểm tra và cải thiện một agent skill: yêu cầu, description để kích hoạt, cách hé dần thông tin, các reference, script tuỳ chọn và cách đánh giá kích hoạt. Dùng khi tạo một skill mới hoặc khi sửa lại phạm vi, description hay cấu trúc của một skill. Không dùng để rà soát hay cho nghỉ toàn bộ danh mục bài học và skill; hãy dùng curate."
---

# Viết một skill

## Khi dùng
- Một quy trình lặp lại, ba bài học liên quan trở lên, hay một yêu cầu của người dùng đòi một
  skill mới.
- Một skill đang có kích hoạt sai chỗ, bỏ sót việc của nó, hay đã dài tới mức khó theo.
- Một skill cần thêm reference, một script tất định, hay một bản ghi đè riêng cho project.

## Không dùng cho
- Gộp, tỉa hay cho nghỉ các bài học và skill trên toàn danh mục: dùng curate.
- Hướng dẫn dùng một lần cho một task duy nhất: hãy đặt chúng vào brief hoặc ALP.md.
- Đổi thẩm quyền của role: một skill không cấp quyền nào và không thể nới rộng phạm vi.

## Điều kiện tiên quyết
- Đọc ALP.md và các skill đã gán cho các role đích; tránh trùng lặp.
- Biết nó sẽ sống ở đâu: thư viện của người dùng (do main đề xuất qua `alp_skill`) hay project
  (`.alp/skills/<name>/` trong repository, một thay đổi thường được review).
- Có ít nhất một task thật mà skill này đáng lẽ đã giúp được.

## Quy trình
1. **Yêu cầu.** Viết công việc nó làm trong một câu, các role dùng nó, các input nó
   giả định, và kết quả quan sát được mà nó phải trả về. Bỏ mọi thứ mà một agent có năng lực
   vốn đã làm được mà không cần hướng dẫn.
2. **Đặc tả kích hoạt.** Liệt kê 3-5 task dương phải chọn nó và 3-5 task lân cận
   phải không chọn nó, mỗi task nêu tên skill thực sự sở hữu nó.
3. **Description.** Đây là đoạn chữ duy nhất một agent thấy khi phiên bắt đầu. Nêu LÀM GÌ, rồi
   "Dùng khi ...", rồi "Không dùng cho ... (dùng X)". Giữ các từ khoá trong 400
   ký tự đầu mà index của ALP hiển thị; `alp_skill` chỉ nhận tối đa 300.
4. **Các mức hé dần.** Mức 0: tên và description (luôn được nạp). Mức 1:
   thân SKILL.md, đọc khi description khớp. Mức 2: các reference, chỉ đọc tại
   bước có link tới chúng. Mức 3: script và asset, chạy khi cần và không bao giờ lúc khám phá.
   Đặt mỗi dữ kiện ở mức thấp nhất mà vẫn tới được bước cần nó.
5. **Thân bài.** Các mục theo thứ tự: Khi dùng, Không dùng cho, Điều kiện tiên quyết, Quy trình
   (có số), Ràng buộc, Kiểm chứng, Xử lý khi thất bại, Tài liệu tham chiếu. Câu mệnh lệnh gọn,
   không kể lịch sử, không nhắc lại quy tắc của role, nhiều nhất khoảng 110 dòng.
6. **Reference.** Một chủ đề một file, tên kebab-case, chỉ một mức sâu, mỗi file được link từ
   bước cần nó kèm chữ "đọc khi ...". Tách một reference khi nó phủ hai
   quyết định; xoá reference không bước nào link tới.
7. **Script (tuỳ chọn).** Chỉ thêm khi cùng một phép biến đổi hay phép kiểm tất định bị lặp lại
   và dễ sai nếu diễn bằng lời. Dùng Node `.mjs` chạy bằng `node`; không tự động cài
   dependency; in một thông điệp rõ ràng nêu tên dependency còn thiếu
   rồi thoát với mã khác 0; kèm một test hoặc một lần chạy mẫu với output mong đợi.
8. **Kiểm tra.** Chạy `alp skill check <name|dir>`, rồi `--strict` trước khi đề xuất.
   Sửa mọi error và warning; riêng frontmatter hợp lệ chẳng chứng minh gì về chất lượng.
9. **Đánh giá.** Chạy các tình huống kích hoạt đối chiếu với description và làm một lần chạy
   khan trên một task thật bằng cách theo thân bài sát từng chữ; ghi lại chỗ hụt và sửa chúng.
10. **Giao.** Skill thư viện: main đề xuất nó bằng `alp_skill` (name, description,
    body, roles) và người dùng duyệt. `alp_skill` chỉ ghi SKILL.md, nên các reference
    và script do người dùng thêm, hoặc thêm qua `alp skill new` / `alp skill edit`.
    Skill của project: ghi `.alp/skills/<name>/` trong các đường dẫn sở hữu rồi handoff.

## Ràng buộc
- Đừng bao giờ ghi đè một skill thư viện mà người dùng đã sửa. Hãy đọc nó, rồi đề xuất một bản
  mới bằng `alp_skill` với `replace: true`; người dùng duyệt hoặc từ chối.
- Muốn đổi hành vi cho riêng một project, hãy thêm một bản ghi đè trong `.alp/skills/<name>/`
  thay vì sửa bản trong thư viện.
- Không dùng tên tool riêng của một runtime, không có secret, không có hướng dẫn push, phát
  hành, cài dependency hay ghi ra ngoài các đường dẫn sở hữu.
- Giữ tên ổn định khi các role đã tham chiếu tới nó; đổi tên là cho nghỉ cộng với một skill
  mới.

## Kiểm chứng
- `alp skill check <name> --strict` pass mà không có warning.
- Mọi tình huống dương đều chọn skill này; mọi tình huống âm đều chọn đúng phương án
  được nêu tên hoặc không chọn gì; các ca nhập nhằng được giải quyết trong description.
- Lần chạy khan đã tới được kết quả đã nêu mà không phải tự ứng biến các bước còn thiếu.
- Mọi reference và script đều được link từ một bước và đều tồn tại.

## Xử lý khi thất bại
- Bộ kiểm báo error: sửa file rồi chạy lại; đừng sửa bộ kiểm hay bỏ qua `--strict`.
- Chồng lấn với một skill đang có: thu hẹp một description, hoặc đề xuất gộp qua curate.
- Người dùng từ chối đề xuất: sửa theo góp ý rồi đề xuất lại; đừng ghi
  file thư viện trực tiếp.
- Không có task thật để chạy khan: hãy giao như một bản nháp và nói rõ phần đánh giá còn treo.

## Tài liệu tham chiếu
- [references/skill-anatomy.md](references/skill-anatomy.md) — đọc khi viết frontmatter, chọn các mục hay bố trí file (bước 3-7).
- [references/trigger-design.md](references/trigger-design.md) — đọc khi soạn hay chữa description và các điều kiện không kích hoạt (bước 2-3).
- [references/evaluation.md](references/evaluation.md) — đọc khi dựng bảng tình huống và chạy lượt đánh giá khan (bước 9).
