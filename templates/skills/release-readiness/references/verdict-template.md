# Mẫu verdict

Đọc khi quyết định verdict và viết báo cáo mức sẵn sàng phát hành.

## Quy tắc quyết định

- NO-GO: có tiêu chí chặn nào FAIL, hoặc một tiêu chí chặn là NOT VERIFIED
  mà không thể kiểm chứng được trước thời điểm phát hành dự kiến.
- CONDITIONAL: không có tiêu chí chặn nào FAIL, và mọi mục NOT VERIFIED hay FAIL còn lại đều
  có một người sở hữu được nêu tên, một hành động đóng cụ thể, và một mốc "phải đóng trước"
  (trước khi tag, trước khi publish, trong N ngày sau phát hành với các mục không chặn).
- GO: mọi tiêu chí chặn đều PASS kèm bằng chứng; các khoảng trống không chặn được liệt kê ra.

Verdict CONDITIONAL không phải là giấy phép phát hành; các điều kiện được ghi "trước khi
tag" hay "trước khi publish" phải được đóng và kiểm chứng lại trước.

## Báo cáo

```text
Release readiness: <project> <version>
Candidate: <SHA> (<branch/tag>), tree clean: <yes/no>
Assessed by: <agent/role>   Date: <YYYY-MM-DD>

Verdict: GO | CONDITIONAL | NO-GO
Reason: <one or two sentences naming the deciding criteria>

Criteria
| # | Criterion | Status | Evidence |
| 1 | Candidate pinned | PASS | git rev-parse HEAD -> <sha> |
| 2 | CI on exact SHA | NOT VERIFIED | CI not reachable from session; owner: <name> |
| ... |

Conditions (CONDITIONAL only)
- <action> | owner: <name> | must close before: <tag/publish/date> | verify by: <check>

Blocking failures (NO-GO only)
- <criterion>: <evidence> | suggested follow-up: <bug-loop/security-review task>

Accepted risks
- <risk> | accepted by: <user or named owner> | recorded in: <ADR/task note>

Not verified
- <criterion>: <why> | who can verify: <name/role>

Release actions pending user authorization
- <tag/publish/push/deploy steps>; none performed by this assessment.
```

## Mẹo viết

- Đặt verdict và lý do lên trước; reviewer đọc từ trên xuống.
- Dẫn bằng chứng cho ngắn: câu lệnh và dòng output quyết định.
- Đừng làm mềm NO-GO thành CONDITIONAL khi chưa có người sở hữu và hành động đóng.
