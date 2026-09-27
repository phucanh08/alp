Từ vựng ghế và trigger review Phase 8 cho bộ skill SLP. Đây là reference, không phải skill — không
có `SKILL.md`, không nạp qua tool `Skill`; skill nào cần thì trỏ path này.

## Ghế → từ vựng authority

Mỗi skill nói bằng _quyền bạn đang cầm_, không gọi tên ghế. Bảng này là ánh xạ duy nhất.

| Ghế SLP    | Từ trong skill      | Quyền cầm                                                                                                    | Không cầm                                                                       |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Human      | **người yêu cầu**   | chốt outcome; cấp authority ngoài máy (push, deploy, service ngoài); accept khi người giao việc tự viết      | —                                                                               |
| Lead       | **người giao việc** | chẻ việc, sở hữu topology; ruling boundary; viết brief; chấm `ACCEPT`/`REJECT <sha>`; kênh hỏi người yêu cầu | accept việc chính mình viết (`LEAD-WROTE`)                                      |
| Peer       | **người nhận việc** | đúng những gì brief ghi: owned scope, write hoặc read-only, commit lease                                     | kênh hỏi người yêu cầu (thiếu → `BLOCKED` về người giao việc); topology; ruling |
| Supervisor | **người quan sát**  | đọc Git object và transcript; hỏi `DRIFT` / `ESCALATE`                                                       | mọi thứ khác; không dùng skill nào                                              |

Disposition (Engineer · Architect · Reviewer · Scout) là _chế độ làm việc_ ghi trong brief, không
phải ghế; skill được nhắc disposition.

## Phase 8 — Review (có điều kiện)

Chỉ khi trúng một trong năm trigger trong `lead.md` (brief pre-solve, chạm seam `CLAUDE.md`, khó
đảo ngược, proof đáng ngờ, REOPEN rút lại không evidence). Reviewer đọc **đúng SHA** bằng
`git show sha:path` / `git diff base sha`; brief cho Reviewer không chứa verdict của Lead
(`prompt-leverage` luật "không seed").
