---
name: prompt-leverage
description: Chuyển một task thành một brief giao việc tự chứa, không làm đổi ý định của người dùng và không định sẵn giải pháp. Dùng trước khi main giao cho lead hoặc lead giao cho peer, hoặc khi được yêu cầu làm tốt hơn một prompt thực thi.
---

# Soạn một brief làm được việc

Xác định kết quả được yêu cầu và trách nhiệm của người nhận. Giữ nguyên các ràng buộc thật
sự của người dùng, nhưng phân biệt chúng với các lựa chọn thiết kế hiện tại mà người nhận
có quyền chất vấn. Đừng gieo trước verdict cho một reviewer, và đừng biến một implementation
mình thích thành một yêu cầu bịa ra.

Một brief hữu ích cung cấp root, kết quả cần đạt, context liên quan, đường dẫn sở hữu/bị loại,
thẩm quyền, các phụ thuộc quan trọng, tài nguyên, kiểm chứng, và handoff mong đợi.
Dùng [định dạng brief](references/brief-template.md) cho các việc được giao có khối lượng đáng kể;
gộp các field lại với một task nhỏ. Một base SHA thật thì hữu ích trong một repository Git
nhưng không bắt buộc với một project chỉ gồm file thường. Đừng bao giờ bịa ra một cái.

Phần kiểm chứng phải mô tả hành vi quan sát được và, khi đã biết, cả phép kiểm chạy được của
nó. Nếu còn phải đi tìm câu lệnh, hãy nói rõ nên xác lập nó từ repository bằng cách nào. Đừng
bịa ra một câu lệnh test chỉ để điền cho đủ field.

Chọn skill đã cài phù hợp theo loại việc và nêu tên nó trong brief:
nghiên cứu -> xia; chẩn đoán/regression -> bug-loop; một handoff có quyền commit ->
smart-commits. Đừng đòi những skill không có trong gói của người nhận. Một reviewer có thể
xem xét một bản ứng viên đang có mà không cần thêm nghi thức skill nào.

Gửi toàn bộ brief qua tool giao việc mà runtime của bạn thật sự cung cấp, cho một agent đã được
cấp quyền. Cách chọn model và effort cho người nhận, và việc có phải chọn hay không, lấy từ
instruction runtime của bạn (model profile của người nhận, catalog của runtime); đừng giả định
người nhận chạy trên model của bạn. Yêu cầu chỉ đọc cho việc nghiên cứu/review ở chỗ phù hợp.
Việc hiện thực cần workspace-write ở cả cha và con. Việc giao có thể chạy nền và trả kết quả
về sau; người nhận có thể hỏi lại hoặc không, tuỳ kênh mà runtime có. Vì vậy hãy đưa vào brief
mọi thứ cần thiết để làm xong việc mà không phải hỏi lại.

Skill này không cấp thẩm quyền mới nào và không bao giờ lách đồ thị định tuyến đã cấu hình. Nếu
chỉ được yêu cầu làm tốt hơn một prompt, hãy trả prompt về. Nếu việc giao đã được cấp quyền,
hãy gửi nó bằng tool thật của runtime sau khi soạn xong. Những năng lực còn thiếu phải được báo
cáo, không phải giả lập ra.
