# Thiết kế feature

Đọc khi viết bản thiết kế feature, khi chọn feature tương tự, hoặc khi kiểm hướng của phụ thuộc mới.

## Chọn feature tương tự

Xếp hạng các ứng viên theo số điểm sau mà chúng chia sẻ với feature mới:

1. Cùng loại entry point (route HTTP, câu lệnh CLI, job, màn hình UI, event handler).
2. Cùng module hay lớp sở hữu, và cùng tập module mà nó phụ thuộc vào.
3. Cùng hình dạng lưu trữ hay tích hợp (đọc/ghi cùng một store hay service).
4. Mới được viết hoặc mới bị chạm tới, nên nó phản ánh quy ước hiện hành.
5. Có test theo phong cách project mong đợi.

Ưu tiên boilerplate hay generator của project khi có; dùng feature tương tự để bù phần
template bỏ sót. Nếu hai ứng viên mâu thuẫn nhau, hãy theo cái mà tài liệu kiến trúc hoặc
các phép kiểm hậu thuẫn, và ghi lại cái kia như một chỗ lệch.

Ghi lại lựa chọn đó trong bản thiết kế: "Mirrors `<path>` because <shared traits>."

## Mẫu thiết kế

Giữ nó vừa đủ cho những gì một reviewer cần để kiểm implementation. Bỏ các mục trống.

```text
Feature: <one-line purpose>
Owning module: <module/package/layer>
Mirrors: <path of analogous feature or template> because <traits>

Hard constraints applied:
- <rule> (source: <doc/ADR/lint config>)

Files:
- add    <path>  <role in the feature>
- change <path>  <what changes and why>

Public surface:
- <exported symbol / route / CLI flag / config key / event>  new | changed
- Compatibility: <none affected | what callers must change>

Dependencies (from -> to):
- <module A> -> <module B>  <existing edge kind it matches>

Tests:
- <test file>  <behavior covered>

Open decisions / exceptions:
- <question or rule exception, who must decide>
```

## Danh sách kiểm hướng phụ thuộc

Trả lời từng câu cho mỗi import, lời gọi hay lần đăng ký mới:

- Đã có một cạnh cùng loại chỉ theo hướng này chưa? Dẫn ra một cạnh.
- Cạnh đó có vượt một ranh giới lớp hay package mà tài liệu hoặc contract hạn chế không?
- Nó có tạo ra một vòng lặp giữa các module không? Kiểm cả hai hướng.
- Một module thấp hơn hoặc dùng chung bây giờ có import từ một module feature hay app không?
- Code domain hay core bây giờ có import một chi tiết framework, transport hay lưu trữ mà
  feature tương tự vẫn giữ ở ngoài không?
- Một dependency chỉ dùng cho test hay chỉ dùng khi dev có thể chạm tới được từ code production
  không?
- Feature có thò vào phần nội bộ của module khác thay vì vào entry point public của nó không?
- Một lần đăng ký mới (router, danh sách plugin, DI container, manifest) có được đặt đúng chỗ
  mà feature tương tự đăng ký không?

Bất kỳ câu "có" nào về một lần vượt ranh giới bị hạn chế, một vòng lặp, hay một lần truy cập
phần nội bộ đều là vấn đề ràng buộc cứng: hãy sửa chỗ đặt, hoặc chuyển một quyết định ngoại lệ
lên trên trước khi hiện thực.
