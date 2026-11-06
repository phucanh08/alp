---
name: devops
description: "Lên kế hoạch và thay đổi container, pipeline CI/CD, chiến lược deploy và rollback, hạ tầng dạng mã và observability bằng những bước review được, đảo lại được. Dùng khi sửa Dockerfile, config pipeline, IaC, script deploy, alert hay dashboard. Không dùng cho code tính năng của ứng dụng, quyết định phát hành (release-readiness) hay audit secret (security-review)."
---

# Container, pipeline, deploy và observability

## Khi nào dùng

- Viết hay sửa một Dockerfile, file compose hoặc một lần build container.
- Thêm hay sửa một stage, cache, matrix hoặc job release của pipeline CI/CD.
- Lên kế hoạch chiến lược deploy, thứ tự migration database hoặc rollback.
- Sửa hạ tầng dạng mã (Terraform, Pulumi, CloudFormation, Helm, manifest Kubernetes, và tương tự).
- Thêm log, metric, trace, SLO, alert hay dashboard.

## Không dùng cho

- Quyết định một bản release có được phát hành hay không: release-readiness.
- Audit code hay config để tìm lỗ hổng và secret bị lộ: security-review.
- Chẩn đoán một test fail hay hồi quy trong code ứng dụng: bug-loop.
- Tính năng ứng dụng chỉ tình cờ chạy trong một container.

## Điều kiện tiên quyết

- Đọc ALP.md, các config pipeline đang có, Dockerfile, IaC và tài liệu deploy. Xác lập đúng
  nền tảng, công cụ và phiên bản thực tế từ chính các file, không phải từ giả định.
- Biết những môi trường nào tồn tại (local, CI, staging, production), ai sở hữu chúng, và
  việc được giao cho phép những gì. Được phép sửa một file không có nghĩa là được phép áp dụng nó.

## Quy trình

1. Kiểm kê: build, pipeline, đường deploy và việc giám sát hiện tại của service bị ảnh hưởng.
   Ghi lại đã tìm những gì và thấy những gì.
2. Nêu rõ thay đổi và bán kính ảnh hưởng của nó: nó có thể tác động tới môi trường, service và người dùng nào,
   và làm sao để hoàn tác nó.
3. Làm thay đổi nhỏ nhất, trong chính công cụ và cách bố trí đang có. Dùng lại các stage, base image,
   module và cách đặt tên đang có.
4. Kiểm chứng ở cục bộ hoặc trong một ngữ cảnh không phải production: build image, lint và validate pipeline
   hoặc IaC, chạy lệnh plan hay dry-run mà công cụ cung cấp, và chạy test của dự án.
5. Với những thay đổi ảnh hưởng tới deploy, hãy viết các bước rollout và rollback, gồm cả thứ tự migration
   và cách đo thành công.
6. Thêm hoặc cập nhật observability để có thể thấy được thay đổi đó đang chạy đúng hay đang lỗi.
7. Handoff: file đã đổi, lệnh validate và output, output của plan hay diff, ghi chú rollout và
   rollback, và mọi hành động vẫn cần một con người có thẩm quyền thực hiện.

## Ràng buộc

- Trước hết hãy theo stack, nền tảng và quy ước đang có của dự án.
- Không thêm phụ thuộc, service, tài nguyên cloud, tính năng trả phí hay nhà cung cấp mới mà không có
  quyết định của chủ sở hữu. Không tự động cài công cụ hay plugin.
- Không bao giờ deploy, áp dụng thay đổi hạ tầng, chạy migration lên database dùng chung, luân chuyển khóa,
  đổi DNS hay chạm vào hệ thống hoặc thông tin đăng nhập production mà không có phép tường minh cho đúng
  hành động cụ thể đó. Plan, dry run và build cục bộ là mặc định.
- Không bao giờ đặt secret vào image, file pipeline, IaC, log hay file env đã commit. Hãy tham chiếu tới
  kho secret của nền tảng hoặc biến môi trường; không đọc hay in ra các giá trị secret đang có.
- Không push, tag hay kích hoạt pipeline release trừ khi việc được giao nói rõ như vậy.
- Ghim phiên bản (base image, action, công cụ, provider) thay vì dùng tag trôi nổi.
- Agent chỉ đọc thì review và đề xuất; chúng không sửa và không chạy lệnh gây thay đổi.

## Kiểm chứng

- Image build được ở cục bộ; chạy không phải root; healthcheck pass; không có secret trong layer hay build arg.
- Config pipeline validate được bằng linter của nền tảng hoặc bằng một lần dry run ở nơi có; các job đã đổi
  đã được chạy thử, hoặc nêu rõ lý do không chạy thử được.
- Output plan hay diff của IaC được kèm theo và chỉ chứa đúng những thay đổi dự định.
- Mọi thay đổi ảnh hưởng tới deploy đều có các bước rollback, và chúng đã được diễn tập hoặc đánh dấu là chưa diễn tập.
- Alert mới đều có một ngưỡng, một người sở hữu, và một link runbook hoặc bước kế tiếp.

## Xử lý khi thất bại

- Không có công cụ validate ở cục bộ: hãy nói rõ, đưa ra đúng lệnh cho một người
  có thẩm quyền, và không khẳng định là thay đổi đó chạy được.
- Plan cho thấy những thay đổi ngoài dự kiến (drift, bị thay thế, bị xóa): dừng lại, báo cái diff đó, và
  chuyển lên trên trước khi apply bất cứ gì.
- Pipeline chỉ fail trong CI: so sánh image của runner, phiên bản công cụ, cache và biến môi trường
  với cục bộ; tái hiện trong một container tương ứng khi có thể.
- Thiếu quyền truy cập hay thông tin đăng nhập: báo cần gì và cho môi trường nào; không bao giờ lách
  bằng token cá nhân hay bằng cách mở rộng quyền.

## Tài liệu tham chiếu

- [references/containers.md](references/containers.md) — đọc khi viết hay review một Dockerfile hoặc một lần build container.
- [references/ci-cd.md](references/ci-cd.md) — đọc khi sửa các stage của pipeline, việc cache, phiên bản hay token.
- [references/deployment-and-rollback.md](references/deployment-and-rollback.md) — đọc khi lên kế hoạch rollout, migration hay rollback ở bước 5.
- [references/observability.md](references/observability.md) — đọc khi thêm log, metric, trace, SLO hay alert ở bước 6.
