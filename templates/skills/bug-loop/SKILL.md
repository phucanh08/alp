---
name: bug-loop
description: Chẩn đoán một bug hay regression bằng một vòng lặp phản hồi tái lập được, các cách giải thích cạnh tranh nhau, và bản sửa đã được kiểm chứng. Dùng khi test fail, khi hành vi sai, hoặc khi có regression về hiệu năng; việc được giao ở dạng chỉ đọc thì dừng trước khi sửa artifact của project.
---

# Dựng một vòng lặp fail trước, rồi sửa nguyên nhân

Bắt đầu từ hành vi được báo và phạm vi được giao. Tìm câu lệnh, request, bản replay
hay test nhỏ nhất mà vẫn hữu ích để phân biệt bug với hành vi đúng. Chạy nó và ghi lại
kết quả thực tế trước khi tuyên bố đã tái lập được. Với lỗi chập chờn, hãy ghi lại điều
kiện, seed khi có, và tần suất fail quan sát được.

Nếu việc tái lập cần credential, phần cứng, dữ liệu hay một hành động của người dùng mà
bạn không có, hãy báo đúng chỗ thiếu đó cho agent giao việc; main lo phần giao tiếp với
người dùng. Vẫn tiếp tục điều tra hữu ích trong phạm vi, nhưng hãy ghi rõ giả thuyết nào
chưa được xác nhận. Đừng tuyên bố một bản sửa đã được kiểm chứng khi chưa có một phép
kiểm quan sát được và có ý nghĩa.

Thu nhỏ bản tái lập mà không làm mất lỗi. Ở chỗ nguyên nhân còn chưa chắc, hãy dựng các
cách giải thích cạnh tranh nhau, mỗi cách kèm một dự đoán quan sát được. Thăm dò vài điểm
phân biệt được chúng; đổi mỗi lần một biến. Ưu tiên bằng chứng đo được hơn là chồng thêm
các cách lách cho cùng một triệu chứng chưa giải thích được.

Dùng không gian scratch riêng biệt cho các thí nghiệm dùng một lần. Việc được giao ở dạng
chỉ đọc có thể xem xét và chẩn đoán; nó không cho phép sửa code của project để chèn công
cụ đo. Với việc về hiệu năng, hãy so các khối việc tương đương và ghi lại các điều kiện
liên quan, để một chênh lệch thời gian không bị hiểu nhầm thành cải thiện có nhân quả.

Khi nguyên nhân đã được xác lập và bạn đã được cấp quyền ghi:

1. Đặt một phép kiểm regression ngay tại đường ráp tái lập được lỗi thực tế.
2. Xác nhận phép kiểm đó fail đúng vì lý do đã báo trên hành vi bị lỗi.
3. Làm bản sửa nhỏ nhất mà vẫn nhất quán với contract dự kiến.
4. Chạy lại phép kiểm đó, rồi các phép kiểm liên quan xung quanh và tình huống ban đầu.
5. Bỏ công cụ đo tạm thời và hoàn lại mọi chỗ cố tình chèn lỗi.

Đọc [test proof](references/test-proof.md) khi thiết kế/review test regression, hoặc khi
nó pass ngay trước lúc sửa. Đừng làm yếu kỳ vọng, đừng bỏ qua phép kiểm đang fail, và đừng
mock cho hành vi biến đi để tạo ra một lần pass. Một yêu cầu đã thay đổi phải được xác lập
độc lập với cái mà implementation hiện trả về.

Trả về câu lệnh tái lập và kết quả, nguyên nhân đã xác lập hoặc các giả thuyết còn lại,
artifact đã thay đổi, phép kiểm trước/sau, các giới hạn, và rủi ro chưa xử lý.
Peer trả về cho lead; lead trả về cho main. Điều tra ở dạng chỉ đọc trả về bằng chứng
chẩn đoán và một bản sửa đề xuất, không phải một thay đổi code tưởng tượng.
