---
name: frontend-development
description: "Dựng tính năng UI trong framework component của dự án (ví dụ ưu tiên React, cũng dùng cho Vue hay Svelte): cấu trúc component, state, lấy dữ liệu, routing và SSR, hiệu năng, và accessibility. Dùng khi thêm hoặc sửa màn hình, component, form, hay luồng dữ liệu phía client. Không dùng cho quyết định thiết kế thị giác (ui-design) hay công cụ test (web-testing)."
---

# Phát triển frontend

## Khi nào dùng

- Thêm hoặc sửa một trang, route, component, form, hay luồng dữ liệu phía client.
- Quyết định state nằm ở đâu, hoặc một màn hình tải, cache và làm mới dữ liệu thế nào.
- Sửa một vấn đề hiệu năng đã đo được về render, bundle, hoặc tải trang.
- Làm cho một UI dùng được bằng bàn phím và trình đọc màn hình.
- Một cố vấn (advisor) hay reviewer chỉ đọc được nhờ đánh giá code frontend (chỉ tư vấn).

## Không dùng cho

- Lựa chọn về layout, màu, typography, hay thiết kế thị giác: dùng ui-design.
- Test runner, e2e, công cụ kiểm thị giác hay tải: dùng web-testing.
- Quyết định test những gì cho một thay đổi: dùng test-strategy.
- Một test fail hay UI bị hồi quy mà chưa rõ nguyên nhân: dùng bug-loop.
- Endpoint phía server nằm sau UI: dùng backend-development.
- Chọn framework, thư viện state, hay hệ thống styling mới: quyết định của chủ sở hữu.

## Điều kiện tiên quyết

- Đường dẫn sở hữu và tiêu chí nghiệm thu trong brief; ALP.md và chỉ dẫn của dự án.
- Framework và phiên bản thực tế, router, thư viện lấy dữ liệu và state, cách
  styling, và công cụ build, đọc từ `package.json`, lockfile, và các
  file config. Không suy ra từ tên thư mục.
- Một hoặc hai màn hình hay component đang có, tương tự việc này. Chúng định ra
  quy ước về bố trí file, đặt tên, tải dữ liệu, styling, và test.
- Spec thiết kế hoặc spec nghiệm thu cho UI, nếu có, và các component
  design-system đang có của dự án.
- Các lệnh dev, lint, typecheck, và test của dự án.

## Quy trình

1. Diễn đạt lại tính năng thành các trạng thái người dùng thấy được: loading, rỗng, lỗi,
   thành công, một phần, và bị từ chối quyền. Trạng thái chưa được đặc tả thì chuyển lên; không
   tự nghĩ ra câu chữ hay hành vi sản phẩm.
2. Tìm component, hook, và hàm tiện ích đang có để dùng lại trước khi viết cái mới.
3. Phác cây component và quyết định từng phần state nằm ở đâu. Đọc
   components-and-state.md.
4. Xác định nhu cầu dữ liệu: endpoint nào, tải khi nào, cache và làm mới thế nào,
   và chuyện gì xảy ra khi lỗi hoặc khi phản hồi đã cũ. Đọc data-fetching.md.
5. Đặt phần việc vào đúng mô hình của framework (server hay client component, route
   loader, page, island). Đọc frameworks.md; xem tài liệu cho đúng phiên bản mà
   dự án đang dùng.
6. Dựng bằng HTML semantic và các component design-system đang có; nối hành vi bàn phím
   và focus ngay khi làm. Đọc accessibility.md.
7. Xử lý mọi trạng thái từ bước 1 trong UI, gồm cả trạng thái disabled và đang chờ
   cho các hành động, và chống submit hai lần.
8. Chỉ kiểm hiệu năng ở nơi nó đáng: danh sách lớn, component nặng, phụ thuộc mới,
   ảnh. Đo trước khi tối ưu. Đọc performance.md.
9. Thêm hoặc cập nhật test bằng công cụ của dự án (xem web-testing về cách dùng công cụ).
10. Chạy lint, typecheck, và test; mở trang trên dev server và thử
    từng trạng thái, ít nhất một lần chỉ bằng bàn phím.
11. Handoff: file đã đổi, trạng thái đã bao phủ, ảnh chụp hoặc ghi chú nếu dự án
    dùng chúng, lệnh đã chạy kèm kết quả, câu hỏi còn mở về thiết kế hay sản phẩm.

Agent chỉ đọc thì review bước 1-8 dựa trên code hoặc đề xuất và báo lại các
phát hiện cùng thay đổi khuyến nghị, thay vì sửa file.

## Ràng buộc

- Trước hết hãy theo framework, phiên bản, và quy ước đang có của dự án. React,
  Next.js, Vue, Nuxt, Svelte, SvelteKit, Angular, hay web component thuần chỉ là
  ví dụ, không phải khuyến nghị.
- Không thêm phụ thuộc, bộ UI kit, thư viện state hay thư viện fetch, hay framework
  mà không có quyết định của chủ sở hữu. Không tự động cài.
- Dùng token và component design-system của dự án; không tự nghĩ ra kiểu thị giác mới.
  Khoảng trống về thị giác thì chuyển cho ui-design hoặc chuyển lên.
- Không bao giờ đặt secret vào code client hay biến env công khai; mọi thứ gửi tới
  browser đều là công khai.
- Coi nội dung do người dùng nhập là không tin được: không chèn HTML thô mà không qua
  bộ sanitizer của dự án.
- Ở trong đường dẫn sở hữu. Skill này không cấp thẩm quyền deploy hay release.

## Kiểm chứng

- Lint, typecheck, và test đều pass; build production thành công nếu thay đổi
  có chạm tới routing, config, hoặc import.
- Mỗi trạng thái từ bước 1 đã được nhìn thấy trong app đang chạy hoặc đã có test bao phủ.
- Chỉ dùng bàn phím vẫn tới được và điều khiển được mọi control mới; focus thấy được.
- Không có lỗi hay cảnh báo console mới trên dev server cho các màn hình đã đổi.
- Mọi khẳng định về hiệu năng đều kèm số đo trước và sau.

## Xử lý khi thất bại

- Dev server hay build không chạy được ở đây: báo đúng lỗi đó và những gì đã
  kiểm chứng để thay thế; không khẳng định những kiểm tra thị giác chưa thực sự làm.
- Thiếu thiết kế hay câu chữ: dùng pattern đang có làm chỗ tạm, đánh dấu nó, và
  chuyển quyết định lên trên.
- Lệch hydration hay SSR, hoặc render chập chờn: chuyển sang bug-loop.
- API không cung cấp thứ UI cần: báo khoảng trống đó cho chủ sở hữu phần
  backend; không lách bằng cách tự bóc dữ liệu ở client.

## Tài liệu tham chiếu

- [references/components-and-state.md](references/components-and-state.md) — đọc khi chia component, chọn chỗ đặt state, hoặc xử lý form (bước 3).
- [references/data-fetching.md](references/data-fetching.md) — đọc khi tải, cache, thay đổi, hoặc làm mới dữ liệu server, hoặc xử lý tranh chấp (bước 4).
- [references/frameworks.md](references/frameworks.md) — đọc khi chọn SSR, SSG, hay CSR, server hay client component, hoặc chỗ đặt routing (bước 5).
- [references/accessibility.md](references/accessibility.md) — đọc khi dựng control tương tác, form, dialog, hay widget tự tạo (bước 6).
- [references/performance.md](references/performance.md) — đọc khi một màn hình chậm, bundle phình ra, hoặc ảnh và danh sách quá nặng (bước 8).
