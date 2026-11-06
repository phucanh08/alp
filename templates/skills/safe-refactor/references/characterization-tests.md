# Characterization test

Đọc khi ghim hành vi hiện tại trước một lần refactor, nhất là với code có ít test hoặc không có
test.

## Mục đích

Một characterization test ghi lại cái code đang làm, không phải cái nó nên làm. Nó là lưới an
toàn biến "hành vi được giữ nguyên" thành một tuyên bố có kiểm, thay vì một niềm hy vọng.

## Chọn đường ráp

- Test ở đường ráp cao nhất mà lần refactor không vượt qua: nếu bạn cấu trúc lại phần
  nội bộ của một module, hãy ghim các entry point public của module đó, không phải phần nội bộ.
- Nếu lần refactor di chuyển một interface, hãy ghim cả hai phía: kết quả mà bên gọi quan sát
  được và output của phần code bị di chuyển.
- Ưu tiên hạ tầng và phong cách test đang có; chỉ thêm một harness mới khi không có cái nào
  với tới được đường ráp đó, và giữ nó trong các đường dẫn sở hữu.

## Cách viết

1. Liệt kê các input kích hoạt từng nhánh bạn sẽ chạm: điển hình, rỗng, biên,
   không hợp lệ, cỡ lớn, các ca biên về unicode hay encoding, và các đường lỗi.
2. Chạy code hiện tại trên từng input rồi ghi lại output thực tế, giá trị trả về,
   kiểu lỗi được ném ra và thông điệp của nó, các tác dụng phụ (file, lời gọi, log), và thứ tự.
3. Khẳng định đúng cái đã ghi lại, kể cả hành vi lạ. Đánh dấu các ca gây bất ngờ
   bằng một comment như "pinned current behavior; possible bug, reported".
4. Chạy các test đó trên code chưa đổi; tất cả phải pass. Một test fail nghĩa là bản
   ghi lại bị sai, không phải code sai.
5. Chứng minh lưới bắt được thay đổi: tạm đổi một nhánh bạn sẽ chạm rồi xác nhận
   có ít nhất một test fail, sau đó hoàn lại.

## Golden output và snapshot

- Với các output lớn hay có cấu trúc (chữ đã render, dữ liệu đã serialize, output CLI),
  hãy chụp một golden file từ code hiện tại rồi diff đối chiếu với nó.
- Chuẩn hoá các chỗ không tất định trước khi so: timestamp, ID ngẫu nhiên, đường dẫn
  tuyệt đối, thứ tự của map, locale. Gieo seed cho phần ngẫu nhiên ở chỗ code cho phép.
- Soi golden file bằng mắt một lần; một snapshot của trang lỗi thì chẳng ghim được gì hữu ích.

## Tác dụng phụ và phụ thuộc

- Ghi lại các lời gọi tới bên cộng tác bằng một fake hay spy đặt ở biên module, không phải
  nằm sâu trong code đang được refactor.
- Với các tác dụng phụ trên filesystem, hãy chạy trong một thư mục tạm và khẳng định cây kết
  quả.
- Đừng gọi service bên ngoài thật; dùng các fake đang có của project hoặc các fixture đã
  thu lại.

## Giữ hay bỏ chúng

- Giữ các characterization test phủ hành vi public; chúng trở thành test
  regression.
- Bỏ hoặc viết lại những test ghim phần nội bộ mà lần refactor cố tình loại bỏ,
  sau khi lần refactor đã được kiểm chứng, và nói rõ điều đó trong handoff.
- Đừng bao giờ sửa một giá trị mong đợi để một lần chạy sau refactor pass. Đó là một thay đổi
  hành vi và nó cần một quyết định.
