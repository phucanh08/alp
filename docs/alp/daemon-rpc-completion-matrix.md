# Daemon RPC cho Paseo remote: completion và security matrix

> **Báo cáo phát triển, lịch sử.** Phục vụ chế độ remote và gateway, cả hai deferred trong beta
> `0.0.0-beta.2` ([beta-scope.md](beta-scope.md) §4). Trạng thái và kết quả dưới đây là của nhánh
> `feat/daemon-remote-rpc` lúc viết, không phải của bản beta.

Task 09 phần backend (09B-1). Dành cho agent Gateway (Task 08) và Task 09B-2 (Paseo thin client).
Contract chuẩn nằm ở `docs/protocol/alp-json-rpc-v1.md` §15 và `packages/protocol/schema/methods-v1.json`
(mỗi method có annotation `x-alp`). Tài liệu này là bản đồ: cái gì đã có, ở đâu, kiểm thử ra sao, còn thiếu gì.

- **Mốc:** nhánh `feat/daemon-remote-rpc` từ `main` tại `4670048` (Task 06 đã merge; 04B, 5B, 07, 09A đã có).
- **Nguồn gap:** `docs/alp/paseo-remote-rpc-gap-analysis.md` (09A; trên `main` file này chưa được commit).
- **Không đổi:** wire envelope, handshake, `PROTOCOL_VERSION` (vẫn `1`), storage/migration của 5B, Client SDK,
  Gateway, TUI, `integrations/paseo`. Không có RPC filesystem hay shell tổng quát, không có endpoint mạng hay lớp auth.

## 1. Checklist từ 09A

| Mục 09A | Trạng thái | Bằng chứng |
|---|---|---|
| F03 danh sách session, lịch sử | **Đã đáp ứng**, không làm lại | `session.list`, `session.get`, `question.list` (§12); polling 2 s vẫn chạy được |
| F05/F09 streaming, timeline cây | **Đã đáp ứng** | notification `event`, Envelope `cursor` (§8) |
| F06 replay theo cursor | **Đã đáp ứng** (Task 06) | `session.attach { after } → { cursor, reset? }`, capability `attach.after`; conformance profile `session` |
| F07 prompt/steer/interrupt/mode | **Đã đáp ứng** | `prompt.receipts` (§10); id do client sinh là trách nhiệm của 09B-2 |
| F08 câu hỏi agent | **Đã đáp ứng** | `question.list/answer`; prefix id vẫn được daemon chấp nhận, Gateway chặn ở phía nó |
| F17 usage | **Đã đáp ứng** | `daemon.usage` |
| F02 teams khi không có cwd | **Mở rộng → `team.list`** | mới; `session.preview` vẫn cho team hiệu lực |
| F10 Tasks panel | **Bổ sung `task.*`** | `task.list/create/update/gate.resolve` |
| F12 Settings ALP/Host | **Bổ sung `library.*`** | list/get/save/delete/duplicate/rename, `library.skills.set` |
| F13 sync team sau khi save | **Bổ sung** (`library.save { sync: 'known-projects' }`) | tập project lấy từ session records của daemon, không từ Paseo host |
| F15 model cho template editor | **Bổ sung `library.models`** | |
| F16 ngôn ngữ | **Bổ sung `settings.language.get/set`** | |
| F14 nút Test (mcp/hook/provider) | **Chưa làm** | spawn trên daemon host; cần probe nhận abort signal (nằm trong `@anhlp/alp-client`, ngoài phạm vi) |
| F18 providers snapshot/diagnose | **Chưa làm** | như F14; `exec.probe` |
| F19 projects/workspaces registry | **Chưa làm: bị chặn** | quyền ghi `state/web-workspaces.json` đang ở bridge, bridge giữ bản trong bộ nhớ và ghi đè cả file; daemon ghi song song sẽ mất dữ liệu. Cần cut-over trong 09B-2 (§4) |
| F20/F21 git, files chỉ đọc | **Chưa làm** | contract 09A khóa theo `workspaceId` (cần F19); cần trần kích thước theo `MAX_FRAME` |
| Subscribe/notify (P1) | **Chưa làm** | v1 dùng polling; `task.list.revision` giúp so thay đổi rẻ |
| Principal, grant, allow-list `session.create.spec` | **Thuộc Gateway (Task 08)** | daemon không tin identity trong params; mọi ghi từ RPC mới ghi `by: "user"` |
| F01 discovery/spawn alpd, F22 relay/pairing, F26 auth | **Local-only / Gateway** | |
| `host.directories.suggest`, `project.create_directory`, attention dùng chung, đường dẫn T2 | **Chính sách sản phẩm, chưa có contract** | |
| Tombstone, receipt bền ngoài prompt | **Quyết định mở của Task 06** | `task.create.requestId` chỉ dedupe trong một process alpd |

## 2. RPC status matrix

Capability: `task` luôn được alpd liệt kê; `team`, `library`, `settings.language` khi server có `home`
(alpd thật luôn có; `createDaemonServer` nhúng chỉ khi truyền `home`). Thiếu capability thì method trả `-32601`.

Cột **Scope** là resource Gateway cần authorize, lấy được từ params trước khi gọi. `P` = `projectRoot` (so khớp
nguyên chuỗi), `H` = host (thư viện/settings của user daemon).

| Method | Cap | Loại | Params chính → Result | Scope | Side effect | Idempotency | Lỗi (reason) | Test |
|---|---|---|---|---|---|---|---|---|
| `team.list` | team | query | `{projectRoot?}` → `{projectRoot\|null, teams[]}` | P (tùy chọn) + đọc H | không | có | -32602 invalid_path, 1001 not_alp_project, 1003 unsafe_path | ops, remote |
| `task.list` | task | query | `{projectRoot}` → `{projectRoot, tasks: taskRow[], unreadable[], revision}` | P | không | có | -32602, 1001, 1003 | ops, remote |
| `task.create` | task | mutation | `{projectRoot, title, priority?, requestId?}` → `{id, duplicate?}` | P | ghi `.alp/tasks/<id>.json` dưới task lock | theo `requestId` trong 10 phút, **một process alpd** | 1003, 1004 key_conflict, 1005 busy | ops (tuần tự, đồng thời), remote |
| `task.update` | task | mutation | `{projectRoot, id, action: close\|reopen, note?, ifRev?}` → `{id, status, rev, landed?}` | P | ghi task | không; `ifRev` chống ghi đè | 1001 unknown_task, 1004 revision_conflict/task_state, 1005 | ops, remote (sau restart) |
| `task.gate.resolve` | task | mutation | `{projectRoot, id, gate, note?, ifRev?}` → `{id, status, rev}` | P | ghi task; bước human của formula thì đóng task | không; `ifRev` | 1001, 1004, 1005 | ops |
| `library.list` | library | query | `{kind, projectRoot?}` → `{projectRoot\|null, entries[]}` (không có host path) | P (tùy chọn) + đọc H | không | có | -32602, 1001, 1003 | ops, remote |
| `library.get` | library | query | `{kind, name, projectRoot?, scope?}` → entry, `content` đã redact, `secrets[]` | P/H theo `scope` (không scope: đọc cả H và built-in) | không | có | 1001 not_found, -32602 invalid_scope | ops, remote |
| `library.save` | library | mutation | `{kind, name, scope, projectRoot?, content, revision?, sync?}` → `{revision, syncedProjects?, syncErrors?}` | `scope`=library → H; project → P. `sync: known-projects` + library → **mọi project daemon biết** | ghi entry; sync ghi `.alp/settings.json` | theo `revision` | -32602 invalid_entry/secret_marker/invalid_scope, 1004 revision_conflict, 1003 | ops (secret, đồng thời, sync), remote (restart) |
| `library.delete` | library | mutation | `{kind, name, scope, projectRoot?, revision?}` → `{removed, now?}` | như save | xóa entry | không (lần 2 → 1001) | 1001, 1004 revision_conflict/in_use | ops |
| `library.duplicate` | library | mutation | `{kind, from, to, scope, projectRoot?}` → `{revision}` | đích theo `scope`; nguồn đọc P/H | ghi entry mới (copy cả secret, không lộ ra) | không (lần 2 → 1004) | 1001, 1004 | ops |
| `library.rename` | library | mutation | `{kind, from, to, scope, projectRoot?}` → `{revision}` | như save | đổi tên | không | 1001, 1004 in_use/revision_conflict | ops |
| `library.skills.set` | library | mutation | `{agent, skills[]}` → `{skills}` | H | ghi `role-skills.json` | có (cùng danh sách) | -32602 invalid_entry | ops |
| `library.models` | library | query | `{}` → `{models[]}` (chỉ id/label/efforts) | H | không | có | — | ops |
| `settings.language.get` | settings.language | query | `{}` → `{language\|null, applies, default}` | H | không | có | 1000 unreadable | ops, remote |
| `settings.language.set` | settings.language | mutation | `{language\|null}` → như get | H | ghi `settings.json`, giữ key khác | có | -32602, 1000 unreadable | ops, remote |

`ops` = `packages/daemon/tests/operations.test.js` (socket thật, server thật, runtime giả).
`remote` = `packages/daemon/tests/remote-client.test.js` (alpd thật + client process riêng, §5).

## 3. Ghi chú bảo mật cho Gateway

- **Đường dẫn.** `projectRoot` phải tuyệt đối và đã normalize, daemon không đi ngược lên cha, không realpath.
  `.alp` là symlink → `1003 unsafe_path`; core chặn symlink trong `.alp/tasks` và đường dẫn entry. Gateway so
  khớp nguyên chuỗi với project đã cấp. Result chỉ echo `projectRoot` được hỏi; host path khác chỉ có trong
  `syncErrors` (sync bị tắt mặc định).
- **Secret.** `library.get` không bao giờ trả giá trị `env`/`headers` của MCP và `env` của provider; marker
  `{"$secret":"keep"}` + `secrets[]`. Save: marker = giữ nguyên, string = thay, bỏ key = xóa; marker sai chỗ
  hoặc không có giá trị để giữ → `-32602 secret_marker`, không ghi gì. `revision` là HMAC theo process nên
  không lộ hash nội dung có secret. Rủi ro còn lại: secret nhúng trong `args`, `url` hoặc lệnh hook không được
  nhận diện (không redact).
- **Chạy code.** Không RPC nào ở đây spawn process. Nhưng `library.save/duplicate/rename` với kind `mcp`, `hooks`,
  `providers` (và `agents` có `config.mcp/hooks/provider`) cấu hình lệnh sẽ chạy trên daemon host lần sau →
  coi là admin. `x-alp.risks` ghi điều này.
- **Identity.** Mọi ghi ghi `by: "user"`; daemon không đọc identity từ params. Khi Gateway có principal, cần
  đề xuất cách truyền xuống (vd `accept(send, { principal })`), không làm trong task này.
- **Annotation.** Mọi method (cũ và mới) có `x-alp: { effect, scope: { kind, param?, required?, selector?, reads? },
  capability?, idempotent, risks?, writes?, redacts? }`; test `contract.test.js` kiểm tra param tồn tại và
  capability đã khai báo. Gateway không nên expose chỉ dựa vào annotation.

## 4. Gap còn lại và thứ tự tích hợp

**Chưa tuyên bố Paseo remote-ready.** Còn thiếu cho web slice (T1): registry project/workspace (F19), git/files
chỉ đọc (F20/F21), providers và nút Test (F14/F18), subscribe. Tasks, Library/Settings/Models và teams thì đủ để
09B-2 chuyển `alp.tasks.*`, `alp.library.*`, `alp.settings.language.*` và team models sang RPC.

Thứ tự đề xuất:
1. Merge nhánh này (09B-1). Không đổi root manifest/lockfile.
2. Gateway (08) rebase; viết authorization test cho nhóm query có `projectRoot` (`team.list`, `task.list`,
   `library.list/get` với `scope: project`) rồi mới đến mutation project-scope; giữ chặn H-scope và code-exec.
3. 09B-2: proxy `alp.tasks.*` → `task.*` (map `directory` → `projectRoot` từ registry/session summary, vì daemon
   không đi ngược lên cha), `alp.library.*` → `library.*` (giữ marker secret nguyên vẹn khi round-trip, đọc lại
   sau `revision_conflict`), team models → `team.list`. Fallback core trực tiếp chỉ ở entry local/embedded.
4. Slice backend tiếp theo, mỗi slice cần quyết định trước:
   - F19 registry: chọn cut-over (daemon sở hữu `web-workspaces.json` cùng định dạng, bridge ngừng ghi khi daemon
     có capability `workspace`) và chuyển logic gán root → workspace từ `paseo/workspaces.ts` sang daemon (không
     nhân đôi).
   - F20/F21 theo `workspaceId` hoặc `projectRoot`, có trần byte.
   - F14/F18: probe trong `@anhlp/alp-client` nhận `AbortSignal` để hủy khi connection đóng; grant `exec.probe`.
   - subscribe/notify theo §14.

## 5. Kiểm thử "không chung filesystem"

`remote-client.test.js` chạy alpd thật (`dist/alpd.js`, `ALP_HOME` = home của daemon, provider giả) và một client
process riêng:
- `HOME`, `ALP_HOME`, `cwd` riêng; chỉ import `@anhlp/alp-client/portable` + `@anhlp/alp-client/ipc`;
- chạy dưới Node permission model, chỉ được đọc mã của chính nó, `packages/client`, `packages/protocol`. Test kiểm
  tra process cùng cờ không đọc được `settings.json` của daemon (`ERR_ACCESS_DENIED`); thử import
  `@anhlp/alp-core` cũng bị chặn;
- tạo/đóng task, save/get MCP có secret, đặt ngôn ngữ, đọc team/agents; restart alpd rồi đọc lại; xác nhận dữ liệu
  nằm trên daemon host, secret không xuất hiện trong output của client, home path của daemon không lộ.

## 6. File dùng chung cần merge cẩn thận

| File | Lý do |
|---|---|
| `packages/protocol/schema/methods-v1.json`, `schema/ipc-v1.json` | method, `$defs`, lỗi, capability, `x-alp`; hai file phải có `$defs` giống hệt |
| `packages/protocol/src/contract-v1.js` | sinh từ schema: chạy lại `node packages/protocol/scripts/generate.mjs`, đừng merge tay |
| `packages/protocol/fixtures/v1/cases.json` | sinh từ `scripts/fixtures.mjs`: merge script rồi chạy lại |
| `packages/protocol/src/wire.js` | `ERROR` (+1003, 1005), `CAPABILITY` (+4), `RPC_METHODS` |
| `packages/protocol/src/rpc.ts`, `src/dto.ts` | kiểu method và DTO mới |
| `docs/protocol/alp-json-rpc-v1.md` | §5, §6.2, §10, §12–§15 |
| `packages/daemon/src/server.ts`, `src/main.ts` | `RpcError` chuyển sang `rpc-error.ts`; option `home`/`templates`; tên v1 dành riêng cho extension |
| `packages/core/src/tasks.js`, `tasks.d.ts`, `task-rows.js` | `resolveGate` nhận `ifRev`; `taskRow.rev` |
| `packages/daemon/tests/wire.test.js`, `methods.test.js`, `packages/protocol/tests/contract.test.js` | kỳ vọng inventory/capability/lỗi mới |
