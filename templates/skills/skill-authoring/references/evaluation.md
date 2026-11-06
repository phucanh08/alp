# Đánh giá skill

Đọc khi dựng các tình huống kích hoạt cho một skill và khi chạy lượt đánh giá khan của nó.

## Bảng tình huống
Viết 8-12 dòng trước khi tuyên bố skill hoạt động được. Trộn các ca dương, âm và nhập nhằng.

| # | Task (theo cách người yêu cầu sẽ nói) | Role | Skill mong đợi | Không được chọn | Loại |
|---|---|---|---|---|---|
| 1 | "Thêm test cho endpoint hoàn tiền mới" | lead | test-strategy | bug-loop | positive |
| 2 | "Test hoàn tiền fail từ hôm qua" | peer | bug-loop | test-strategy | negative |
| 3 | "Thêm endpoint hoàn tiền và test của nó" | lead | feature-architecture, rồi test-strategy | - | ambiguous |

- Chỉ dùng những skill thực sự được gán cho role ở dòng đó.
- Các dòng âm lấy từ những skill lân cận gần nhất được nêu trong mục "Không dùng cho".
- Các dòng nhập nhằng phải kết thúc bằng một cách giải quyết: một trình tự, một điều kiện phân
  định thêm vào một description, hoặc một chỗ chồng lấn được chấp nhận và nêu rõ trong cả hai
  skill.

## Kiểm điều kiện kích hoạt
1. Đưa cho một agent mới, hoặc cho chính bạn khi chưa đọc thân bài, chỉ các dòng index (tên
   cộng description) của các skill thuộc role đó cùng với đoạn chữ của task.
2. Ghi lại nó chọn skill nào và những chữ nào đã quyết định điều đó.
3. Trượt ở một dòng dương, hay trúng ở một dòng không được chọn, đều là khuyết điểm của
   description; hãy sửa rồi chạy lại cả bảng, không chỉ dòng bị fail.

## Lượt chạy khan
1. Chọn một task thật, nhỏ, từ project hoặc từ lịch sử của nó.
2. Theo thân bài sát từng chữ, theo đúng thứ tự, chỉ đọc reference khi một bước link tới nó.
3. Ghi lại mọi chỗ bạn phải đoán, phải bỏ qua, hay phải ứng biến: mỗi chỗ là một hướng dẫn còn
   thiếu hoặc bị sai.
4. Ghi lại bất kỳ bước nào không tạo ra output quan sát được: hãy siết nó lại hoặc xoá nó.
5. Nếu skill có script, hãy chạy chúng trên input thật và trên một ca thiếu dependency.

## Bản ghi bằng chứng
Giữ cùng với đề xuất hoặc handoff:
- bảng tình huống kèm lựa chọn thực tế và pass hay fail cho từng dòng;
- task đã chạy khan, các bước phải sửa, và đã sửa gì;
- output của `alp skill check <name> --strict`;
- các khoảng trống đã biết mà chưa được đánh giá.

## Đừng tuyên bố
- Chất lượng chỉ vì bộ kiểm pass: nó kiểm định dạng, không kiểm mức hữu dụng.
- Độ phủ từ những tình huống bạn viết ra mà chưa chạy.
- Có cải thiện từ một lần sửa mà chưa chạy lại đúng các tình huống đã thúc đẩy lần sửa đó.
