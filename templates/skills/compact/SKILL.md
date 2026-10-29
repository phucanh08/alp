---
name: compact
description: "Viết checkpoint có cấu trúc trước khi compact context của main, để sau khi nén vẫn tiếp tục đúng việc. Dùng khi runtime báo context gần đầy (khoảng 70%), khi người dùng yêu cầu compact, hoặc trước khi chuyển phiên."
---

# Compact

## Khi dùng
- Runtime báo context dùng khoảng 70% hoặc hơn, hay yêu cầu viết checkpoint.
- Người dùng yêu cầu compact.
- Trước khi kết thúc hoặc chuyển phiên.

Không compact khi đang giữ lượt (alp_wait, alp_ask, delegate wait), hoặc khi đang viết dở câu trả lời. Phải trả lời người dùng trước.

## Phương pháp
1. **Kiểm thực tế, không chép trí nhớ.** Đọc alp_task ready/list và alp_board. Với PR/CI liên quan, chạy gh pr view/checks ngay trong lượt.
2. **Viết checkpoint theo đúng các mục sau** (ngắn, có ID, có giờ):
   - **Người dùng và ngôn ngữ:** profile (Phở/Cafe), ngôn ngữ trả lời.
   - **Assignment đang chạy:** assignmentId, agent, taskId, worktree hoặc nhánh, ETA, note cuối kèm giờ.
   - **Task và gate:** task đang làm hoặc chờ review; gate đang mở kèm nội dung; gate đã có quyết định nhưng chưa gỡ.
   - **Quyết định của người dùng:** trích nguyên văn, kèm giờ và task nhận quyết định đó.
   - **Câu hỏi đang chờ người dùng:** câu hỏi nào, ở gate nào.
   - **PR/CI:** số PR, head SHA, trạng thái check đã kiểm lúc nào, watcher nền (job id) nếu có.
   - **Rủi ro và giới hạn còn mở:** từng mục, kèm task theo dõi.
   - **Bước tiếp theo:** theo thứ tự, ai làm.
3. **Không đưa vào checkpoint:** bài học, skill, nội dung task đầy đủ (đã lưu ngoài context), log dài, secret.
4. Gửi checkpoint cho runtime theo yêu cầu, hoặc ghi alp_pin/task note nếu compact thủ công. Sau đó báo người dùng một dòng: "Em đã compact context; checkpoint giữ X assignment, Y gate, Z quyết định."

## Kiểm tra
- Mọi assignment đang chạy đều có ID.
- Mọi gate mở và mọi câu hỏi đang chờ đều có trong checkpoint.
- Quyết định của người dùng được trích nguyên văn, không diễn giải.
- Trạng thái PR/CI ghi rõ thời điểm đã kiểm.
- Sau compact, lượt đầu tiên đọc lại alp_task và gh trước khi báo trạng thái.
