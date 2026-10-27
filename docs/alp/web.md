# ALP web (Task 10A, beta)

> **Trạng thái (bản beta sau `0.0.1-beta.3`, chưa phát hành).** App `apps/web` (`@anhlp/alp-web`,
> private) không phải là package riêng: nó được build vào CLI (`@anhlp/alp`, `@anhlp/alp-cli`,
> `dist/alp-web/`) và mở bằng `alp web` (§3.1). `@anhlp/alp-gateway` vẫn không phát hành; CLI mang
> sẵn gateway trong `dist/alp-web.js`. Cách triển khai riêng ở §3.2 cần `alp-gateway` chạy từ
> checkout. Trong `0.0.1-beta.3` đã phát hành, `alp web` vẫn là web của Paseo trong
> `@anhlp/alp-paseo`. Kết quả ở §9 là bằng chứng lịch sử của nhánh phát triển. Phạm vi:
> [beta-scope.md](beta-scope.md) §4.

App trình duyệt độc lập (`apps/web`, package `@anhlp/alp-web`, private). App nói chuyện với alpd
**chỉ qua** ALP remote gateway ([remote-gateway.md](remote-gateway.md)) và client SDK
([client-sdk.md](client-sdk.md)). Từ bản này `alp web` mở app này (service `alp-web`) thay cho web
của Paseo. Web của Paseo (`paseo-web/`, `server/dist/web-app` trong `@anhlp/alp-paseo`) đã bị gỡ
khỏi repo và package plugin (t-55ce.3); integration `paseo` chỉ còn bridge, relay và `alp web pair`.

Luồng: `Browser → HTTPS/WSS (hoặc loopback/SSH) → alp-gateway → IPC → alpd`.

Số mục (§) có thể được code và test tham chiếu; giữ ổn định.

## 1. Phạm vi beta

| Có | Chi tiết |
|---|---|
| Kết nối | `alp web` mở link có sẵn token và app tự kết nối (§3.1, §4.2). Hoặc form kết nối: HTTPS, hoặc HTTP chỉ trên loopback (`127.0.0.1`, `localhost`, SSH tunnel); token dán tay chỉ giữ trong bộ nhớ của tab. Trên trang loopback của bản build (như trang `alp web` phục vụ; dev server Vite thì không), ô gateway mặc định là origin của trang (địa chỉ đã nhớ thì ưu tiên), và "Getting a token" chỉ tới `alp web`, `alp web --print`, `alp web rotate` trước, rồi tới `alp-gateway credential create` + `serve --origin` cho gateway riêng. |
| Projects | Các workspace mà credential cấp (`principal.workspaces`), cùng registry chung của host (`workspace.registry`, protocol §16, #121): **Add project** chỉ đăng ký một thư mục đã được cấp sẵn (`workspace.write`; không duyệt thư mục của host, không cấp thêm quyền), pin chung giữa các client và giữ qua restart, worktree tạo/xóa theo mapping chủ host đã duyệt (`workspace.manage`, chỉ macOS/Linux). Web chưa có nút bỏ project (`project.remove` của protocol chỉ bỏ đăng ký, không xóa file). |
| Sessions | Liệt kê, tạo (team, permissions, model, title), mở, đổi tên, archive. Mỗi agent của cây (main và assignment) là một tab. Trên Codex và Claude (#121): fork và rewind chỉ hội thoại (§12.7, không đổi file), đổi team/model/thinking khi session đang sống (§12.9, đổi team cần thêm `session.team.write`), Reload agent và Copy resume command trong menu tab (§12.8), tải lịch sử cũ hơn (`session.history`, §8.7), đính kèm file không phải ảnh (§12.6, cần `attachments.write`). |
| Chat | Prompt + stream, tool call, todo, notice; trả lời câu hỏi theo luồng chọn rồi Submit của Paseo (Other thay lựa chọn, Enter gửi, Dismiss), thẻ câu hỏi nằm trong stream; interrupt; steer khi agent đang chạy; hàng đợi (§4.3). |
| Tasks | Liệt kê (poll), tạo, mở chi tiết trong tab lớn, đóng, mở lại, duyệt human gate. Mọi thay đổi gửi `ifRev`. |
| Settings | Bố cục như `alp web` cũ: App (General, Appearance, Sidebar, Chat, Terminal, Editor, Diagnostics, About) và Host (Overview, Projects, Connections, Templates, Agents, Skills, Hooks, MCP servers, Providers…). Library xem nội dung đã redaction: file Markdown dưới dạng text, cấu hình dưới dạng JSON. Instruction agents/skills riêng của project sửa được với explicit `library.write` (#118). Mục chưa hỗ trợ ghi rõ "not available in this beta". |
| Workspace | Phím tắt như Paseo (dialog Shortcuts), History với session đã archive và Unarchive, attention trên mọi session (`question.list`), menu chuột phải của tab, kéo đổi thứ tự tab, tab giữ qua reload, sidebar và dock kéo đổi độ rộng, command center (⌘K), trạng thái trên favicon và title, notification của trình duyệt khi session chờ trả lời. |
| New session | Màn hình như tab new agent của Paseo: tin đầu tiên, chọn team/model/thinking/permissions, `session.preview`, nhớ lựa chọn lần trước (§4.2). |
| Phục hồi | Reconnect có backoff, resume theo cursor, reload trang, gateway hoặc alpd khởi động lại (§5). |

Không có trong beta (app ghi rõ, không fallback sang Paseo hay app nhúng): duyệt hoặc tạo thư mục trên
host, ghi git (commit, push, pull, đổi nhánh) và sửa file, sửa library của host hoặc cấu hình thực thi, thêm/kiểm tra provider,
usage, đổi ngôn ngữ agent, plugin, pair device.

Terminal (#121 H, §12.10): tab Terminal chạy shell thật trên máy chạy alpd, **bằng tài khoản chạy
alpd; workspace không phải sandbox** (shell đọc/ghi được mọi thứ tài khoản đó đọc/ghi được và dùng
được mạng); panel ghi rõ điều này lần đầu mở trong phiên trang và luôn có một dòng header. Chỉ có khi
chủ host đã chạy `alp terminal allow --yes` và token có `terminal.exec` (không bao giờ là mặc định);
thiếu thì panel ghi lý do và không mở terminal.

## 2. Cài đặt, chạy, build

```sh
npm ci                       # ở gốc repo
npm run dev:alp-web          # Vite dev server: http://127.0.0.1:7435
npm run build:alp-web        # bundle tĩnh ở apps/web/dist
npm run typecheck:alp-web
npm run test:alp-web         # unit test (node:test)
npm run test:alp-web:e2e     # build cli, daemon, web rồi chạy Playwright
npm run validate:web         # cả lane CI: tsc, unit, boundary, build, E2E
```

- Port mặc định: Vite dev server **7435**, `alp-gateway` riêng **7434**, `alp web` (alp-web: app và
  gateway trên một listener) **7433**. Test dùng port ngẫu nhiên.
- E2E cần Chromium của Playwright: `npx playwright install chromium` (Linux:
  `--with-deps`).
- Thử bằng tay với host dùng một lần (alpd + fake Codex + gateway trong thư mục tạm):
  `node apps/web/e2e/support/serve.js`. Script in URL và token. Ctrl-C dừng mọi thứ và xóa thư mục
  tạm. Không đụng `~/.alp` và không đụng alpd thật.

## 3. Triển khai

### 3.1 `alp web` trên máy này (alp-web)

```sh
alp web            # chạy service alp-web nếu chưa chạy, rồi mở link có token
alp web --print    # chỉ in link
alp web rotate     # thay token; trang đang mở mất quyền
```

- Service: `alp web` chạy `dist/alp-web.js` của CLI (source `packages/cli/src/web/`). Một listener
  trên `127.0.0.1` tại `web.port` (mặc định **7433**; port bận thì thử chín port kế tiếp) phục vụ
  file của app (`dist/alp-web/`) và gateway nhúng trên cùng origin. Service giữ
  `integrations/web.lock`, ghi `<home>/web.json` (`version: 2`, `app: "alp-web"`, pid, port, URL,
  token) và log ở `<home>/logs/integrations/alp-web.log`. Service giữ alpd chạy (`ALP_SUPERVISE=0`
  thì không), trừ sau `alp daemon stop`.
- Link: `http://127.0.0.1:<port>/#token=alpgw1.…`. Token là credential gateway thật, lưu trong
  `<home>/web/credentials.json` (thư mục 0700, file 0600 của user; sai quyền thì service không
  chạy). Đây là kho riêng của alp-web: `alp-gateway credential list/create/revoke` (đọc
  `<home>/gateway`) không thấy credential này. Lần chạy sau dùng lại token trong `web.json` khi nó
  còn hợp lệ.
- `alp web rotate`: dừng alp-web, tạo credential mới, revoke mọi credential khác trong kho đó (token
  cũ hết hiệu lực, trang đang mở nhận 401 và báo chạy `alp web` lại), rồi chạy lại service và in link
  mới. Với `"web": { "enabled": false }`, rotate vẫn thay token nhưng không chạy lại service.
- Quyền mặc định: `DEFAULT_PERMISSIONS` của gateway cộng `workspace.write`, tức `session.read`,
  `session.write`, `project.read`, `project.write`, `workspace.write`. Các quyền khác (ví dụ
  `files.read`, `attachments.write`, `session.team.write`, `terminal.exec`) chỉ có khi thêm vào
  setting `web.permissions` (mảng). Chỉ cần một mục không phải quyền của credential là alp-web bỏ
  qua **cả danh sách** và ghi warning; grant giữ mặc định. Còn một mục sai dạng (không phải chuỗi
  chữ thường và dấu chấm, ví dụ `"files-read"`) làm cả `settings.json` không hợp lệ: cả alpd lẫn
  alp-web đều bỏ qua toàn bộ file (với alp-web là kể cả `web.port`; với alpd là mọi setting của nó)
  và ghi `ALP_SETTINGS_INVALID` vào log. Có `terminal.exec` thì log
  ghi cảnh báo của gateway.
- Workspace được cấp: registry project của alpd (project chưa bị bỏ) ∪ thư mục mà `alp web` đang
  đứng khi khởi động service (hoặc khi `alp web rotate`), nếu thư mục đó có `.alp/` (là project
  ALP). Đường dẫn được so theo realpath. alp-web theo dõi registry khoảng mỗi 5 giây; grant đổi
  thì credential được cập nhật (giữ token) và gateway đóng các kết nối với 4403, app tự nối lại.
- `web.enabled=false` chỉ tắt alp-web (`alp web`); integration Paseo và `alp web pair`
  vẫn chạy. Relay của Paseo vẫn tuân theo `web.relay.enabled` (và `alp web pair --off`).
- Setting: `web.port`, `web.permissions`, `web.enabled` chỉ được đọc khi service khởi động. Không
  có `alp web stop`, và `alp daemon stop` không dừng alp-web. Muốn áp dụng thay đổi: dừng process
  có pid trong `<home>/web.json` (macOS/Linux: `kill <pid>`; Windows: `taskkill /PID <pid>`), rồi chạy `alp web`; token được giữ.
  `alp web rotate` cũng khởi động lại service, nhưng với token mới.
- Nâng cấp từ `alp web` dựa trên Paseo: nếu integration Paseo cũ vẫn giữ `web.lock` (`web.json`
  không có `app`), `alp web` gửi SIGTERM cho nó, chỉ khi chứng minh được đó là process của chính
  user, cùng lần boot, và pid không bị dùng lại (macOS/Linux; Windows không dừng nó). Trước lần đầu
  ghi đè `web.json`, alp-web chép token và server id của integration cũ sang `<home>/paseo.json` một
  lần, chỉ khi `paseo.json` chưa có, để thiết bị đã pair vẫn dùng được.
- **Windows:** macOS vẫn là nền tảng chính; trình duyệt E2E chạy trên Linux và macOS. Service
  alp-web và gateway được kiểm thử trong CI Windows (`windows-daemon` trên Node 22 và 24). Thao tác
  ghi đè `credentials.json` và `web.json` có cơ chế retry/backoff để xử lý lỗi `EPERM`/`EBUSY` khi
  file đang được đọc. Trên Windows, alp không tự dừng alp-web hay integration Paseo cũ đang chạy:
  `alp web rotate` và bước takeover khi nâng cấp từ chối khi chúng còn chạy. Dừng process có pid
  trong `<home>/web.json` (`taskkill /PID <pid>`), rồi chạy lại lệnh. Cách dừng này không phải shutdown
  sạch; lần khởi động sau tự lấy lại lock.

### 3.2 Triển khai riêng với `alp-gateway`

`apps/web/dist` là file tĩnh. Có thể phục vụ bằng bất kỳ web server nào, khác origin với gateway
cũng được.

1. Cấp credential cho các workspace sẽ mở trên web:
   ```sh
   alp-gateway credential create --label web --workspace /path/to/project
   ```
   Token in ra **một lần**. Thêm `--permission session.read --permission project.read` nếu chỉ
   cho xem; thêm `--mode read-only` để giới hạn mode.
2. Chạy gateway, cho phép origin của trang:
   ```sh
   alp-gateway serve --origin https://alp.example.com            # sau reverse proxy TLS
   alp-gateway serve --origin http://127.0.0.1:7435              # loopback / SSH tunnel
   ```
   - Origin khớp tuyệt đối (scheme, host, port). Không có wildcard.
   - Ticket bị ràng buộc với Origin của request.
   - Origin không nằm trong allowlist: gateway trả 403 và app báo "allows this page's origin".
3. TLS: dùng reverse proxy (`apps/gateway/deploy/Caddyfile`) như remote-gateway.md §7.2. Gateway
   từ chối HTTP từ ngoài loopback (`403 tls_required`). App cũng chỉ nhận `http://` khi host là
   loopback.
4. CSP (trong `index.html`):
   - `connect-src 'self' https: wss:` và loopback HTTP/WS;
   - `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.
   - Khi deploy trên domain riêng, có thể siết `connect-src` về đúng gateway.

Từ máy khác không có HTTPS: `ssh -L 7434:127.0.0.1:7434 -L 7435:127.0.0.1:7435 host`, rồi mở
`http://127.0.0.1:7435` và dùng gateway `http://127.0.0.1:7434`. App build sẵn trên loopback không
phân biệt được trang của `alp web` với bản tự phục vụ, nên ô gateway lúc đầu là origin của trang
(`http://127.0.0.1:7435`): gõ `http://127.0.0.1:7434` một lần, app nhớ địa chỉ đó cho lần sau.

## 4. Thiết kế

### 4.1 Ranh giới bundle

- Code trình duyệt chỉ import:
  - `@anhlp/alp-client/portable` và `@anhlp/alp-client/websocket`;
  - type của `@anhlp/alp-protocol`.
- Plugin Vite `build/browser-boundary.js` (`enforce: 'pre'`) dừng build ngay ở module đầu tiên vượt
  ranh giới, kể cả qua import bắc cầu. Module bị chặn:
  - `node:*`, module Vite thay bằng `__vite-browser-external`;
  - `ws`, `@anhlp/alp-{core,runtime,daemon,cli,gateway}`, Paseo, `@anhlp/alp-paseo`;
  - mọi file khác trong `packages/`, `integrations/`, `apps/`.
- Mỗi lần build ghi `dist/alp-boundary.json`, liệt kê các module ALP có trong bundle.
- `tests/boundary.test.js` chứng minh hai điều:
  - một import bắc cầu sang `@anhlp/alp-client` (entry Node) làm build thất bại;
  - bundle của app chỉ chứa các module SDK được phép.
- `scripts/check-boundaries.mjs` khai báo `@anhlp/alp-web` → `alp-client`, `alp-protocol`.

### 4.2 Credential và dữ liệu

- Khi kết nối, token nằm trong field private `#token` của `Controller`.
  - Không ghi log. Request ticket gửi `credentials: 'omit'`, `cache: 'no-store'`,
    `redirect: 'error'`, `referrerPolicy: 'no-referrer'`.
  - Không bao giờ lưu vào localStorage hay cookie.
- Token gõ vào form chỉ nằm trong bộ nhớ: reload hay đóng tab là mất.
- Link của `alp web` (`http://127.0.0.1:<port>/#token=alpgw1.…`, `src/lib/link-token.js`):
  - Khi trang load, `main.tsx` đọc `#token=` và kiểm tra dạng `alpgw1.<16 hex>.<43 base64url>`.
  - Fragment bị xóa ngay bằng `history.replaceState`, trước khi render, kể cả khi token hỏng.
  - Token hợp lệ được giữ trong sessionStorage của tab (key `alp-web:link-token`). Reload tab đó
    kết nối lại; tab khác và lần mở sau không thấy token.
  - App kết nối tới `location.origin` (alp-web vừa serve trang), chỉ khi trang ở loopback
    (`127.0.0.1`, `localhost`). Ngoài loopback, app không giữ và không dùng token của link.
  - Lần kết nối đầu không có form: app chờ alp-web lên (retry với backoff) và có nút
    "Use another access token".
  - Gateway từ chối token (401, sau `alp web rotate` hay revoke): app xóa token khỏi
    sessionStorage và hiện form với thông báo "This link's access token is no longer valid. Run
    `alp web` again…". Lỗi terminal khác (origin, TLS) giữ token cho lần reload sau.
  - Gateway đóng socket với 4403 (grant đổi, ví dụ alp-web thêm project mới): app tự nối lại với
    cùng token và nhận grant mới.
  - Disconnect hoặc kết nối bằng form thì xóa token của link. `pagehide` thì giữ để reload dùng lại.
- E2E kiểm tra token không có trong localStorage, URL, Referer, console và log.
- localStorage chỉ giữ ba key, không key nào chứa token hay secret:
  - `alp-web:gateway`: địa chỉ gateway;
  - `alp-web:preferences` (`src/lib/preferences.js`): Default send, theme (System/Light/Dark),
    lựa chọn của màn New session (team, mode, model, thinking theo model);
  - `alp-web:layout` (`src/lib/layout.js`): theo gateway + workspace, session đang mở, các tab
    (agent, task, panel), thứ tự, tab đang mở; độ rộng sidebar và dock. Chỉ id, không có tiêu đề
    hay dữ liệu khác của host.
  - Hai key sau có version, đọc dung thứ (field hỏng về mặc định, version khác hoặc rác thì về
    mặc định), và chỉ ghi các field đã biết.
- Disconnect, `pagehide` hoặc lỗi xác thực:
  - dừng reconnect và mọi timer;
  - xóa token trong bộ nhớ, cây session, hàng đợi và state về ban đầu;
  - token của link trong sessionStorage: xem ở trên.
- Settings có Reset để về mặc định.

### 4.3 Chat theo logic của Paseo

- Bố cục giữa:
  - header: nút sidebar, tên session + project, menu ⋯ (Rename, Copy session ID, Archive), nút
    bật/tắt explorer;
  - hàng tab: agent tab, task tab, panel tab, rồi + (menu New tab);
  - nội dung của tab đang mở.
- Enter gửi tin.
  - Khi agent đang chạy, mặc định Enter **steer**: `delivery: 'steer'`, tin nhập vào turn đang
    chạy.
  - Cmd/Ctrl+Enter đưa tin vào **hàng đợi**.
  - Settings › General › Default send (Steer/Queue) đảo hai phím này.
- Hàng đợi hiện trên ô chat. Mỗi tin có Edit (đưa lại vào ô) và Send now (steer ngay).
- Hàng đợi tự gửi tin kế tiếp khi đủ các điều kiện sau:
  - root đã idle;
  - kết nối đang mở;
  - root không còn tin nào đang gửi hoặc chưa rõ kết quả;
  - **turn của mọi tin mình đã gửi đã xong** (barrier theo root). Tin rời khỏi danh sách pending ngay
    khi `user_message` hiện ra, trước `turn.started`; event và response tới ở các task riêng, theo
    thứ tự bất kỳ (§8.2). Vì vậy hàng đợi chờ `prompt.accepted.turnId` rồi `turn.ended` của turn
    đó (hoặc `prompt.failed`). Một turn đã thấy chạy mà summary báo đã dừng (crash) cũng tính là
    xong. Sau một reset không còn history, tin gửi trước reset được coi là xong khi root idle.
- Cách gửi tin từ hàng đợi:
  - mỗi lần một tin, mỗi tin một `clientMessageId` mới, gửi đúng một lần;
  - tin gửi lỗi nằm lại trong timeline với Retry, và hàng đợi chờ người dùng xử lý.
- Nút chính:
  - Send khi ô có chữ;
  - Interrupt agent khi agent chạy và ô trống;
  - không có nút khi cả hai đều không đúng.
- Tab của assignment chỉ để xem. Muốn điều khiển assignment thì nói chuyện với main.

### 4.4 Gửi tin và kết quả không rõ

- Mỗi prompt có `clientMessageId` riêng. Host có `prompt.receipts`, nên gửi lại **cùng id, cùng
  nội dung** chỉ trả về kết quả của lần đầu.
- Ba trạng thái:
  - `failed`: tin chưa tới host, hoặc runtime từ chối.
  - `unknown`: có thể đã tới. Retry dùng cùng id khi an toàn. Với `outcome_unknown` thì dùng id
    mới.
  - Đã tới: timeline có `user_message` mang `clientMessageId` đó. Khi replay cho thấy điều này, tin
    `unknown` tự được xác nhận, không gửi lại.
- App không bao giờ tự gửi lại; người dùng bấm Retry hoặc Send again.

### 4.5 Tasks

- Dock bên phải theo explorer dock của Paseo bản mới:
  - các panel mở thành tab đóng được; mặc định là Changes và Files;
  - nút **+** mở tab "New tab" với danh sách Changes, Diff, Files, Agents, Tasks (không có Terminal:
    terminal thuộc tab giữa, đóng tab là kết thúc shell). Chọn
    một mục thì tab New tab thành panel đó; panel đã mở thì được đưa lên trước;
  - tab của dock giữ nguyên khi ẩn/hiện dock và qua reload (`alp-web:layout`).
- Nút **+** của hàng tab giữa là menu New tab như Paseo: Agent (tạo session), Terminal, Diff, rồi
  Tasks, Agents. Panel mở thành tab ở cột giữa, theo workspace như task tab.
- Terminal (xterm.js): mở tab là tạo terminal trong workspace (registry workspace) rồi attach;
  phím gõ gửi theo lô, đúng thứ tự, mỗi lần ≤ `maxInputBytes`; đổi kích thước gửi `terminal.resize`
  sau debounce; đóng tab gửi `terminal.close`. Reload trang hoặc mất socket thì attach lại với
  `after` = seq cuối đã thấy (id terminal giữ trong sessionStorage của tab); output mất hiện
  `[output lost: …]`; `exit` hiện "Process exited (code N / reason)" và tắt nhập; client khác
  attach thì hiện "Opened in another client" với nút Reattach. Disconnect kết thúc terminal của
  trang; reload hay đóng tab thì host giữ terminal 60 s để attach lại. Mỗi workspace một terminal.
- Changes và Diff đọc Git của workspace qua gateway, chỉ đọc (`workspace.git.status`/`diff`, #121 G1;
  nội dung diff cần thêm `files.read`); Files liệt kê và đọc file text (`workspace.files.*`, cần
  `files.read`). Không commit, push hay sửa file.
- Panel Tasks liệt kê task và có form tạo task.
- Bấm một task mở **tab chi tiết** ở cột giữa, gồm:
  - mô tả, handoff, closed;
  - assignee, progress, parent, blocked by, labels, paths;
  - nút Approve gate, Close task, Reopen.
- `task.list` poll mỗi 5 giây khi có view task đang mở (panel hoặc tab), và bỏ qua lần poll trùng
  `revision`.
- `task.create` gửi `requestId`. Host chỉ dedupe trong một process alpd.
  - Kết quả không rõ: app đọc lại list, báo task trùng tên nếu có, và chờ người dùng.
  - "Create again" dùng lại `requestId` cũ.
  - App không tự gửi lại.
- `task.update` và `task.gate.resolve` gửi `ifRev`. Khi `revision_conflict`, app báo lỗi và đọc
  lại list.

## 5. Phục hồi (theo bài học 09B-2)

- Event đến trong lúc attach được buffer. Khi `reset`, app xóa projection rồi mới áp buffer.
- Cursor tính theo từng cây. Event synthetic (không có cursor) không làm cursor tiến.
- Tạo session:
  - id do client chọn;
  - `session.create` với `history: "skip"` và `persist: true`;
  - rồi `session.attach` với `after` để lấy toàn bộ timeline.
- Root đóng (idle mà không ai xem): prompt kế tiếp chạy `session.create resume:true` và attach sau
  cursor.
- Attach đầu tiên của session mới: root chỉ được đánh dấu attached khi có response.
  - Timeout hoặc lỗi không terminal trên kết nối còn sống → hiện lỗi kèm nút Try again. Không tự
    lặp, không gửi lại `session.create`.
  - Event của root ngừng được áp dụng cho tới lần attach sau (replay từ cursor), để không tạo gap.
- Lỗi:
  - Chỉ mã terminal làm root "gone": `1001`, `1003` grant/mode/outside_workspace, `-32601`,
    `-32602`.
  - Lỗi tạm thời thì reconnect với backoff 0,5 → 15 giây.
- Link mới chỉ được dùng khi mọi attach đã xong và link vẫn sống.
- Disconnect và lỗi terminal (token bị từ chối, origin hay TLS bị cấm) dừng mọi retry.
- `session.closed` đến trong replay không làm mất session khỏi list.
- E2E `recovery.spec.js` kiểm tra:
  - gateway restart giữa turn, rồi hai lần lúc idle;
  - alpd restart;
  - reload trang;
  - mỗi prompt tới provider đúng một lần.

## 6. Runbook beta

| Triệu chứng | Kiểm tra |
|---|---|
| "allows this page's origin" | Thêm đúng origin của trang: `alp-gateway serve --origin <scheme://host:port>`. |
| "refused this access token" | Token sai, đã bị rotate hoặc revoke: `alp-gateway credential list`; cấp token mới. |
| "This link's access token is no longer valid" | Token của `alp web` đã bị `alp web rotate`: chạy `alp web` lại để mở link mới. Credential này không có trong `alp-gateway credential list` (§3.1). |
| `alp web` báo `web.lock` "is held by a process that alp cannot prove…" | Một process khác giữ lock (của user khác, lần boot khác, hoặc trên Windows). Dừng nó rồi chạy `alp web` lại. |
| `tls_required` | Truy cập từ ngoài loopback mà không có HTTPS: dùng reverse proxy TLS hoặc SSH tunnel. |
| Banner "Reconnecting…" kéo dài | Gateway hoặc alpd đang dừng. Work trên host vẫn chạy; app tự nối lại và tiếp tục sau cursor. |
| "can only drive sessions in … mode" | Credential bị giới hạn `--mode`; session chạy mode khác. Tạo session với mode được phép. |
| Task báo "It changed on the host meanwhile" | `ifRev` cũ: app đã đọc lại list; xem lại rồi thao tác lại. |
| Tin "Not confirmed" / "cannot tell whether the agent received" | Xem conversation trước. Send again an toàn khi app ghi "Sending it again is safe" (cùng id được dedupe); `outcome_unknown` thì gửi bằng id mới. Hoặc Discard. |

## 7. Kiểm thử

- Unit (`apps/web/tests`, 107 test):
  - timeline projection;
  - controller, chạy với host JSON-RPC trong bộ nhớ: reconnect, resume, terminal, idle-close,
    stale answers, outcome unknown, task ifRev, create, children/questions, cancel, mode limit,
    reset, hàng đợi (kể cả event tách task, response trước/giữa/sau event, rớt kết nối giữa
    `user_message` và `turn.started`), attach đầu tiên timeout;
  - gateway (URL, ticket, lỗi HTTP);
  - preferences, layout (đọc dung thứ, không ghi token);
  - boundary.
- E2E (`apps/web/e2e`, Playwright, 21 test):
  - Mỗi spec dựng một host thật dùng một lần:
    - alpd từ `packages/daemon/dist`;
    - fake Codex tất định; Claude và Antigravity trỏ tới chương trình không tồn tại;
    - `alp-gateway` với `--origin` của trang;
    - bundle đã build.
  - Bảo vệ fail-closed (`e2e/support/world.js`): khi dọn host, nếu có session alpd ghi lại mà
    không chạy trên fake Codex thì spec thất bại ("a real runtime may have been called"). E2E chỉ
    chạy runtime giả.
  - Mọi thứ chạy trên port ngẫu nhiên và home tạm. Spec dừng mọi process và xóa thư mục khi xong.
  - Desktop 1440×900 và Pixel 7.
  - Specs:
    - flow: tool, ask/decline, steer, interrupt, hàng đợi, rename, token không rò, tasks + gate,
      settings;
    - recovery;
    - access: token sai, chỉ đọc, giới hạn mode, workspace khác, revoke, origin không được phép;
    - local: `alp web --print` với CLI đã build, link tự kết nối, hash rỗng, token chỉ ở
      sessionStorage, reload, 4403 khi thêm project, `alp web rotate`;
    - chat, new-session, settings, tabs, workspace;
    - mobile.
- Chạy E2E: `npm ci` ở gốc repo một lần (workspace dùng chung `node_modules` gốc), rồi
  `npm run test:alp-web:e2e` ở gốc hoặc `npm run test:e2e` trong `apps/web`. Cả hai đi qua
  `pretest:e2e` của `apps/web`: build lại `packages/cli`, `packages/daemon` và bundle web trước
  Playwright, nên dist cũ (lỗi "host too old: lacks attach.after") không còn xảy ra. Gọi thẳng
  `npx playwright test` thì bỏ qua bước này.
- CI: job `alp-web` trên `ubuntu-latest` và `macos-latest`, Node 22, chạy `npm run validate:web`.
  Khi lỗi, CI upload trace và ảnh. Service alp-web và gateway cũng chạy trong job `windows-daemon` trên Windows (Node 22 và 24; xem §3.1).

## 8. Giới hạn đã biết

- `alp web`: session được ghi với projectRoot qua symlink (ví dụ `/var/…` thay vì `/private/var/…`
  trên macOS) không hiện dưới grant theo realpath của thư mục đang đứng.
- Chỉ một cây session được attach tại một thời điểm. Session khác cập nhật qua poll list mỗi 15
  giây.
- Children/delegation chỉ có unit test. Fake provider của E2E không delegate.
- E2E thường dùng fake provider. Riêng `e2e/attachment-files-real.spec.js` (opt-in, không chạy trong CI) gửi file qua trình duyệt tới Codex và Claude thật; các lần chạy thật khác của #121 là script `test/e2e/*-real-e2e.mjs` không qua trình duyệt ([issue-121-acceptance.md](issue-121-acceptance.md)).
- Library qua gateway mở nội dung đã redaction bằng `library.get` với `project.read`
  trong workspace được cấp: file Markdown hiển thị dưới dạng text, cấu hình dưới dạng JSON,
  secret hiển thị là `‹hidden on the host›`. Ghi chỉ dành cho instruction agents/skills riêng của project
  với explicit `library.write` và daemon `library.project.write` (#118); library của host,
  entry kế thừa, cấu hình thực thi và Test vẫn không sửa/chạy qua đây.
- Ngôn ngữ app chỉ có tiếng Anh. Ngôn ngữ agent chỉ đọc.
- Theme chỉ có System/Light/Dark; chưa có font, cỡ chữ, theme khác của Paseo.
- Split pane đã có (t-7679.9); xem paseo-parity.md.
- Danh sách đầy đủ phần đã làm và còn thiếu so với Paseo web: [apps/web/docs/paseo-parity.md](../../apps/web/docs/paseo-parity.md).
- `npm audit` báo 21 lỗ hổng có sẵn từ trước (chuỗi react-native/jest và ajv của workspace khác).
  Package web không thêm lỗ hổng nào. Không chạy `npm audit fix --force`.

## 9. Bằng chứng

Commit implementation `739ebc0` (nhánh `feat/alp-web`), macOS, Node 26 cục bộ:

| Lệnh | Kết quả |
|---|---|
| `npm run validate:web` | tsc sạch; unit 43/43; build web (boundary chỉ gồm SDK portable/websocket, rpc/*, protocol public/wire); Playwright 9/9 |
| `npm run validate:core` | xanh (gate cũ không đổi) |
| `node scripts/check-boundaries.mjs` | 10 workspace boundary, không có cycle |

- Mọi E2E dùng fake Codex. Chưa chạy smoke với provider thật (§8).
- Ảnh desktop và mobile: đính kèm PR.
  - chat;
  - tab task;
  - hàng đợi;
  - settings;
  - sidebar mobile, panel mobile, settings mobile.

Kiểm lại ngày 2026-10-17 (HEAD `e5e5ae9`, macOS): `cd apps/web && npm test` 107/107 pass;
`npm run test:alp-web:e2e` 21/21 pass. Vẫn chỉ fake provider.
