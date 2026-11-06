# Test backend

Đọc khi chọn test handler, service, integration, hay contract cho một thay đổi
backend. Việc cần test những gì nói chung thuộc test-strategy; đây nói về cách làm ở từng seam.

Dùng test runner, fixture và helper hiện có của dự án (ví dụ Jest hay Vitest cho
Node/TypeScript, pytest cho Python, `go test` cho Go). Đừng thêm framework test hay
công cụ container mà không có quyết định của owner.

## Chọn seam

| Seam | Chứng minh | Thay thế bằng |
| --- | --- | --- |
| Unit service / nghiệp vụ | quy tắc nghiệp vụ, ca biên, map lỗi | fake cho store, clock, client |
| Handler / route | parsing, validation, status code, nối auth, hình dạng lỗi | server in-process; service thật hoặc fake |
| Integration | truy vấn, transaction, constraint, migration | database thật cùng engine |
| Contract | hình dạng request và response đã thống nhất với bên tiêu thụ hoặc bên cung cấp | contract đã ghi lại hoặc dựa trên schema |
| Đầu-cuối | một luồng quan trọng xuyên nhiều process | chỉ trong môi trường test |

Đặt phần lớn các ca ở seam rẻ nhất mà vẫn chạy qua nguyên nhân thật. Một bug truy vấn
cần engine database thật; một quy tắc validation thì không.

## Test service

- Tiêm dependency (store, clock, bộ sinh ID, client gọi ra ngoài) để test kiểm soát
  được chúng. Một fake viết tay có hành vi thật hơn một mock chỉ ghi lại lời gọi.
- Phủ từng ca của contract: thành công, từng lỗi nghiệp vụ, giá trị biên, và việc
  chạy lại idempotent.
- Đóng băng thời gian và ngẫu nhiên thay vì sleep hay assert theo khoảng.

## Test handler

- Chạy handler qua test client in-process của framework (ví dụ request kiểu
  supertest, test client của FastAPI hay Django, `httptest` trong Go).
- Assert status, code lỗi, và các field body quan trọng; tránh assert toàn bộ body
  khi chỉ vài field là thuộc contract.
- Test các đường authentication và authorization: thiếu credential, sai user, sai
  tenant, role đủ quyền.
- Test các ca validation thất bại, kể cả field quá lớn và field không biết.

## Test integration với database thật

- Dùng cùng engine và cùng major version như production. SQLite không thay được cho
  hành vi của PostgreSQL hay MySQL (kiểu dữ liệu, locking, lỗi constraint).
- Chạy nó theo cách dự án đã làm: một test container, một service local, hay một
  service trong CI. Nếu chưa có, hãy đề xuất; đừng tự cài.
- Áp migration thật lên database test, không dùng schema viết tay.
- Cô lập các test: một transaction được rollback mỗi test, một schema mới mỗi worker,
  hay truncate giữa các test. Đừng phụ thuộc thứ tự test.
- Chỉ seed dữ liệu mà một test cần, qua factory hoặc builder, ngay trong test đó.
- Đừng bao giờ trỏ test vào database dùng chung hay production.

## Dependency gọi ra ngoài

- Fake HTTP của bên thứ ba ở biên client (một stub server local hoặc công cụ mock
  HTTP của dự án). Đừng gọi service bên ngoài thật trong test.
- Test cả response timeout và lỗi từ dependency, không chỉ thành công.
- Dùng credential test hoặc giá trị giả; đừng bao giờ dùng key thật.

## Background job

- Chạy handler trực tiếp với một message; assert hiệu ứng.
- Chạy nó hai lần với cùng message; assert không có hiệu ứng lặp.
- Làm handler fail; assert số lần retry và trạng thái thất bại cuối.

## Test contract

- Khi một team hay service khác tiêu thụ API, hãy kiểm tra hình dạng đối chiếu với
  schema đã thống nhất (OpenAPI, protobuf, JSON Schema) hoặc consumer contract, dùng
  công cụ hiện có của dự án.
- Một test contract fail vì thay đổi của bạn nghĩa là một thay đổi phá vỡ; hãy chuyển
  quyết định lên thay vì sửa contract cho pass.

## Vệ sinh

- Không sleep để đồng bộ; hãy chờ một điều kiện hoặc dùng clock điều khiển được.
- Không secret thật, dữ liệu cá nhân, hay dump production trong fixture.
- Một test mới phải fail khi chưa có thay đổi. Nếu nó pass trước khi sửa, nó không
  chứng minh được thay đổi (xem bug-loop).
- Giữ thời gian chạy test tương xứng; đánh dấu các test integration chậm theo cách dự
  án đã làm.
