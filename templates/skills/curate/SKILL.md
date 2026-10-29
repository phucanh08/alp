---
name: curate
description: "Rà soát toàn bộ bài học (lesson) và skill: gộp lesson trùng, rút gọn lesson dài, bỏ lesson đã có skill thay, đánh dấu skill không còn cần, và đề xuất issue cho ALP. Dùng khi người dùng yêu cầu rà soát, hoặc khi lịch curate hằng tháng đánh thức main."
---

# Curate

## Khi dùng
- Người dùng yêu cầu rà soát, dọn dẹp hay rút gọn lesson và skill.
- Main được đánh thức bởi lịch curate hằng tháng (prompt có `[alp-curate]`).

Không làm khi đang giữ một gate hay câu hỏi khác với người dùng; trả lời việc đó trước.

## Phương pháp
1. **Đọc hết, không nhớ lại.** Đọc `.alp/lessons.md` của project và `~/.alp/lessons.md` của người dùng; đọc mọi SKILL.md trong `~/.alp/skills`, `.alp/skills` và danh sách skill của từng role (`role-skills.json`).
2. **Lập đề xuất, mỗi mục một dòng lý do:**
   - **Gộp:** các lesson cùng ý thành một rule.
   - **Rút gọn:** lesson dài hoặc lan man thành một rule ngắn: làm gì, khi nào.
   - **Xóa:** lesson đã được một skill bao trọn (nêu tên skill), hoặc đã lỗi thời.
   - **Thành skill:** 3 lesson trở lên cùng chủ đề thì gom thành skill qua `alp_skill` (truyền `lessons` để bỏ chúng).
   - **Skill không còn cần:** trùng skill khác, không role nào dùng, hay đã lỗi thời. Chỉ đánh dấu và nêu lý do; ALP chưa có thao tác xóa skill nên người dùng tự xóa.
   - **Đề xuất cho ALP:** lesson hay skill hữu ích cho mọi người dùng, hoặc chỗ ALP còn thiếu.
3. **Gửi qua cổng duyệt, không hỏi trước trong chat.** Tóm tắt đề xuất trong một tin, rồi gọi ngay các tool bên dưới. Lần duyệt trong tool là lần duyệt duy nhất; người dùng từ chối hay góp ý thì sửa và đề xuất lại.
4. **Các tool:**
   - Lesson: một lần gọi `alp_lesson_curate` với mọi thay đổi (remove là văn bản đúng nguyên văn; add là rule thay thế khi gộp hoặc rút gọn). ALP hiện toàn bộ thay đổi trong một lần duyệt.
   - Skill mới: `alp_skill`.
   - Issue: `alp_issue` action search target alp trước; chưa có thì create, đã có thì comment. Người dùng duyệt từng bản nháp.
5. Báo kết quả một đoạn ngắn: đã gộp, rút gọn, xóa bao nhiêu; skill nào được đánh dấu; issue nào đã tạo.

## Kiểm tra
- Không sửa hay xóa lesson nào ngoài `alp_lesson_curate`; không sửa file lesson trực tiếp.
- Mỗi rule sau gộp vẫn giữ đủ ý của các lesson gốc.
- Mỗi lesson bị xóa vì skill đều nêu đúng tên skill thay nó.
- Issue không chứa secret, đường dẫn riêng hay nội dung project của người dùng.
- Không có thay đổi nào khi người dùng chưa duyệt; lesson không tìm thấy được báo lại, không đoán.
