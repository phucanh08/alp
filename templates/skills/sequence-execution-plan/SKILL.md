---
name: sequence-execution-plan
description: Sắp thứ tự nhiều hạng mục công việc ALP theo phụ thuộc thật, theo kiểm chứng, và theo quyền ghi. Dùng khi main hay lead điều phối nhiều kết quả, hoặc khi phải lập lại kế hoạch sau một chỗ chặn, một tiền đề đã đổi, hay một lần bị từ chối.
---

# Sắp thứ tự công việc thực thi được

Dùng task contract và các bằng chứng có sẵn. Thẩm quyền lập kế hoạch đến từ việc được
giao hiện tại: main điều phối kết quả tổng thể; lead lập kế hoạch thực thi kỹ thuật
trong phạm vi được giao của mình. Peer báo các phụ thuộc chứ không tự sang tay quyền sở
hữu hay nới rộng kế hoạch.

Tách mức gấp ra khỏi thứ tự phụ thuộc. Một điều kiện tiên quyết có mức ưu tiên thấp hơn vẫn
có thể phải chạy trước, nhưng nó không đóng được kết quả có ưu tiên cao hơn. Một biện pháp
giảm nhẹ chỉ làm giảm tác động hiện tại; nó không phải bằng chứng của một bản sửa bền.

Hãy dựng các hạng mục nhỏ mà mỗi hạng mục đều mang lại tiến triển quan sát được. Giữ phần hiện
thực và phần kiểm chứng trực tiếp của nó cùng chỗ. Hãy tách ra khi một quyết định chưa ngã ngũ
chặn một phần, khi các kết quả riêng cần được nghiệm thu độc lập, hoặc khi một lần chờ tài
nguyên/chờ người sẽ làm nghẽn công việc không liên quan. Đừng áp một số lượng task cố định lên
một thay đổi đơn giản.

Với mỗi hạng mục, hãy xác định kết quả, người sở hữu, đường dẫn sở hữu/bị loại, các điều kiện
tiên quyết thật, đường ráp để kiểm chứng, bằng chứng hoàn thành, và trạng thái hiện tại. Phân
biệt phần nền bắt buộc với phần cải thiện tuỳ chọn và những abstraction phỏng đoán cho tương
lai.

Xếp thành Now, Next và Later kèm giải thích nhân quả: điều kiện tiên quyết nào chặn
kết quả nào, phép kiểm nào xác nhận nó, và quyết định nào mở ra nhánh kế tiếp.
Đọc [định dạng kế hoạch](references/plan-template.md) khi một kế hoạch nhiều hạng mục có tính bền
là hữu ích. Dùng chỗ đặt kế hoạch mà project đã có; đừng tạo các quy tắc ignore không liên quan
hay một cây phân cấp lập kế hoạch mới chỉ để thoả skill này.

Việc giao việc trên Paseo hiện tại là tuần tự: mỗi agent cha chờ kết quả của một agent con.
Đừng hứa hẹn có nhiều worker chạy song song hay có hộp thư ngược lên trong lúc chạy. Một
checkout dùng chung chỉ có một người ghi tại một thời điểm; main muốn can thiệp thì quyền sở
hữu phải được nhả ra trước. Hãy cấp phát port, đường dẫn scratch và các tài nguyên độc quyền
khác nếu việc được giao có dùng chúng. Chỉ riêng việc tách worktree không hề cô lập port hay
một cơ sở dữ liệu dùng chung.

Hãy lập lại kế hoạch khi bằng chứng làm đổi một tiền đề, khi một phụ thuộc chặn công việc, khi
người dùng đổi phạm vi, hoặc khi bị từ chối nhiều lần cho thấy việc được giao cần cấu trúc lại.
Cập nhật các dữ kiện và ràng buộc trước khi phát ra một brief đã sửa. Giữ lại các tiêu chí
nghiệm thu chưa xong khi gộp các hạng mục. Bản ứng viên vẫn chỉ là ứng viên cho tới khi
reviewer có trách nhiệm đã đánh giá chính bằng chứng thật.
