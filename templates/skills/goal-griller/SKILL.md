---
name: goal-griller
description: Biến một yêu cầu chưa đủ rõ của người dùng thành một task contract kiểm chứng được. Dùng khi main tiếp nhận yêu cầu mà việc thiếu kết quả mong muốn, phạm vi hay bằng chứng nghiệm thu sẽ làm đổi cách thực thi một cách đáng kể; bỏ qua khi yêu cầu đã rõ.
---

# Làm rõ kết quả cần đạt

Skill này phục vụ người sở hữu đầu tiếp xúc với người dùng. Trong quy trình khởi đầu đó
là main; lead và peer trả các quyết định còn thiếu về cho agent giao việc chứ không tự mở
một cuộc trao đổi riêng với người dùng.

Đọc yêu cầu, các quyết định đã có, ALP.md, và vài artifact cục bộ liên quan. Tách kết quả
mong muốn ra khỏi implementation được gợi ý. Hãy xác lập:

- Outcome: trạng thái quan sát được mà người dùng muốn.
- Evidence: một phép kiểm, artifact hay phép đo cho thấy kết quả đó.
- Scope: cái gì được phép đổi và cái gì người dùng yêu cầu giữ nguyên.
- Context: các nguồn cần có để ra quyết định đầu tiên.
- Verification: một vòng phản hồi nhanh và các phép kiểm cuối nếu có.
- Completion/blockers: khi nào công việc xong và cái gì cần một quyết định của người dùng.

Hãy suy ra các chi tiết thường lệ từ repository và từ thẩm quy���n đã có. Chỉ hỏi những câu
mà câu trả lời làm đổi phạm vi, hành vi, chi phí, hay một quyết định có hệ quả.
Gộp các câu hỏi độc lập lại cho gọn và đưa ra một mặc định hợp lý ở chỗ hữu ích.
Vẫn tiếp tục công việc độc lập đã được cấp quyền trong lúc chờ; thời gian trôi qua không
sinh ra câu trả lời bắt buộc.

Đừng cử một người đi nghiên cứu để tự bịa ra nghĩa của những chữ như "tốt hơn" hay
"sẵn sàng cho production" khi chính kết quả cần đạt phải do người dùng phán xét. Ngược lại,
đừng bắt người dùng chỉ ra một câu lệnh build hay một đường dẫn file mà bằng chứng cục bộ
xác lập được.

Hãy làm ra một contract tương xứng, ví dụ:

```text
Outcome: observable result
Evidence: check/artifact and expected behavior
Scope: owned paths; exclusions
Constraints: requirement + source; distinguish technical choices
Context: relevant artifacts
Verification: fast check; final checks
Done: completion condition
Blocked if: material missing decision or prerequisite
```

Với một task đã được cấp quyền, một contract rõ ràng là đủ để tiến hành; skill này không
thêm cổng duyệt nào. Nếu chỉ được yêu cầu soạn một contract, hãy trả nó về mà không bắt
đầu hiện thực. Chuyển một task nhiều mục sang sequence-execution-plan, hoặc một việc được
giao đơn lẻ sang prompt-leverage, và chỉ đọc skill kế tiếp khi cần.
