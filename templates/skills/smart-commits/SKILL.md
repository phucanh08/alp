---
name: smart-commits
description: Gói các thay đổi đã sở hữu thành những commit Git cục bộ gọn và tập trung, kèm bằng chứng kiểm chứng. Dùng khi commit được yêu cầu hoặc là một phần của handoff được giao; đừng kích hoạt chỉ vì vừa sửa một file.
---

# Gói các thay đổi đã được cấp quyền

Xác nhận đây là một repository Git và rằng các commit cục bộ thuộc về sản phẩm được
yêu cầu giao. Một task không dùng Git thì trả về artifact dạng file; đừng khởi tạo Git chỉ để
sinh ra một SHA. Một task chỉ đọc không được commit. Thẩm quyền người dùng đã cấp vẫn còn
hiệu lực; skill này không thêm cổng xác nhận nào và cũng không cấp quyền push.

Hãy xem xét root, nhánh, status, các lần merge chưa giải quyết, các đường dẫn đã stage, và diff
đã stage/chưa stage bằng các câu lệnh Git. Kiểm chứng mọi base revision được cấp. Giữ nguyên
phần việc nằm ngoài việc được giao. Nếu có các thay đổi đã stage không liên quan sẽ lọt vào
commit, hãy dừng việc đóng gói và báo xung đột đó, đừng reset hay bỏ stage phần việc của người
khác.

Nhóm các thay đổi theo hành vi và theo ý định. Giữ phần hiện thực cùng với test trực tiếp của
nó ở chỗ điều đó hữu ích. Đọc từng diff được đưa vào và chỉ stage các đường dẫn hay hunk mình
sở hữu. Tránh stage toàn bộ cây trong một checkout dùng chung. Đừng thêm các bản sửa hay chỉnh
format không liên quan để commit cho dễ.

Chạy các phép kiểm liên quan theo project/brief, dùng lại các kết quả gần đây khi chúng còn áp
dụng được. Nêu các chỗ fail và các chỗ bỏ sót cho chính xác. Nếu hook có thể gây tác dụng phụ
ra bên ngoài, hãy xem hành vi đã cấu hình của chúng trước khi gọi, và ở trong phạm vi thẩm
quyền của task. Đừng lách hook hay các cơ chế bảo vệ để lấy một commit xanh.

Soạn các thông điệp gọn và tập trung, giải thích thay đổi và mục đích của nó, theo
quy ước của repository. Kiểm xem commit có thành công trước khi đọc SHA ứng viên.
Xác minh rằng bản ứng viên chỉ chứa đúng phạm vi dự kiến, và quan hệ với base là
hợp lệ khi có cấp một base. Một lần commit fail thì không sinh ra bản ứng viên mới nào,
và một cây vốn đã sạch thì không cần một commit rỗng.

Đừng viết lại một bản ứng viên đã được handoff để review. Các bản sửa nên là những
commit mới, trừ khi việc viết lại đã được thống nhất riêng. Push đòi phải có thẩm quyền rõ ràng
đã cấp sẵn cho đúng remote/nhánh dự kiến; một remote đã cấu hình không hề cấp thẩm quyền đó.

Trả về root, nhánh, các SHA base/candidate thật, tóm tắt commit, phạm vi sở hữu, các phép kiểm
và kết quả, phần việc còn lại, và trạng thái push. Lead/main vẫn review artifact;
người ghi không tự nghiệm thu công việc của chính mình.
