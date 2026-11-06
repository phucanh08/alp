# Thiết kế điều kiện kích hoạt

Đọc khi soạn một description, khi chọn các điều kiện không kích hoạt, hoặc khi chữa một skill nổ vào sai task.

## Hình dạng
`<LÀM GÌ, động từ trước>. Dùng khi <các điều kiện kích hoạt cụ thể>. Không dùng cho <các skill lân cận> (dùng <skill>).`
- LÀM GÌ: output hay thay đổi nó tạo ra, bằng những chữ mà một yêu cầu công việc sẽ dùng.
- KHI NÀO: các tình huống và danh từ xuất hiện trong yêu cầu thật: "test đang fail", "endpoint
  mới", "ADR", "nhánh phát hành".
- KHÔNG DÙNG CHO: hai hay ba skill lân cận gần nhất, mỗi cái chỉ sang chủ của nó.
- Dồn các từ đặc trưng lên đầu; index có thể cắt chữ sau 400 ký tự.

## Chọn điều kiện kích hoạt
- Thu các cách diễn đạt thật từ các task, bài học và handoff trước đây rồi hãy viết.
- Ưu tiên danh từ chỉ công việc và kết quả, hơn là tên phương pháp mà người yêu cầu sẽ không
  nói.
- Một skill, một việc. Nếu danh sách KHI NÀO cần chữ "hoặc" để nối các việc không liên quan,
  hãy tách nó ra.

## Điều kiện không kích hoạt
- Nêu tên mọi skill đã cài có công việc kế cận; agent sẽ so các description với nhau.
- Phát biểu ranh giới dưới dạng một quy tắc quyết định: "đã có một lỗi tồn tại" thì về
  bug-loop; "thiết kế test cho hành vi mới" thì ở lại đây.
- Đừng liệt kê các việc không liên quan; nhiễu làm yếu ranh giới.

## Các chỗ chồng lấn nhập nhằng
| Chồng lấn | Giải quyết bằng cách |
|---|---|
| Hai skill đều hợp lý | Thêm điều kiện phân định vào cả hai description |
| Một task cần cả hai theo thứ tự | Nói "rồi dùng X" trong bước ở thân bài, không nói trong description |
| Skill của project che skill thư viện | Cùng tên thì thay thế nó; tên mới thì phải nêu rõ phạm vi hẹp hơn của nó |

## Ví dụ
Tệ: `"Giúp làm tài liệu."` Không có LÀM GÌ, không có KHI NÀO, khớp với mọi thứ.

Tệ: `"Dùng khi cần cho kiến trúc, test, tài liệu, review hay lập kế hoạch."` Năm việc,
không có ranh giới, không có output.

Tốt: `"Viết và cập nhật tài liệu kiến trúc và ADR từ bằng chứng trong repository. Dùng khi một
ranh giới, một contract hay cấu trúc module đổi, hoặc khi tài liệu còn thiếu. Không dùng cho
thiết kế ở mức feature (dùng feature-architecture)."`

Tốt: `"Soạn release note từ các thay đổi đã merge kể từ tag gần nhất. Dùng khi chuẩn bị một bản
phát hành hay một mục changelog. Không dùng để quyết định một bản phát hành có sẵn sàng hay
chưa (dùng release-readiness)."`

## Checklist chữa lỗi
- Nổ quá thường xuyên: thêm một mục "Không dùng cho" nêu skill lân cận đang bị giành việc; thu
  hẹp danh từ.
- Không bao giờ nổ: thêm những chữ mà yêu cầu thật dùng; đưa chúng lên đầu.
- Nổ đúng lý do nhưng thân bài bị bỏ qua: description hứa một thứ mà thân bài không
  giao được; hãy làm chúng khớp nhau.
