# T5 — Docs beta `0.0.0-beta.1`: báo cáo

Agent 605c5380, 2026-10-16. Nguồn chuẩn: `docs/alp/beta-scope.md` (bản mới nhất, có §1.1 `alp-paseo-plugin`, §7.6 ghi chú 0.10.0, D2). Không commit/tag/publish, không chạy provider, không sửa manifest/code/scope.

## File

Mới:
- `docs/alp/beta-install.md`: cài mới, đăng nhập provider (`codex login`, `claude auth login` theo `packages/client/src/doctor.js`), daemon, plugin Paseo, `alp web` loopback, nâng cấp từ 0.10.0, backup/recovery, quay về 0.10.0, gỡ bỏ (không xóa dữ liệu; liệt kê thứ còn lại).
- `docs/alp/beta-release-notes.md`: DRAFT, ma trận hỗ trợ, Included/Experimental/Deferred, known issues, checksums (placeholder), editor's checklist (xóa trước khi publish).

Sửa (giữ nguyên thay đổi có sẵn của người khác):
- `README.md`: Install trỏ docs beta + support; Node 22.12+/24; `alp run --profile` → `--team` (usage); nhãn experimental (daemon install, relay, Antigravity/ACP, `alp acp`); `alp web` loopback ≠ `apps/web`; Paseo `>=0.11.1 <0.12.0`; mục License (đoạn của fb17b279).
- `integrations/paseo/README.md`: supervisor Sonnet 4.6 → Sonnet 5 (`templates/teams/*/team.json`: `claude:claude-sonnet-5`); Node; `@beta`; ghi chú tên cũ `alp-paseo-plugin`; Remote mode → deferred; câu "package name unchanged" sai → sửa; peer React optional.
- `docs/alp/codex-only.md`: Node, `@beta`; web app không nằm trong `@anhlp/alp`.
- `docs/alp/paseo-plugin.md`: điều kiện cài, link beta-install.
- `docs/modular-monorepo.md`: cảnh báo mục publish (thiếu `--tag beta` → đặt `latest`).
- Banner deferred/experimental: `paseo-remote.md`, `remote-gateway.md` (+Node), `web.md`, `client-sdk.md`, `daemon-rpc-completion-matrix.md`, `agent-library.md` §ACP, `team-workflow.md` (daemon install).
- Banner lịch sử (không sửa bằng chứng): `phase-0-findings.md`, `phase-2-5-results.md`, `team-results.md`, `legacy-cleanup-verification.md`, `ci-baseline.md` (mục baseline 0.10.0), `adapter-boundary.md`.
- Không sửa: `data-recovery.md` (anh chốt giữ nguyên), `beta-scope.md`.

## Kiểm tra

- Link nội bộ + anchor (script tạm ngoài repo, có test âm): 23 file, 0 lỗi.
- Grep: không còn lệnh cài ALP/plugin thiếu `@beta`/exact (trừ câu cảnh báo), không còn "Node 20+", "Sonnet 4.6", "Remote mode (beta)".
- Lệnh `alp` + flag đối chiếu `packages/cli/src/usage.js`, `daemon.js`, `sessions.js`.
- `paseo plugin add|ls|remove` đối chiếu `--help` (Paseo 0.11.2 local). `paseo provider models alp` chưa kiểm (anh từ chối chạy).
- Registry (curl, chỉ đọc): `@anhlp/alp` latest 0.10.0; `@anhlp/alp-paseo` chưa có; `alp-paseo-plugin` 15 bản, latest 0.10.0.
- Git: `alp backup`/`restore` thêm sau v0.10.0 (cd005e6); 0.10.0 bundle `alp web` trong root.
- Manifest (working tree): 8 package `0.0.0-beta.1`, engines `>=22.12`; gateway private; react/react-native optional peer.
- `npm` local hỏng (npm 12 trên Node 20.13.1) → không chạy được lệnh npm.

## Phối hợp

- fb17b279 (license/T1–T3): đồng ý chia ownership; gửi đoạn License; xác nhận web-app THIRD-PARTY-NOTICES → không ghi known issue license.
- b78f2a9a (scope): nhận 2 đề xuất, tự cập nhật scope (§1.1/T7 `alp-paseo-plugin`; §7.6 0.10.0 không có `alp backup`).
- 055472d9 (T10): harness `scripts/beta-acceptance-*.mjs` là quy trình gate → không đưa vào docs người dùng; đã chuyển đề xuất tham chiếu ở scope §6.3 cho b78f2a9a; ghi vào editor's checklist của release notes. Docs T5 không chứa lệnh C6 thủ công nên đổi rule `Bash(touch *)` không ảnh hưởng.
- ec05d561 (audit): peer React optional → đã sửa docs; known issue linkify-it đưa vào DRAFT kèm điều kiện "chỉ giữ nếu S1 chấp nhận rủi ro".

## Pending / blocker (không thuộc T5)

- T1–T3 mới ở working tree, chưa commit/merge (P0).
- T6/S1 audit đang làm; T10 test quyền; T7 dọn npm (gồm `alp-paseo-plugin`); T8 gate H/A/R, Q1–Q5 chưa chạy.
- Release notes còn DRAFT: checksums trống, link tương đối cần đổi tuyệt đối khi dán lên GitHub.
- Docs xong ≠ beta đủ điều kiện phát hành.

## Quan sát (không sửa, ngoài phạm vi)

- `packages/core/src/state-schema.js:9` và `docs/alp/data-recovery.md:139,180-183` nói "before 0.11"/"from 0.11 on"; bản ghi schema 2 thực tế là `0.0.0-beta.1` (semver thấp hơn 0.10.0) → dễ hiểu nhầm.
- Scope §2 ghi root có `alp`, `alpd`; manifest root chỉ có bin `alp` (alpd chạy qua `alp daemon start`). Docs viết theo manifest.
- Supervisor mặc định `claude-sonnet-5` là "Previous release" trong catalog (`packages/core/src/models.js:27`); docs ghi đúng theo code.
- `docs/modular-monorepo.md:17` liệt kê workspace thiếu `apps/gateway`, `apps/web`.
- `paseo-remote.md`, `daemon-rpc-completion-matrix.md` nhắc `docs/alp/paseo-remote-rpc-gap-analysis.md` (không có trong repo; dạng code, không phải link).

## Câu hỏi còn mở

- Ngôn ngữ docs beta: em viết tiếng Anh cho khớp README/docs người dùng; scope vẫn tiếng Việt. Đổi nếu anh muốn.
- Cú pháp `paseo plugin add npm:@anhlp/alp-paseo@beta` (npm source kèm tag) chỉ xác nhận được ở Q3.
