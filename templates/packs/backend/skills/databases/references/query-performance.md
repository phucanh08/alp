# Hiệu năng truy vấn

Đọc khi thêm index, đọc output EXPLAIN, sửa N+1, phân trang, hay
chọn transaction và isolation.

Hãy đo trước khi đổi bất cứ thứ gì. Ghi lại chính xác truy vấn kèm tham số của nó
(query log của ORM hoặc slow-query log của database trong môi trường test), số dòng
liên quan, và plan. Đo lại trên dữ liệu tương đương sau mỗi thay đổi.

## Đọc plan

- PostgreSQL: `EXPLAIN (ANALYZE, BUFFERS)`; MySQL: `EXPLAIN ANALYZE` (8.0.18+) hoặc
  `EXPLAIN FORMAT=TREE`; SQLite: `EXPLAIN QUERY PLAN`. ANALYZE chạy thật truy vấn:
  chỉ chạy nó trên database test, và bọc các lệnh ghi trong transaction rồi rollback.
- Hãy tìm: sequential scan hay full scan trên bảng lớn, số dòng ước lượng lệch xa số
  dòng thực tế (statistics cũ), sort hay hash tràn ra đĩa, nested loop trên input
  lớn, và filter chỉ áp sau khi đã lấy nhiều dòng.
- Plan phụ thuộc khối lượng dữ liệu và statistics. Một plan trên mười dòng nói lên rất
  ít; hãy dùng khối lượng đại diện hoặc nói rằng kết quả chỉ là tạm thời.

## Index

- Index các cột dùng trong WHERE có tính chọn lọc, JOIN, và ORDER BY trên bảng lớn.
- Thứ tự cột trong composite index: cột so sánh bằng trước, rồi cột khoảng hay cột
  sắp xếp. Một index trên (a, b) phục vụ filter theo a, hoặc a và b, không phải b một mình.
- Một covering index (bao cả các cột được chọn) có thể tránh phải tra lại bảng cho các
  lượt đọc nóng.
- Index một phần hoặc có filter phù hợp với truy vấn trên một tập con nhỏ (`WHERE
  deleted_at IS NULL`).
- Hàm áp lên một cột (`lower(email)`) vô hiệu hóa index thường; hãy dùng index trên
  biểu thức hoặc lưu một cột đã chuẩn hóa.
- Ký tự đại diện ở đầu (`LIKE '%x'`) không dùng được index B-tree; full-text search là
  quyết định của owner nếu cần.
- Mỗi index làm ghi chậm hơn và chiếm dung lượng. Chỉ xóa index không dùng hay trùng
  lặp khi có bằng chứng là nó không được dùng.
- Document store: tạo index khớp với hình dạng truy vấn và thứ tự sắp xếp; kiểm tra
  output explain xem có collection scan không.

## Truy vấn N+1

- Dấu hiệu: một truy vấn cho danh sách, rồi một truy vấn cho mỗi phần tử. Tìm nó trong
  query log hoặc bằng cách đếm số truy vấn trong một test.
- Sửa bằng eager loading của ORM hoặc một truy vấn `WHERE id IN (...)` theo lô; trong
  GraphQL hay các resolver tương tự, dùng một loader gom lô theo từng request.
- Thêm một test assert số truy vấn cho endpoint khi dự án có helper cho việc đó.
- Đừng lấy quá nhiều: chỉ load các cột và quan hệ mà người gọi dùng.

## Phân trang

- Phân trang keyset: `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC,
  id DESC LIMIT $n`, dựa trên một index trên cùng các cột đó. Chi phí mỗi trang là hằng.
- OFFSET quét rồi bỏ các dòng bị nhảy qua; chi phí tăng theo độ sâu. Chấp nhận được
  với tập nhỏ.
- Luôn đưa một khóa phá thế bằng duy nhất vào thứ tự sắp xếp.
- `COUNT(*)` chính xác trên bảng lớn thì đắt; hãy dùng ước lượng hoặc bỏ nó khi sản
  phẩm cho phép.

## Transaction

- Giữ transaction ngắn. Không gọi mạng, không chờ người dùng, không vòng lặp lớn bên trong.
- Nhóm các lệnh ghi phải cùng thành công hoặc cùng thất bại; không gì khác.
- Lock các dòng theo một thứ tự nhất quán xuyên các đường code để tránh deadlock;
  retry khi gặp lỗi deadlock hay serialization với số lần có giới hạn.
- Chỉ dùng `SELECT ... FOR UPDATE` (hoặc `SKIP LOCKED` cho job queue) ở nơi bạn buộc
  phải tuần tự hóa truy cập vào các dòng cụ thể.
- Transaction chạy lâu chặn vacuum (PostgreSQL) và giữ lock; hãy để mắt tới chúng
  trong các batch job.

## Mức isolation

| Mức | Ngăn được | Cần để ý |
| --- | --- | --- |
| Read committed (mặc định của PostgreSQL) | dirty read | non-repeatable read, lost update |
| Repeatable read (mặc định của MySQL InnoDB) | non-repeatable read | write skew; gap lock của MySQL |
| Serializable | mọi bất thường | lỗi serialization phải được retry |

- Với đọc-sửa-ghi, hãy ưu tiên một cập nhật nguyên tử (`SET n = n + 1`), một cập nhật
  có điều kiện kèm kiểm tra version, hoặc một row lock, hơn là nâng isolation toàn cục.
- SQLite tuần tự hóa các bên ghi; transaction ghi dài chặn các bên ghi khác.

## Các kiểm tra khác

- Luôn dùng truy vấn tham số hóa; chúng còn cho phép tái dùng plan.
- Kích thước connection pool nên vừa với giới hạn của database; nhiều kết nối hơn có
  thể chậm hơn.
- Tránh `SELECT *` trên bảng rộng ở các đường nóng.
- Chỉ cache khi có một quy tắc vô hiệu hóa đã nêu rõ và có sự đồng thuận của owner.
