---
name: backend-development
description: "Xây dựng tính năng phía server trong stack hiện có của dự án: API endpoint, logic service, tích hợp auth, xử lý lỗi và background job. Dùng khi thêm hoặc sửa handler, service, kiểm tra quyền, lời gọi ra ngoài, hoặc job. Không dùng cho thiết kế schema hay migration (databases), cũng không cho deployment và hạ tầng (devops)."
---

# Phát triển backend

## Khi nào dùng

- Thêm hoặc sửa một endpoint HTTP hay RPC, một service, hoặc logic nghiệp vụ.
- Nối authentication hoặc authorization vào một đường đi của request.
- Định hình lỗi, retry, timeout và log trong code phía server.
- Thêm một background job, queue consumer, webhook receiver, hoặc scheduled task.
- Một cố vấn (advisor) hoặc reviewer chỉ đọc được hỏi code backend có vững không (chỉ tư vấn).

## Không dùng cho

- Thiết kế schema, migration, index, hay truy vấn chậm: dùng databases.
- Deployment, container, CI/CD, hay hạ tầng: dùng devops.
- Quyết định cần test những gì cho một thay đổi: dùng test-strategy.
- Một test fail hoặc một regression: dùng bug-loop.
- Audit bảo mật cho một thay đổi: dùng security-review.
- Chọn framework, ngôn ngữ, hay kiểu kiến trúc mới: quyết định của owner.

## Điều kiện tiên quyết

- Đường dẫn sở hữu và tiêu chí nghiệm thu trong brief; ALP.md và chỉ dẫn của dự án.
- Stack thực tế, đọc từ manifest, lockfile và config (ví dụ `package.json` cho
  Node/TypeScript, `pyproject.toml` cho Python, `go.mod` cho Go). Đừng suy ra stack
  từ tên thư mục.
- Một hoặc hai endpoint hay service hiện có gần giống task. Chúng định ra quy ước về
  routing, validation, lỗi, logging và test.
- Lệnh lint, typecheck và test của dự án, cùng cách chúng chạy ở local.

## Quy trình

1. Nêu lại contract: input, output, các ca lỗi, ai được gọi, và side effect. Quy tắc
   sản phẩm mà brief để mở thì chuyển lên; đừng đoán.
2. Tìm các mối nối (seam): transport (routing, parsing, status code), logic service
   hay nghiệp vụ, truy cập dữ liệu. Theo đúng phân lớp hiện có; giữ chi tiết
   transport ra ngoài code service.
3. Định hình interface theo đúng kiểu API hiện có của dự án. Đọc api-design.md khi có
   resource mới, phân trang, idempotency, versioning, hoặc quy tắc validation.
4. Validate input ở biên bằng cách tiếp cận validation hiện có của dự án. Từ chối
   input sai dạng hoặc không nhận biết được bằng một lỗi client rõ ràng.
5. Authenticate một lần ở biên; authorize theo từng resource tại nơi resource được
   load. Đọc authentication.md khi chạm vào login, session, token, hoặc role.
6. Hiện thực logic service thành các đơn vị nhỏ với dependency tường minh (data
   store, client, clock, config) để test có thể thay thế chúng.
7. Xử lý thất bại có chủ đích: map lỗi nghiệp vụ sang response ở một chỗ, đặt timeout
   cho mọi lời gọi ra ngoài, chỉ retry việc idempotent. Đọc error-handling.md.
8. Với background work: làm handler an toàn khi chạy hai lần, giới hạn retry kèm
   backoff, ghi lại trạng thái thất bại cuối, chỉ enqueue sau khi dữ liệu đã commit,
   và không bao giờ giữ transaction mở xuyên qua một lời gọi ra ngoài.
9. Thêm test tại những seam mà thay đổi chạm tới. Đọc testing.md.
10. Chạy lint, typecheck và test của dự án. Gọi thử endpoint một lần với server local
    hoặc server test khi môi trường cho phép.
11. Handoff: file đã đổi, tóm tắt contract, lệnh đã chạy kèm kết quả, thay đổi schema
    hay config còn cần (và ai sở hữu chúng), và các quyết định còn mở.

Một agent chỉ đọc chạy bước 1-3 và review bước 4-8 đối chiếu với code hoặc đề xuất,
rồi báo các phát hiện và thay đổi được khuyến nghị thay vì tự sửa.

## Ràng buộc

- Theo stack và quy ước hiện có của dự án trước đã. Express, Fastify, NestJS,
  FastAPI, Django, Flask, hay Go net/http là ví dụ, không phải khuyến nghị.
- Không thêm dependency, framework, hay service mà không có quyết định của owner.
  Không tự cài. Nếu một library có ích, hãy đề xuất kèm lý do và chuyển lên.
- Không bao giờ hardcode secret hay đọc giá trị secret; dùng cơ chế config của dự án
  và config ví dụ đã có tài liệu. Không bao giờ log token, password, hay dữ liệu cá
  nhân đầy đủ.
- Không đổi một contract công khai (tên field, status code, hình dạng lỗi) mà không
  có quyết định của owner; ưu tiên thay đổi chỉ thêm vào.
- Thay đổi schema chuyển cho người sở hữu migration, mô tả bằng skill databases.
- Ở trong đường dẫn sở hữu. Skill này không cho quyền push, release, deploy, hay sửa
  CI.

## Kiểm chứng

- Lint, typecheck và test của dự án pass trên cây cuối cùng.
- Test mới fail khi chưa có thay đổi và pass khi đã có.
- Mọi ca lỗi trong contract có một test, hoặc một lý do đã nêu vì sao không có.
- Đường authorization bị từ chối đã được test (sai user hoặc thiếu role).
- Không có secret, token, hay dữ liệu cá nhân thật trong code, log, fixture, snapshot.
- Request đã được gọi thử đầu-cuối một lần, hoặc handoff nói vì sao không.

## Xử lý khi thất bại

- Không chạy được test (thiếu database, service, hay credential): báo đúng khoảng
  trống đó và những gì đã kiểm chứng thay thế. Đừng mock bỏ hành vi đang thay đổi.
- Quy ước xung đột hoặc thiếu: theo mẫu đã thiết lập gần nhất và ghi lại chỗ không
  nhất quán. Đừng refactor code không liên quan.
- Xuất hiện một thất bại hay regression bất ngờ: chuyển sang bug-loop.
- Một điểm nhập nhằng ảnh hưởng hành vi, dữ liệu, hay bảo mật: dừng phần đó và chuyển lên.

## Tài liệu tham khảo

- [references/api-design.md](references/api-design.md) — đọc khi thiết kế resource hoặc endpoint mới, hoặc chọn status code, phân trang, idempotency, versioning, hay validation (bước 3).
- [references/authentication.md](references/authentication.md) — đọc khi chạm vào login, session, token, OAuth/OIDC, lưu password, hay kiểm tra quyền (bước 5).
- [references/error-handling.md](references/error-handling.md) — đọc khi map lỗi sang response, thêm retry hay timeout, hoặc quyết định log những gì (bước 7).
- [references/testing.md](references/testing.md) — đọc khi chọn test handler, service, integration, hay contract (bước 9).
