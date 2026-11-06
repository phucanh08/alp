# Bản ghi quyết định kiến trúc (ADR)

Đọc khi phán xét một thay đổi có đáng viết ADR, khi viết ADR, hoặc khi đổi status của một ADR.

## Khi nào nên viết ADR
Viết khi có ít nhất một điều sau đúng:
- Lựa chọn đó đắt khi phải đảo ngược: nơi lưu dữ liệu, protocol, kiểu public API, runtime,
  framework, mô hình triển khai.
- Nó làm đổi một ranh giới module hoặc hướng phụ thuộc được cho phép.
- Nó ảnh hưởng tới tính tương thích với bên tiêu thụ, dữ liệu đã lưu hoặc các nền tảng được hỗ
  trợ.
- Đã có các phương án khác hợp lý được cân nhắc nghiêm túc rồi loại bỏ.
- Nếu không ghi lại thì cả team sẽ tranh lại chuyện đó.

Bỏ qua ADR với: refactor trong một module, cập nhật patch của dependency, chuyện đặt tên,
helper cục bộ, bản sửa lỗi đưa hành vi về đúng contract đã ghi, và các lựa chọn đã bị một ADR
hiện có quy định hoàn toàn. Một câu trong tài liệu liên quan là đủ.

## File và cách đánh số
- Theo vị trí và cách đánh số ADR project đang dùng. Mặc định:
  `docs/architecture/decisions/NNNN-short-title.md`, bốn chữ số, lấy số trống kế tiếp.
- Không bao giờ đánh số lại hay xoá một ADR; hãy thay thế nó bằng ADR mới (supersede).

## Mẫu
```markdown
# NNNN. Short decision title

- Status: Proposed | Accepted | Superseded by NNNN | Deprecated
- Date: YYYY-MM-DD
- Deciders: who confirmed it (role or name as the project records it)

## Context
The forces and constraints, with evidence paths. What problem forces a choice now.

## Decision
The choice, stated as one or two sentences in active voice.

## Alternatives
- Option: why it was not chosen.

## Consequences
What gets easier, what gets harder, follow-up work, and what to watch.

## Evidence
Files, tests, benchmarks or discussions that support the context and decision.
```

## Vòng đời của status
| Status | Ý nghĩa | Ai chuyển |
|---|---|---|
| Proposed | Đã soạn, chưa được xác nhận | Bất kỳ người ghi; chuyển cho main để ra quyết định |
| Accepted | Đã được người sở hữu quyết định xác nhận | Main, sau khi người dùng hoặc người sở hữu có thẩm quyền xác nhận |
| Superseded by NNNN | Đã bị thay; giữ nguyên nội dung, link sang ADR mới | Người viết ADR mới |
| Deprecated | Không còn áp dụng, không có gì thay thế | Main, kèm lý do trong một ghi chú có ngày |

- Một agent không bao giờ tự đánh đề xuất của mình là Accepted khi chưa có xác nhận đó.
- Sửa một ADR đã Accepted chỉ được giới hạn ở lỗi chính tả và link; quyết định thay đổi là một
  ADR mới.
