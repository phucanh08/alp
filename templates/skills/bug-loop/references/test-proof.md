# Bằng chứng cho một bản sửa regression

Chọn một biên quan sát được, đủ gần để khoanh được lỗi nhưng đủ rộng để kích hoạt đúng
nguyên nhân thật của nó. Một unit test của một bên gọi không thể xác lập một bug phụ
thuộc vào thứ tự giữa nhiều bên gọi.

Hành vi mong đợi đến từ yêu cầu của người dùng, từ một contract được hỗ trợ, hoặc từ các
ví dụ suy ra một cách độc lập. Đừng tính kết quả mong đợi bằng chính implementation đang
được kiểm. Chỉ mock các biên bên ngoài ở chỗ việc mock vẫn giữ được hành vi được tuyên bố
nằm trong phạm vi kiểm.

Hãy mô tả bằng chứng cho chính xác:

- Chỉ xanh: phép kiểm hiện tại pass; chỉ riêng điều này không cho thấy có phủ regression.
- Đỏ -> xanh: phép kiểm fail trên hành vi bị lỗi và pass sau khi sửa.
- Chèn lỗi: ở chỗ rủi ro biện minh được, hãy dựng lại đúng khuyết điểm đó trong một bản
  sao riêng, xác nhận nó fail, hoàn lại bản sửa, rồi xác nhận nó thành công lần nữa.

Chèn lỗi là tuỳ chọn, trừ khi việc được giao bắt buộc. Đừng bao giờ sửa checkout của người
ghi khác, đừng bỏ đi công việc không liên quan, và đừng để lại code cố tình làm sai trong
sản phẩm giao. Hãy nêu rõ như một giới hạn khi không chạy được bản trước khi sửa hoặc khi
thiếu đường ráp để test.

Giữ lại đúng các câu lệnh, kết quả, và các điều kiện môi trường liên quan. Ảnh chụp màn
hình, log và hành vi quan sát bằng tay có thể bổ trợ cho test; đừng dán nhãn chúng thành
bằng chứng tự động. Một phép kiểm pass và một quyết định nghiệm thu độc lập là hai chuyện
khác nhau.
