# Schema và migration

Đọc khi thiết kế bảng, constraint, hay hình dạng document, hoặc khi lập kế hoạch
migration expand/contract, backfill, tính đảo được, hay rủi ro lock.

## Đánh đổi khi chuẩn hóa

- Bắt đầu ở dạng chuẩn hóa (khoảng dạng chuẩn thứ ba): mỗi dữ kiện lưu một lần, liên
  kết bằng khóa. Nó giữ việc ghi đơn giản và ngăn các bất thường khi cập nhật.
- Chỉ phi chuẩn hóa cho một nhu cầu đọc đã đo được: một bộ đếm, một tổng hợp được
  cache, một field sao chép để tránh một join nóng. Ghi lại ai giữ bản sao đồng bộ
  (trigger, cùng transaction, hay một job) và cách phát hiện lệch.
- Dùng cột JSON cho các thuộc tính thật sự không có schema hoặc thưa, không phải để
  khỏi phải thiết kế các cột được truy vấn, lọc, hay ràng buộc.
- Document store: hình dạng document theo mẫu truy cập. Nhúng dữ liệu được đọc cùng
  nhau và có kích thước giới hạn; tham chiếu dữ liệu dùng chung, lớn, hay không giới
  hạn (mảng lớn lên vô hạn gây hại). Lên kế hoạch một field version schema khi hình
  dạng sẽ còn thay đổi.

## Khóa và kiểu dữ liệu

- Một primary key cho mỗi bảng; theo kiểu ID của dự án (bigint identity, UUID/ULID).
  Khóa UUIDv4 ngẫu nhiên làm phân mảnh index B-tree trên bảng lớn; ID có thứ tự theo
  thời gian tránh được điều đó ở nơi dự án cho phép.
- Dùng kiểu chính xác: decimal hay số nguyên theo đơn vị nhỏ nhất cho tiền, timestamp
  có múi giờ (hoặc UTC theo quy ước), enum hay check constraint cho các tập đóng, text
  kèm một check độ dài thay vì giới hạn varchar tùy ý.
- Lưu thời gian theo UTC; chuyển đổi ở biên.

## Constraint

- Mặc định NOT NULL; chỉ cho nullable khi sự vắng mặt có ý nghĩa.
- Foreign key cho các quan hệ, với một hành vi ON DELETE được chọn có chủ đích
  (restrict, cascade, set null).
- Unique constraint cho tính duy nhất nghiệp vụ (email theo từng tenant), không chỉ
  kiểm tra ở tầng app; kiểm tra ở tầng app sẽ bị đua.
- Check constraint cho các quy tắc giá trị mà engine có thể cưỡng chế.
- SQLite: foreign key cần bật theo từng kết nối; nhiều thao tác ALTER đòi phải dựng
  lại bảng. MySQL: check constraint chỉ được cưỡng chế từ 8.0.16.
- Đặt tên constraint và index nhất quán để các migration sau có thể tham chiếu chúng.

## Mở rộng rồi thu hẹp

Đổi một schema đang sống theo từng bước, mỗi bước tương thích với cả bản app cũ và mới:

1. Mở rộng: thêm cột, bảng, hay index mới. Cho nullable hoặc có default an toàn.
2. Ghi cả hai: deploy code ghi cả hình dạng cũ và mới.
3. Backfill các dòng hiện có sang hình dạng mới.
4. Đọc cái mới: chuyển các lượt đọc; kiểm chứng.
5. Thu hẹp: ngừng ghi hình dạng cũ, rồi xóa nó trong một migration sau.

Đổi tên một cột tại chỗ làm vỡ bản đang chạy; hãy dùng thêm-sao chép-chuyển-xóa.
Thêm NOT NULL cho một cột đang có: thêm một check hoặc validate ở một bước riêng
sau khi backfill, rồi mới đặt NOT NULL.

## Backfill

- Tách khỏi migration schema với bảng lớn.
- Chia lô theo khoảng primary key hoặc keyset (ví dụ 1k-10k dòng mỗi lô), commit theo
  từng lô, nghỉ giữa các lô nếu tải là vấn đề.
- Idempotent và tiếp tục được: chỉ chọn những dòng vẫn còn cần đổi.
- Log số lượng tiến độ, không log nội dung dòng.
- Kiểm chứng: số dòng còn cần đổi bằng không.

## Migration đảo được

- Cung cấp một bước down khi công cụ hỗ trợ và thay đổi có thể hoàn tác được.
- Thay đổi phá hủy dữ liệu thì không thể đảo thật sự; kế hoạch rollback là restore
  hoặc một bản sao được giữ lại. Hãy nói thẳng điều đó.
- Giữ mỗi migration nhỏ và một mục đích; đừng trộn thay đổi schema với thay đổi dữ
  liệu lớn.
- Đừng bao giờ sửa một migration đã được áp; hãy thêm một migration mới.

## Rủi ro locking

| Thao tác | Rủi ro | Dạng an toàn hơn |
| --- | --- | --- |
| Tạo index (PostgreSQL) | chặn các lượt ghi | `CREATE INDEX CONCURRENTLY` ngoài transaction |
| Tạo index (MySQL InnoDB) | thường là online | xác nhận `ALGORITHM=INPLACE, LOCK=NONE` |
| Thêm cột với default biến động | ghi lại cả bảng | thêm nullable, backfill, rồi mới đặt default |
| Đổi kiểu cột | thường là ghi lại | cột mới, backfill, đổi chỗ |
| Thêm foreign key / check trên bảng lớn | full scan dưới lock | PostgreSQL: `NOT VALID`, rồi `VALIDATE` |
| Thêm NOT NULL | scan dưới lock | check constraint đã validate trước |

- Đặt một lock timeout (ví dụ `SET lock_timeout` trong PostgreSQL) để một migration
  đang chờ sau một transaction dài fail nhanh thay vì chặn toàn bộ lưu lượng.
- Hành vi khác nhau theo engine và version; hãy xem tài liệu của version đang dùng.
