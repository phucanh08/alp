# Hướng dẫn dự án ALP

## Quan hệ làm việc

Người dùng (user) trao đổi với main. Team được cố định cho mỗi session:

- Phở: main sở hữu việc giao hàng và thực thi kỹ thuật; main tự làm trực tiếp
  hoặc giao việc có giới hạn cho peer. Không có lead riêng.
- Cafe: main sở hữu kết quả và giám sát lead; lead tự làm hoặc giao việc cho peer. Main đưa
  các thay đổi triển khai đi qua lead.

Ở cả hai team, main chạy trên model và effort mà team và `.alp/settings.json` của project
cấu hình cho nó (template này không cố định chúng), mặc định với toàn quyền truy cập, và khởi
động một supervisor để review quy trình sau mỗi lượt của main. Supervisor hỏi main về các sai sót; main trả lời và ghi lại bài học (lesson) mà sau đó
nó phải tuân theo.

Oracle đưa lời khuyên chỉ đọc qua các lăng kính model được cấu hình; reviewer review độc lập
một diff. Cả hai chỉ trả kết quả một lần, và chỉ về cho điều phối viên (coordinator) đã gọi.
Chúng không sinh thêm agent. Số peer chạy đồng thời tối đa là giới hạn mà instruction
runtime nêu; chỉ nâng giới hạn đã cấu hình khi người dùng yêu cầu. Các lựa chọn model và
effort khác thuộc về điều phối viên kỹ thuật. Một role không cấp thêm quyền filesystem,
credential hay tool runtime nào.

## Hợp đồng làm việc chung

- Đọc hướng dẫn dự án và AGENT.md của agent được chọn. Chỉ nạp skill khi cần; đừng mặc định
  rằng skill hay tool của một runtime khác có tồn tại.
- Mỗi việc được giao (assignment) phải nêu mục tiêu, root, đường dẫn sở hữu/bị loại trừ, các
  ràng buộc và nguồn của chúng, cách kiểm chứng, tài nguyên, người sở hữu, và handoff mong
  đợi.
- Mỗi checkout dùng chung chỉ giữ một người ghi. Chuyển quyền ghi trước khi main hay lead
  can thiệp vào file của một peer. Nhiều người ghi song song cần workspace tách biệt và thỏa
  thuận rõ ràng về interface dùng chung.
- Trả về artifact và bằng chứng kiểm chứng thật, kèm những rủi ro còn lại. Thông báo hoàn
  thành của người làm chỉ là một candidate, không phải verdict nghiệm thu độc lập.
- Review phải độc lập với người viết: điều phối viên review công việc của peer; ở Cafe, main
  review công việc của lead. Dùng reviewer cho thay đổi logic và thay đổi rủi ro, kể cả thay
  đổi do chính main viết. Hãy nói rõ khi không có review độc lập, thay vì nhận rằng đã có.
- Thay đổi về phạm vi hay ưu tiên phải đi qua kế hoạch hiện tại của điều phối viên kỹ thuật
  và brief đã sửa của peer bị ảnh hưởng. Câu hỏi trực tiếp có thể được trả lời trực tiếp;
  một can thiệp ngoại lệ phải được dung hòa vào cùng trạng thái dùng chung đó.
- Task nằm trong `.alp/tasks` và được chia sẻ với người dùng. Chỉ người dùng và main tạo hay
  sửa chúng; các agent khác đọc chúng và báo việc chúng tìm thấy cho người giao việc của
  mình.
- Chỉ dùng năng lực giao việc/gửi tin thật sự có trong runtime. Khi không có, hãy giải thích
  giới hạn đó, tự làm trực tiếp phần việc được phép, và tuyệt đối không nhận rằng một
  session lead hay peer đã chạy hay đã review bất cứ thứ gì.

## Ràng buộc riêng của dự án

Thêm kết quả mong muốn, biên giới, các lệnh kiểm chứng và yêu cầu phê duyệt của dự án vào
đây. Hướng dẫn của người dùng có ưu tiên cao hơn quy trình khởi điểm này.
