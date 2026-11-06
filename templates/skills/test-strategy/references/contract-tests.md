# Contract test

Đọc khi một thay đổi chạm tới một API, protocol, output CLI, event, schema hay định dạng file mà code khác hoặc người dùng khác dựa vào.

## Một contract test chứng minh điều gì
Rằng bên sản xuất vẫn phát ra, và bên tiêu thụ vẫn nhận, đúng hình dạng và ngữ nghĩa đã
thống nhất: tên field, kiểu, bắt buộc so với tuỳ chọn, mã trạng thái hay mã thoát, định dạng
lỗi, các bảo đảm về thứ tự và quy tắc đánh version. Nó không chứng minh logic nghiệp vụ.

## Chọn hình thức
| Tình huống | Hình thức |
|---|---|
| Đã có schema (OpenAPI, JSON Schema, proto, migration SQL) | Kiểm response hay bản ghi thật đối chiếu schema ngay trong test |
| Bên tiêu thụ và bên cung cấp nằm cùng một repository | Fixture dùng chung: test của bên cung cấp sinh ra nó, test của bên tiêu thụ đọc nó |
| Các team hay service tiêu thụ tách riêng | Contract do bên tiêu thụ dẫn dắt: bên tiêu thụ nêu kỳ vọng, bên cung cấp xác minh chúng trong build của mình |
| Output dạng chữ hay dạng file (CLI, báo cáo, file sinh ra) | Golden file so từng byte, kèm một đường cập nhật có review |
| Protocol trên đường truyền hay luồng event | Các message đã thu lại, replay vào bộ phân tích và được bên sản xuất phát ra |

Ưu tiên cơ chế project đã dùng; đừng thêm một framework contract test
mà không có lần duyệt được chuyển lên main.

## Golden file
- Lưu cạnh test, đặt tên theo ca đó; review chúng như review code.
- Chỉ chuẩn hoá những phần thật sự biến thiên (timestamp, id, đường dẫn tuyệt đối) bằng một
  quy tắc tối giản và có ghi tài liệu.
- Cập nhật qua một câu lệnh hay một cờ rõ ràng, đừng bao giờ tự động cập nhật khi fail.
- Một diff của golden file trong một thay đổi phải được giải thích trong handoff.

## Kiểm tương thích ngược
- Các thay đổi dạng thêm vào (field tuỳ chọn mới, endpoint mới) phải để các fixture cũ vẫn
  pass.
- Bỏ hay đổi tên một field, đổi một kiểu, siết chặt việc kiểm tra, đổi một
  giá trị mặc định hay một mã lỗi đều là phá vỡ: hãy giữ một test với fixture cũ và xác nhận
  kế hoạch khai tử dần hay việc nâng version với main.
- Bên đọc nên chịu được các field lạ nếu contract nói vậy; hãy test điều đó.
- Dữ liệu đã lưu: test rằng code mới đọc được dữ liệu do version trước ghi, và,
  ở chỗ có hỗ trợ rollback, rằng code cũ đọc được dữ liệu do code mới ghi.
- API có version: giữ ít nhất một test cho mỗi version được hỗ trợ.

## Tập tối thiểu cho một thay đổi contract
1. Một fixture của hình dạng trước đây, vẫn được nhận (hoặc một lần phá vỡ đã ghi tài liệu và
   đã duyệt).
2. Một fixture của hình dạng mới, do test của bên cung cấp sinh ra.
3. Test của bên tiêu thụ đọc hình dạng mới.
4. Một ca về hình dạng lỗi: request không hợp lệ hay message sai dạng sinh ra đúng lỗi đã ghi
   tài liệu.
