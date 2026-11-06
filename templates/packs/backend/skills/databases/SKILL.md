---
name: databases
description: "Thiết kế schema, viết migration và backfill an toàn, và tối ưu truy vấn cho database quan hệ (PostgreSQL, MySQL, SQLite) và document store, dùng công cụ hiện có của dự án. Dùng khi thêm bảng hay collection, đổi constraint hay index, migrate dữ liệu, hoặc sửa truy vấn chậm. Không dùng cho logic API hay service (backend-development)."
---

# Cơ sở dữ liệu

## Khi nào dùng

- Thêm hoặc đổi bảng, cột, collection, constraint, hay index.
- Viết một migration schema, một backfill dữ liệu, hay một kế hoạch rollback.
- Chẩn đoán một truy vấn chậm, mẫu N+1, chờ lock, hay deadlock.
- Chọn biên transaction hoặc mức isolation cho một thao tác dữ liệu.
- Một cố vấn (advisor) hoặc reviewer chỉ đọc được hỏi để đánh giá một schema hay migration (chỉ
  tư vấn).

## Không dùng cho

- Endpoint, logic service, auth, hay map lỗi: dùng backend-development.
- Cấp phát hạ tầng, backup, replication, hay hosting database: dùng devops.
- Một test fail hay một regression dữ liệu chưa rõ nguyên nhân: dùng bug-loop.
- Chọn engine database, ORM, hay công cụ migration mới: quyết định của owner.

## Điều kiện tiên quyết

- Đường dẫn sở hữu và tiêu chí nghiệm thu trong brief; ALP.md và chỉ dẫn của dự án.
- Engine và major version, lớp ORM hay query, và công cụ migration, đọc từ manifest,
  config, và thư mục migration hiện có.
- Quy ước migration đang có: cách đặt tên, thứ tự, up/down hay chỉ-tiến, cách
  migration chạy trong test và khi deploy.
- Một database local hoặc test để thao tác lên. Đừng bao giờ dùng database dùng chung hay
  production.

## Quy trình

1. Nêu yêu cầu dữ liệu: thực thể, quan hệ, cardinality, field bắt buộc, tính duy nhất,
   thời gian lưu, và các đường đọc và ghi chính.
2. Đọc schema hiện tại (migration, model, hay một dump của database test), không chỉ
   các model ORM; chúng có thể lệch.
3. Thiết kế thay đổi. Đặt quy tắc toàn vẹn vào trong database ở nơi engine hỗ trợ:
   NOT NULL, foreign key, unique, check constraint. Đọc
   schema-and-migrations.md.
4. Lập kế hoạch triển khai cho bảng đang có dữ liệu sống: mở rộng, migrate dữ liệu,
   chuyển code, thu hẹp. Mỗi bước phải an toàn khi cả bản ứng dụng cũ và mới
   cùng chạy.
5. Đánh giá locking: câu lệnh có ghi lại cả bảng hay giữ một lock mạnh không? Dùng
   dạng online của engine (ví dụ dựng index concurrent trong PostgreSQL) và một lock
   timeout khi công cụ của dự án cho phép.
6. Viết migration bằng công cụ của dự án. Làm nó đảo được, hoặc ghi lại vì sao nó chỉ
   tiến và cách khôi phục.
7. Viết backfill thành các bước riêng, chia lô, có thể tiếp tục, không nằm trong
   migration schema khi bảng lớn.
8. Với việc tối ưu truy vấn, đo trước: ghi lại truy vấn, tham số của nó, và plan.
   Đọc query-performance.md. Đổi một thứ, rồi đo lại trên dữ liệu tương đương.
9. Chạy migration lên, xuống (nếu được hỗ trợ), rồi lên lại trên một database test,
   sau đó chạy test của dự án.
10. Handoff: các file migration, thứ tự triển khai, ước lượng lock và thời gian chạy, kế hoạch
    backfill, đường rollback, plan trước và sau cho thay đổi truy vấn, quyết định còn mở.

Một agent chỉ đọc chạy bước 1-5 và 8 đối chiếu với đề xuất hoặc schema hiện tại, rồi
báo các rủi ro và một thiết kế được khuyến nghị thay vì tự sửa.

## Ràng buộc

- Theo engine, ORM, công cụ migration và cách đặt tên hiện có của dự án trước đã.
  Prisma, Drizzle, SQLAlchemy/Alembic, Django migrations, golang-migrate, hay file SQL
  thuần là ví dụ, không phải khuyến nghị.
- Không thêm dependency, extension, hay data store mới mà không có quyết định của
  owner. Không tự cài.
- Đừng bao giờ chạy migration, backfill, hay ghi tạm lên database dùng chung, staging,
  hay production; đó là một bước deploy của người sở hữu nó.
- Đừng bao giờ sửa một migration đã được áp dụng ngoài database local của bạn;
  hãy thêm một migration mới.
- Thay đổi phá hủy (xóa hay đổi tên cột hoặc bảng, siết kiểu dữ liệu, xóa dữ liệu)
  cần quyết định tường minh của owner và một kế hoạch rollback đã ghi lại.
- Đừng đọc credential hay dữ liệu cá nhân thật; dùng dữ liệu test và config ví dụ.
- Ở trong đường dẫn sở hữu. Skill này không cho quyền deploy hay release.

## Kiểm chứng

- Migration áp sạch lên một database rỗng và lên một database có dữ liệu đại diện.
- Migration xuống (nếu được hỗ trợ) phục hồi schema trước đó; lên lại áp được.
- Test của dự án pass với schema mới.
- Constraint từ chối đúng dữ liệu không hợp lệ mà nó phải từ chối (một test chứng minh).
- Với thay đổi về hiệu năng: plan và thời gian trước và sau trên dữ liệu tương đương,
  kèm điều kiện đã ghi lại.
- Mỗi bước triển khai đều tương thích với bản ứng dụng đang chạy.

## Xử lý khi thất bại

- Migration fail trên dữ liệu hiện có: dừng, báo mẫu của các dòng vi phạm (không phải
  nội dung của chúng), và đề xuất một bước dọn dẹp hoặc một constraint theo giai đoạn.
- Một lock hoặc một lần ghi lại dài là không tránh được: báo ước lượng và chuyển lên
  quyết định về cửa sổ bảo trì.
- Không có database test: báo khoảng trống đó; đừng khai là migration đã chạy.
- Plan khác nhau giữa dữ liệu local và dữ liệu giống production: hãy nói ra; đừng khái quát
  hóa.
- Một model ORM và schema thật không khớp: báo chỗ lệch trước khi đổi bên nào.

## Tài liệu tham khảo

- [references/schema-and-migrations.md](references/schema-and-migrations.md) — đọc khi thiết kế bảng, constraint, hay hình dạng document, hoặc khi lập kế hoạch migration expand/contract, backfill, tính đảo được, hay rủi ro lock (bước 3-7).
- [references/query-performance.md](references/query-performance.md) — đọc khi thêm index, đọc output EXPLAIN, sửa N+1, phân trang, hay chọn transaction và isolation (bước 8).
