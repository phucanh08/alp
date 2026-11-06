---
name: xia
description: Nghiên cứu một implementation chưa quen, một cơ hội tái dùng, hay một tích hợp nhạy cảm với version, dựa trên artifact cục bộ và các nguồn sơ cấp. Trả về một khuyến nghị có bằng chứng hậu thuẫn trước khi hiện thực; đừng mở rộng phạm vi được giao.
---

# Nghiên cứu trước khi xây

Bắt đầu từ một câu hỏi được nêu tên rõ ràng có ảnh hưởng tới một quyết định. Hãy xem xét cục bộ
một lượt ngắn khi đường ráp liên quan đã rõ; chỉ mở rộng ra các nguồn upstream khi câu hỏi
đòi phải vậy. Việc nghiên cứu là chỉ đọc đối với các artifact của project. Các thí nghiệm
tạm thời cần một chỗ scratch riêng biệt có sẵn và thẩm quyền phù hợp.

1. Xác lập stack thật từ manifest, lockfile, cấu hình, và các câu lệnh.
   Đọc ALP.md và các hướng dẫn liên quan của project. Đừng suy ra stack từ tên thư mục.
2. Tìm trong code, test, cấu hình, script và tài liệu lân cận để biết hành vi đang có
   và các phần tái dùng được. Ghi lại phạm vi đã tìm trước khi nói một thứ gì đó không có.
3. Với hành vi bên ngoài, hãy xem nguồn/ví dụ upstream sơ cấp và tài liệu
   chính thức khớp với version đang cài. Phân biệt hướng dẫn hiện hành với
   version mà project này thực sự dùng.
4. Chỉ so các phương án khả thi ở chỗ lựa chọn có ý nghĩa. Ưu tiên một năng lực
   cục bộ đang có, rồi một năng lực của dependency được hỗ trợ, rồi một bản thích nghi nhỏ.
   Giải thích bằng chứng nào sẽ làm đổi khuyến nghị.

Dán nhãn các phát hiện quan trọng theo loại bằng chứng:

- Cục bộ: đường dẫn file, output câu lệnh, test, hay revision của repository.
- Upstream: URL repository và revision khi có.
- Tài liệu: nguồn chính thức và version áp dụng.
- Suy luận: một kết luận rút ra từ bằng chứng đã dẫn, kèm phát biểu rõ mức không chắc.

Nếu không duyệt web được, hãy trả về các phát hiện cục bộ và câu hỏi bên ngoài còn chưa giải
quyết. Đừng bịa ra một nguồn hay tuyên bố tương thích version mà không có bằng chứng.
Việc nghiên cứu không cấp quyền cài dependency, sửa code, hay triển khai.

Trả về câu hỏi, các phát hiện/nguồn, các ứng viên tái dùng, khuyến nghị, các phương án khác nếu
đáng kể, những điều chưa biết, và quyết định kế tiếp. Đưa các câu lệnh xem xét thật và kết quả
của chúng vào handoff. Peer trả cái này về cho lead; lead trả các quyết định về phạm vi còn
chưa giải quyết lên main. Main được quyết các vấn đề kỹ thuật trong thẩm quyền người dùng đã
cấp.

Chỉ dùng cơ chế giao việc đồng bộ có sẵn cho một việc nghiên cứu riêng khi điều đó hữu ích.
Đừng cho rằng có một role Scout hay một phiên song song nào tồn tại; nghiên cứu là một
disposition của peer. Một agent có thể tự xem xét bằng chứng mà không cần sinh ra một agent
khác.
