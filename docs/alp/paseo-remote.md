# ALP Paseo remote mode (Task 09B-2)

> **Trạng thái beta `0.0.0-beta.2`: deferred.** Chế độ remote (`ALP_GATEWAY_URL`) cần
> `@anhlp/alp-gateway`, package này không phát hành trong beta. Beta chỉ hỗ trợ chế độ
> local/embedded. Tài liệu này mô tả mã trong repo; kết quả ở §7 là bằng chứng lịch sử của nhánh
> phát triển (tarball 0.10.0), không phải của bản beta. Phạm vi: [beta-scope.md](beta-scope.md) §4.

Plugin Paseo của ALP (`integrations/paseo`) có hai chế độ:

- **local/embedded** (như trước): plugin tìm hoặc khởi động alpd trên máy này, đọc library trong
  `ALP_HOME`, ghi tasks trong `.alp/tasks`;
- **remote** (mới): alpd chạy trên một máy khác (ALP host). Plugin nói chuyện với nó qua
  [remote gateway](remote-gateway.md) bằng Client SDK/Protocol v1. Trên máy chạy Paseo, plugin
  không gọi core/runtime, không đọc/ghi file của ALP, không khởi động process nào.

Bản phân tích ban đầu: `docs/alp/paseo-remote-rpc-gap-analysis.md` (F01–F26). Ma trận hoàn thành ở
§8.

## 1. Phạm vi

- Topology T1: H1 (provider Paseo desktop + các panel) đi remote qua gateway. **H2** (web bridge
  `alp web`, ứng dụng web fork của Paseo) vẫn chạy trên ALP host, cạnh alpd. Nó không thuộc 09B-2.
- Một credential gateway = một danh sách workspace (project root trên ALP host) + permission +
  (tùy chọn) mode. Danh sách workspace của remote mode là **grant của credential**. Gateway là
  nguồn duy nhất; plugin không ghi registry workspace nào (không dual-write).
- Không có fallback ngầm: khi đã cấu hình remote, lỗi kết nối hay lỗi xác thực hiện thành lỗi,
  plugin không quay về alpd local.

## 2. Bật remote mode

Biến môi trường của **process Paseo daemon** (process nạp plugin):

| Biến | Giá trị |
|---|---|
| `ALP_GATEWAY_URL` | `https://alp.example.com` (gốc của gateway). `http://` chỉ được với host loopback (`127.0.0.1`, `::1`, `localhost`). Không chứa user/password, query hay fragment |
| `ALP_GATEWAY_TOKEN` | token `alpgw1.…` do `alp-gateway credential create` in ra trên ALP host |

Có một biến mà thiếu biến kia → plugin báo lỗi cấu hình và không khởi động gì. Không có biến nào →
chế độ local như cũ.

- Token chỉ đi trong header `Authorization` của `POST /v1/tickets`. WebSocket dùng ticket một lần
  (30 s) trong subprotocol, không có secret dài hạn trong URL (remote-gateway §4.1).
- Lỗi không chứa token. Test E2E kiểm tra token không có trong output client, log gateway và log
  Paseo.

## 3. Kiến trúc

```
Paseo UI ─▶ Paseo daemon ─▶ plugin (remote) ─▶ @anhlp/alp-client/portable + websocket
                                                  │  HTTPS: POST /v1/tickets (Bearer)
                                                  ▼  WSS: alp.v1 + ticket
                                              alp-gateway ─▶ alpd (IPC, chỉ trên ALP host) ─▶ Codex/Claude/ACP
```

| File | Vai trò |
|---|---|
| `server/provider-core.ts` | Phần chung: dịch input Paseo ↔ event alpd (timeline, turn, câu hỏi, todo → Tasks pill), relink, cursor. Không import core/runtime |
| `server/mapping-wire.ts` | Helper thuần (mode, tên team, handle) dùng chung |
| `server/provider.ts` | Chiến lược **local/embedded**: alpd local (`readLock`/`startDaemon`) hoặc runtime nhúng. Không đổi hành vi |
| `server/remote/link.ts` | `gatewayConfig`, ticket → WebSocket → `daemon.hello`, kiểm tra capability (`attach.after`, `prompt.receipts`), map thư mục ↔ workspace |
| `server/remote/provider.ts` | Chiến lược **remote**: teams từ `team.list`, spec chỉ gồm `cwd`/`agent`/`workflow`/`mode`/`persist`, mode theo `principal.modes`, cursor theo root, không gửi lại request sau relink |
| `server/remote/panels.ts` | RPC của Tasks panel, Settings ALP, Usage qua gateway; phần không có thì trả `Unavailable in ALP remote mode: …` |
| `server/remote/index.ts` | `contributeRemote`; export `@anhlp/alp-paseo/remote` |
| `server/index.ts` | `contribute()`: có `ALP_GATEWAY_URL` → `contributeRemote`, return; không giám sát alpd local |

### 3.1 Ranh giới import (gate build)

- `scripts/build-paseo.mjs` build riêng `server/remote/index.ts` thành `server/dist/remote/index.js`
  với metafile; `assertRemoteInputs` (`scripts/build-manifest.mjs`) làm build **fail** nếu bundle
  có input từ `packages/{core,runtime,daemon,cli}`, file client ngoài `portable.js`/`websocket.js`/
  `rpc/`, file local của plugin (`provider`, `mapping`, `index`, `main`, `web`, `tasks`, `library`,
  `usage`, `panel/*` trừ `session-tasks`/`compat`, `paseo/*`), hoặc import `fs`, `child_process`,
  `worker_threads`, `cluster`, `module`, `vm`.
- `scripts/check-boundaries.mjs`: file trong `server/remote/` không được import trực tiếp các
  package/module trên.
- Entry plugin mà Paseo nạp (`index.server.ts` → `server/dist/index.js`) vẫn chứa cả code local,
  vì cùng một plugin phục vụ hai chế độ. Ở remote mode `contribute()` trả về trước khi gọi tới code
  local; E2E thật (§7) kiểm tra `ALP_HOME` phía client vẫn rỗng.

### 3.2 Session và đường dẫn

- `cwd` của Paseo phải **bằng đúng** một workspace của credential (đường dẫn đã nhập hoặc
  canonical). Sai → lỗi `… is not a workspace your ALP credential grants. Open one of: …`.
  Đường dẫn là của ALP host: muốn mở trong Paseo thì workspace Paseo phải trỏ cùng đường dẫn
  (vd. cùng cấu trúc thư mục, hoặc mount).
- Catalog không có thư mục (danh sách provider toàn cục của Paseo): trả hai team có sẵn của ALP (Phở,
  Cafe), không hỏi alpd và không tự chọn workspace. Có thư mục thì liệt kê team của workspace đó;
  thư mục ngoài grant vẫn bị từ chối.
- Team chọn bằng model id Paseo (`pho`, `cafe`, team của library/project trên host) → `workflow`.
  Gateway nhận `workflow` theo quy tắc tên (PR này thêm vào `SPEC_FIELDS`).
- MCP servers, biến môi trường và system prompt của Paseo **không gửi** sang host; session nhận
  một notice nói rõ. `toolPolicy` và handle persistence v1 (thread native) bị từ chối.
- Mode: catalog chỉ hiện mode trong `principal.modes`. Mặc định `full-access` nếu được cấp.

### 3.3 Mất kết nối, replay, không retry

- Provider giữ cursor cuối của mỗi root. Sau khi kết nối lại (ticket mới): `session.attach
  { sessionId, after }`; envelope có cursor ≤ cursor đã thấy bị bỏ. `reset: true` (cursor đã bị
  retention xóa) → đặt cursor về tip và hiện cảnh báo trong timeline.
- Một lần kết nối lại chỉ được dùng khi link mới **vẫn sống sau khi mọi root đã attach lại**. Link
  đứt trong lúc `session.get`/`session.attach`, hoặc lỗi tạm thời (gateway `1000
  daemon_disconnected`/`gateway_timeout`, timeout), làm lần đó thất bại: link bị đóng (gỡ listener),
  thử link khác sau backoff (250 ms → 5 s); root, cursor và ánh xạ id giữ nguyên. Chỉ lỗi có code
  phán quyết mới làm root thất bại: `1001` (session không còn), `1003` (credential không còn được
  thấy nó), `-32601`/`-32602`. Gateway từ chối credential (`401` khi xin ticket) → mọi session báo
  lỗi một lần, ngừng kết nối lại. Đóng provider dừng backoff, không mở link mới. Lúc attach lại chỉ
  gửi lệnh đọc. Test: `integrations/paseo/tests/remote-reattach.test.js`.
- alpd đóng root rảnh khi không còn ai xem (vd. gateway restart lúc session rảnh). `session.closed`
  đó tới bằng replay khi kết nối lại; provider **không** chuyển cho Paseo mà đánh dấu root dormant,
  prompt kế tiếp mở lại bằng `session.create { resume: true }`. `session.closed` tới lúc đang xem
  vẫn được chuyển. Test: integration "gateway restart lúc rảnh" + E2E thật "gateway restart hai lần".
- **Không gửi lại** prompt/message/answer/interrupt mà kết quả chưa rõ (`repeatAfterRelink: false`).
  Người dùng thấy lỗi và tự gửi lại. Local mode giữ hành vi cũ (gửi lại một lần sau relink, vì cùng
  máy).
- Tasks panel: `task.create` gửi kèm `requestId` ngẫu nhiên; alpd chỉ dedup trong một process. Panel
  không bao giờ tự gửi lại; alpd restart giữa chừng thì người dùng xem danh sách rồi quyết định.
- Library revision đổi sau khi alpd restart; remote không ghi library nên không bị ảnh hưởng.

## 4. Panels ở remote mode

| Panel / RPC | Remote |
|---|---|
| Tasks: list/add/close/reopen/accept, duyệt human gate | ✅ `task.list`, `task.create`, `task.update`, `task.gate.resolve` |
| Tasks pill của session | ✅ (từ item todo, như local) |
| Settings ALP: danh sách entry | ✅ `library.list` (chỉ tên/mô tả, gateway lọc field). Màn hình ở chế độ chỉ xem: ẩn New/Duplicate/Override/Use library, mở được dòng và mục điều hướng để xem nội dung đã redaction; không có form sửa, Save, Remove hay Test, hiện lý do. Không mở workspace nào → không có entry và nói cần mở workspace được cấp (không còn "Loading…" treo) |
| Settings ALP: danh sách model | ✅ `library.models` |
| Ngôn ngữ (đọc) | ✅ `settings.language.get`; hiện giá trị và lý do, không có ô chọn |
| Xem nội dung entry (`library.get`) | ✅ `project.read` trong workspace được cấp; nội dung JSON chỉ đọc, secret là marker và có danh sách JSON Pointer. Gateway giữ đường dẫn host và field ngoài contract. |
| Lưu/xóa/nhân bản/đổi tên entry, gán skills, đổi ngôn ngữ | ❌ Unavailable: làm trên ALP host |
| Nút Test (MCP/hook/provider) | ❌ Unavailable: sẽ chạy lệnh trên host |
| Usage | ❌ Unavailable: account-wide trên host (`alp usage`) |

## 5. Lỗi thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| `ALP gateway refused the credential (401)` | token sai, bị thu hồi/xoay/hết hạn |
| `… is not a workspace your ALP credential grants` | `cwd` không phải workspace được cấp (khớp tuyệt đối) |
| `… modes read-only` | credential giới hạn mode; chọn mode được cấp |
| `The ALP gateway lacks attach.after / prompt.receipts` | gateway/alpd quá cũ |
| `Unavailable in ALP remote mode: …` | tính năng không có qua remote (§4, §9) |

## 6. Kiểm thử (fake provider)

| Bộ test | Chạy bằng | Nội dung |
|---|---|---|
| `test/integration/paseo-remote.test.js` | `node scripts/test.mjs integration`; lane paseo | 3 process không chung file: alpd (`ALP_HOME` A, **fake Codex**), `alp-gateway serve`, phía Paseo (`dist/remote/index.js` + plugin host giả) chạy với `node --permission --allow-fs-read=<repo> --allow-net`. Probe: đọc A/project và spawn → `ERR_ACCESS_DENIED`. Catalog, create (notice env), prompt + stream, câu hỏi allow/deny, tasks add/list/close, library list/models/language, các RPC unavailable, interrupt → `canceled`, gateway restart giữa turn → `turn.ended` tới đúng một lần bằng replay, alpd restart → prompt tiếp được, không item trùng, mỗi prompt tới provider một lần, không token trong output/log. Credential `read-only`: catalog chỉ có `read-only`, full-access và thư mục ngoài grant bị từ chối |
| `apps/gateway/tests/*.test.js` | lane core | `workspaceRoots` trong principal; `workflow` theo quy tắc tên |
| Local/embedded regression | `integrations/paseo/tests/*` (lane paseo) | toàn bộ test cũ của provider/panels chạy trên `provider.ts` mới |
| Gate build | `npm run build` / lane packages | `assertRemoteInputs`, `check-boundaries` |

## 7. E2E thật trên macOS (real provider)

`node test/e2e/paseo-remote-e2e.mjs` (opt-in, gọi model thật; cần `codex` đã đăng nhập và `paseo`
0.11.x). Tách bạch với test fake ở §6:

1. `npm pack` mọi workspace → hai project cài sạch từ tarball: **host** (alp-cli, daemon,
   gateway…) và **client** (plugin + peer Paseo).
2. Host: `alp daemon start` với `ALP_HOME` tạm, Codex thật; `alp-gateway credential create`;
   `alp-gateway serve` trên 127.0.0.1.
3. Client: Paseo daemon riêng (`paseo daemon run --home <tmp>`, port riêng, relay tắt), cài plugin từ
   thư mục tarball đã cài, chỉ có `ALP_GATEWAY_URL`/`ALP_GATEWAY_TOKEN` và `ALP_HOME` rỗng.
4. Qua `@getpaseo/client`: teams, create, prompt có tool call, câu hỏi allow/deny, cancel, gateway
   restart giữa turn, alpd restart, kiểm tra `ALP_HOME` client rỗng và token không có trong log.

Kết quả lần chạy: xem §8.1.

## 8. Ma trận hoàn thành (H1: provider + panels)

Ký hiệu: ✅ có qua remote, có test; ◐ một phần; ❌ unavailable (UI báo rõ); — không thuộc H1.

| ID | Luồng | Remote | Bằng chứng / ghi chú |
|---|---|---|---|
| F01 | Kết nối alpd | ✅ | gateway ticket + WebSocket + `daemon.hello` + capability; không spawn, không đọc lock (`link.ts`, probe trong integration test) |
| F02 | Chọn team | ✅ | `team.list` theo workspace; catalog ở integration + E2E thật |
| F03 | Danh sách session, resume | ◐ | session của chính Paseo (persistence handle v2) resume được; danh sách toàn host không lấy (Paseo lưu agent của nó) |
| F04 | Tạo/mở/resume session | ✅ | spec tối thiểu, cwd = workspace được cấp; notice env/MCP/system prompt |
| F05 | Streaming | ✅ | timeline/turn qua event; integration + E2E thật |
| F06 | Reconnect/replay/restart | ✅ | cursor theo root + `attach after`; gateway restart giữa turn, alpd restart |
| F07 | Prompt, steer, interrupt, mode, đóng | ✅ | không gửi lại sau relink; interrupt → `canceled`; mode theo grant |
| F08 | Câu hỏi (`alp_ask`) | ✅ | allow + deny (integration + E2E thật) |
| F09 | Subagents | ✅ | cùng projection như local (event của tree) |
| F10 | Tasks panel | ✅ | `task.*`; add/list/close trong integration test |
| F11 | Tasks pill | ✅ | như local |
| F12 | Library list/get/save/… | ◐ | list + models + get (chỉ đọc, đã redaction); save/delete/duplicate/rename/skills ❌ |
| F13 | Sync team settings | ❌ | ghi library không có qua remote |
| F14 | Nút Test | ❌ | chạy lệnh trên host |
| F15 | Danh sách model | ✅ | `library.models` |
| F16 | Ngôn ngữ | ◐ | đọc ✅, đổi ❌ |
| F17 | Usage | ❌ | không expose qua gateway |
| F18 | Providers snapshot/probe | ❌ | provider probe không có qua remote |
| F19 | Workspace registry | ◐ | danh sách = grant của credential (một nguồn, gateway); thêm/sửa workspace từ xa ❌ (`alp-gateway credential` trên host) |
| F20 | Git status/diff | ❌ | không có RPC; Paseo vẫn thấy git của thư mục **trên máy Paseo** nếu có |
| F21 | Files | ❌ | không có RPC; tương tự F20 |
| F22 | Daemon config/relay/pairing | — | H2; gateway thay cho relay ở remote |
| F23–F25 | Catalog plugin, quiet, find in chat | — | H2 |
| F26 | Xác thực | ✅ | credential + ticket gateway |
| — | `subscribe`/notify | ❌ | v1 không có; Tasks panel poll như local |

### 8.1 Bằng chứng chạy (macOS)

macOS (Darwin 27, Apple silicon), Node 26.3, Paseo 0.11.1, Codex CLI 0.162.1 đã đăng nhập; tarballs
0.10.0 của nhánh này. SHA và log đầy đủ ở PR.

| Flow | Fake (`paseo-remote.test.js`) | Thật (`npm run test:e2e:paseo-remote`) |
|---|---|---|
| Cài sạch từ tarball (host / client tách) | — | pass (8 tarball) |
| alpd + gateway khởi động, xác thực (không token → 401) | pass | pass |
| Plugin trong Paseo daemon riêng, chọn team | pass (catalog) | pass (`pho`, `cafe`) |
| Create, prompt, tool call, streaming | pass | pass (`cat token.txt` → token; `tool_call`, `assistant_message`, `turn_completed`) |
| Câu hỏi allow | pass | pass (`yes`) |
| Câu hỏi deny | pass | pass (`DISMISSED`) |
| Tasks add/list/close | pass | không chạy (không cần model; fake đủ) |
| Cancel | pass (`canceled`) | pass (~0.7 s) |
| Gateway restart giữa turn, replay không trùng | pass | pass (message cuối đúng 1 lần) |
| Gateway restart lúc rảnh (alpd đóng root không ai xem) | pass (root được mở lại) | pass (`gateway.restart.twice`: restart hai lần liên tiếp, prompt sau đó chạy) |
| Link đứt / lỗi tạm thời trong lúc reattach, nhiều root, đóng khi đang retry, credential bị từ chối | pass (`remote-reattach.test.js`, link giả) | — |
| alpd restart, resume | pass | pass |
| Credential mode `read-only` | pass | không chạy |
| Client không đọc host / không spawn | pass (permission model) | `ALP_HOME` client rỗng |
| Token không trong log | pass | pass (log gateway + Paseo) |
| Embedded/local regression | lane paseo: 136 test package Paseo pass | — |

**UI smoke** (web app Paseo 0.11.1 có sẵn trong `Paseo.app/Contents/Resources/app-dist`, phục vụ trên
127.0.0.1, thao tác bằng Playwright; Paseo daemon cô lập + plugin remote + gateway + alpd tạm + codex
thật; không phải cửa sổ Electron desktop): mở workspace, chọn ALP → Phở, prompt có tool call và
stream, question allow/deny, Tasks panel thêm/đóng task, Stop agent (turn `canceled` trên host),
gateway restart hai lần lúc rảnh rồi prompt (`ALP reconnected to alpd.`), Settings ALP chỉ xem (không
"Loading…" treo, không New, có lý do), Language chỉ xem, trang Providers: "ALP · Available · 2
models".

## 9. Không hỗ trợ / giới hạn còn lại

- H2 (web bridge) chỉ chạy trên ALP host.
- Workspace registry, git, files, provider probe, usage, ghi library, đổi ngôn ngữ:
  không qua remote (UI báo `Unavailable in ALP remote mode`).
- MCP servers/env/system prompt của Paseo không gửi sang host.
- `cwd` phải bằng đúng một workspace được cấp; thư mục con không được.
- Không có `subscribe`: Tasks panel poll.
- `task.create` chỉ dedup trong một process alpd; library revision đổi sau restart.
- Request chưa rõ kết quả khi mất kết nối không được gửi lại; người dùng gửi lại.
- Entry plugin chung vẫn bundle code local (§3.1); chỉ entry `@anhlp/alp-paseo/remote` là bundle
  không có core/runtime.
- Windows: test integration dùng fake Codex là script Node nên bị bỏ qua trên Windows; E2E thật chỉ
  chạy trên macOS.

## 10. Runbook beta trên macOS

Trên **ALP host** (máy có project và Codex/Claude đã đăng nhập):

```sh
alp daemon start
alp-gateway credential create --label paseo-beta --workspace /đường/dẫn/project --json   # in token MỘT lần
alp-gateway serve                                   # 127.0.0.1:7434; để chạy, không đóng terminal
curl -s http://127.0.0.1:7434/readyz                # 200 khi alpd sẵn sàng
```

Từ **máy chạy Paseo** (nếu khác máy): không mở port gateway ra Internet. Dùng SSH tunnel
(`ssh -N -L 7434:127.0.0.1:7434 user@alp-host`) để URL vẫn là loopback, hoặc reverse proxy TLS
(`apps/gateway/deploy/Caddyfile`, [remote-gateway.md](remote-gateway.md) §7.2) với `https://`.

Trên **máy chạy Paseo**, một Paseo daemon riêng (không đụng `~/.paseo` đang dùng):

```sh
export ALP_GATEWAY_URL=http://127.0.0.1:7434        # hoặc https://alp.example.com
export ALP_GATEWAY_TOKEN='alpgw1.…'                 # chỉ trong env, không ghi vào file dùng chung
paseo daemon config set daemon.listen 127.0.0.1:6868 --string --home ~/.paseo-alp-remote   # khác 6767 của Paseo đang dùng
paseo daemon config set pluginsEnabled true --home ~/.paseo-alp-remote
paseo daemon run --home ~/.paseo-alp-remote         # terminal riêng, giữ env ở trên
paseo plugin install /đường/dẫn/@anhlp/alp-paseo --home ~/.paseo-alp-remote
```

Trong Paseo app, thêm host `127.0.0.1:6868` để xem daemon này. `/đường/dẫn/@anhlp/alp-paseo` là
thư mục `integrations/paseo` đã build (`npm run build`), hoặc `node_modules/@anhlp/alp-paseo` của
một project đã `npm install` tarball plugin.

Rồi mở workspace có thư mục **đúng bằng** đường dẫn đã cấp, chọn ALP → Phở/Cafe. Thử nhanh không
cần UI: `npm run test:e2e:paseo-remote` (tự dựng mọi thứ trong thư mục tạm).

Xử lý sự cố: §5. Thu hồi: `alp-gateway credential revoke <id>` trên host.
