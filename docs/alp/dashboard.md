# ALP dashboard (Task 10A, beta)

> **Trạng thái (`0.0.1-beta.10`; app này có trong các bản beta sau `0.0.1-beta.3`, tên lệnh là `alp web` đến `0.0.1-beta.8`).** App `apps/web` (`@anhlp/alp-web`,
> private) không phải là package riêng: nó được build vào CLI (`@anhlp/alp`, `@anhlp/alp-cli`,
> `dist/alp-dashboard/`) và mở bằng `alp dashboard` (§3.1). `@anhlp/alp-gateway` vẫn không phát hành; CLI mang
> sẵn gateway trong `dist/alp-dashboard.js`. Cách triển khai riêng ở §3.2 cần `alp-gateway` chạy từ
> checkout. Trong `0.0.1-beta.3` đã phát hành, `alp web` vẫn là web của Paseo trong
> `@anhlp/alp-paseo`. Kết quả ở §9 là bằng chứng lịch sử của nhánh phát triển. Phạm vi:
> [beta-scope.md](beta-scope.md) §4.

App trình duyệt độc lập (`apps/web`, package `@anhlp/alp-web`, private). App nói chuyện với alpd
**chỉ qua** ALP remote gateway ([remote-gateway.md](remote-gateway.md)) và client SDK
([client-sdk.md](client-sdk.md)). Từ bản này `alp dashboard` mở app này (service `alp-dashboard`) thay cho web
của Paseo. Web của Paseo (`paseo-web/`, `server/dist/web-app` trong `@anhlp/alp-paseo`) đã bị gỡ
khỏi repo và package plugin (t-55ce.3); integration `paseo` chỉ còn bridge, relay và `alp dashboard pair`.

Luồng: `Browser → HTTPS/WSS (hoặc loopback/SSH) → alp-gateway → IPC → alpd`.

Số mục (§) có thể được code và test tham chiếu; giữ ổn định.

## 1. Phạm vi beta

| Có | Chi tiết |
|---|---|
| Kết nối | `alp dashboard` mở link có sẵn token và app tự kết nối (§3.1, §4.2). Hoặc form kết nối: HTTPS, hoặc HTTP chỉ trên loopback (`127.0.0.1`, `localhost`, SSH tunnel); token dán tay chỉ giữ trong bộ nhớ của tab. Trên trang loopback của bản build (như trang `alp dashboard` phục vụ; dev server Vite thì không), ô gateway mặc định là origin của trang (địa chỉ đã nhớ thì ưu tiên), và "Getting a token" chỉ tới `alp dashboard`, `alp dashboard --print`, `alp dashboard rotate` trước, rồi tới `alp-gateway credential create` + `serve --origin` cho gateway riêng. |
| Projects | Các workspace mà credential cấp (`principal.workspaces`), cùng registry chung của host (`workspace.registry`, protocol §16, #121): **Add project** chỉ đăng ký một thư mục đã được cấp sẵn (`workspace.write`; không duyệt thư mục của host, không cấp thêm quyền), pin chung giữa các client và giữ qua restart, worktree tạo/xóa theo mapping chủ host đã duyệt (`workspace.manage`, chỉ macOS/Linux). Web chưa có nút bỏ project (`project.remove` của protocol chỉ bỏ đăng ký, không xóa file). |
| Sessions | Liệt kê, tạo (team, permissions, model, title), mở, đổi tên, archive. Mỗi agent của cây (main và assignment) là một tab. Trên Codex và Claude (#121): fork và rewind chỉ hội thoại (§12.7, không đổi file), đổi team/model/thinking khi session đang sống (§12.9, đổi team cần thêm `session.team.write`), Reload agent và Copy resume command trong menu tab (§12.8), tải lịch sử cũ hơn (`session.history`, §8.7), đính kèm file không phải ảnh (§12.6, cần `attachments.write`). |
| Chat | Prompt + stream, tool call, todo, notice; trả lời câu hỏi theo luồng chọn rồi Submit của Paseo (Other thay lựa chọn, Enter gửi, Dismiss), thẻ câu hỏi nằm trong stream; interrupt; steer khi agent đang chạy; hàng đợi (§4.3). |
| Tasks | Liệt kê (poll), tạo, mở chi tiết trong tab lớn, đóng, mở lại, duyệt human gate. Mọi thay đổi gửi `ifRev`. |
| Settings | Bố cục như `alp dashboard` cũ: App (General, Appearance, Sidebar, Chat, Terminal, Editor, Diagnostics, About) và Host (Overview, Projects, Connections, Templates, Agents, Skills, Hooks, MCP servers, Providers…). Library xem nội dung đã redaction: file Markdown dưới dạng text, cấu hình dưới dạng JSON. Instruction agents/skills riêng của project sửa được với explicit `library.write` (#118). Mục chưa hỗ trợ ghi rõ "not available in this beta". Voice, Pair device, Plugins và Metadata không còn trong Settings (§4.6). Việc đổi host chỉ mở cho host owner (§4.6). |
| Workspace | Phím tắt như Paseo (dialog Shortcuts), History với session đã archive và Unarchive, attention trên mọi session (`question.list`), menu chuột phải của tab, kéo đổi thứ tự tab, tab giữ qua reload, sidebar và dock kéo đổi độ rộng, command center (⌘K), trạng thái trên favicon và title, notification của trình duyệt khi session chờ trả lời. |
| New session | Màn hình như tab new agent của Paseo: tin đầu tiên, chọn team/model/thinking/permissions, `session.preview`, nhớ lựa chọn lần trước (§4.2). |
| Phục hồi | Reconnect có backoff, resume theo cursor, reload trang, gateway hoặc alpd khởi động lại (§5). |

Không có trong beta (app ghi rõ, không fallback sang Paseo hay app nhúng): duyệt hoặc tạo thư mục trên
host, ghi git (commit, push, pull, đổi nhánh) và sửa file, sửa library của host hoặc cấu hình thực thi, thêm/kiểm tra provider,
usage, đổi ngôn ngữ agent (các mục này sẽ mở dần cho host owner, §4.6). Plugin và pair device không
còn là trang Settings (§4.6).

Terminal (#121 H, §12.10): tab Terminal chạy shell thật trên máy chạy alpd, **bằng tài khoản chạy
alpd; workspace không phải sandbox** (shell đọc/ghi được mọi thứ tài khoản đó đọc/ghi được và dùng
được mạng); panel ghi rõ điều này lần đầu mở trong phiên trang và luôn có một dòng header. Chỉ có khi
chủ host đã chạy `alp terminal allow --yes` và token có `terminal.exec` (không bao giờ là mặc định);
thiếu thì panel ghi lý do và không mở terminal.

## 2. Cài đặt, chạy, build

```sh
npm ci                       # ở gốc repo
npm run dev:alp-dashboard          # Vite dev server: http://127.0.0.1:7435
npm run build:alp-dashboard        # bundle tĩnh ở apps/web/dist
npm run typecheck:alp-dashboard
npm run test:alp-dashboard         # unit test (node:test)
npm run test:alp-web:e2e     # build cli, daemon, web rồi chạy Playwright
npm run validate:web         # cả lane CI: tsc, unit, boundary, build, E2E
```

- Port mặc định: Vite dev server **7435**, `alp-gateway` riêng **7434**, `alp dashboard` (alp-dashboard: app và
  gateway trên một listener) **7433**. Test dùng port ngẫu nhiên.
- E2E cần Chromium của Playwright: `npx playwright install chromium` (Linux:
  `--with-deps`).
- Thử bằng tay với host dùng một lần (alpd + fake Codex + gateway trong thư mục tạm):
  `node apps/web/e2e/support/serve.js`. Script in URL và token. Ctrl-C dừng mọi thứ và xóa thư mục
  tạm. Không đụng `~/.alp` và không đụng alpd thật.

## 3. Triển khai

### 3.1 `alp dashboard` trên máy này (alp-dashboard)

Trước t-81b0.5 (đến `0.0.1-beta.8`) lệnh này là `alp web`; `alp web` đã bị xoá, không có alias.

```sh
alp dashboard                 # chạy service alp-dashboard nếu chưa chạy, rồi mở link có token trong trình duyệt
alp dashboard --no-open       # như trên nhưng không mở trình duyệt, chỉ in link
alp dashboard --print         # chỉ in link (app desktop dùng lệnh này)
alp dashboard --port 7500     # lần chạy này dùng port 7500 (không đổi dashboard.port)
alp dashboard --host localhost   # in link với localhost; chỉ nhận 127.0.0.1 hoặc localhost
alp dashboard --status        # service có chạy không: pid, link KHÔNG kèm token, port; luôn exit 0, không đổi gì
alp dashboard --stop          # dừng service của ALP home này; không chạy thì báo và exit 0
alp dashboard rotate          # thay token; trang đang mở mất quyền
alp dashboard pair [--on|--off]   # link pair app Paseo qua relay
alp desktop                   # mở app desktop (docs/alp/desktop.md)
```

- `--status`/`--stop` theo Hermes (`hermes dashboard --status/--stop`, NousResearch/hermes-agent
  `hermes_cli/main.py` `_dashboard_lifecycle_flags`, `hermes_cli/main_dashboard.py`
  `_report_dashboard_status`): cờ vòng đời thắng cờ khởi động; `--status` in `No alp dashboard running.`
  hoặc `1 alp dashboard process running:` rồi `    PID <pid> [dashboard]: <url> (port <port>)`, luôn exit 0;
  `--stop` chỉ dừng service của ALP home này, in `Stopped alp dashboard (pid <pid>).` hoặc
  `No alp dashboard running for this ALP home.`, và exit 1 khi lock bị giữ bởi process alp không chứng minh
  được là service.
- `--port N` (1024–65535): nếu service đang chạy ở port khác thì lệnh từ chối và bảo dùng `--stop` hoặc
  bỏ `--port` (như Hermes); nếu port đó bận thì báo lỗi kèm port mà service đang chạy (service vẫn chạy ở đó).
- `--host`: alp-dashboard **chỉ** nghe trên `127.0.0.1`. Token là khoá duy nhất và gateway chỉ nhận
  Host/Origin loopback, nên `--host` chỉ nhận `127.0.0.1` hoặc `localhost`; mọi giá trị khác (ví dụ
  `0.0.0.0`) bị từ chối. Hermes cũng từ chối bind ngoài loopback khi không có auth provider, mà ALP không
  có. Muốn dùng từ máy khác: SSH tunnel tới `127.0.0.1`.
- Service: `alp dashboard` chạy `dist/alp-dashboard.js` của CLI (source `packages/cli/src/dashboard/`). Một
  listener trên `127.0.0.1` tại `--port`, nếu không thì `dashboard.port` (mặc định **7433**; port bận thì thử
  chín port kế tiếp) phục vụ file của app (`dist/alp-dashboard/`) và gateway nhúng trên cùng origin.
  Service giữ `integrations/dashboard.lock`, ghi `<home>/dashboard.json` (`version: 2`,
  `app: "alp-dashboard"`, pid, port, URL, token) và log ở `<home>/logs/integrations/alp-dashboard.log`.
  Service giữ alpd chạy (`ALP_SUPERVISE=0` thì không), trừ sau `alp daemon stop`.
- **Nâng cấp từ `alp web` (`0.0.1-beta.8` trở về trước).** `alp dashboard` (khởi động), `alp dashboard rotate` và
  `alp dashboard --stop` tự chuyển trước khi đọc hay chạy gì, giữ token, port và trạng thái bật/tắt
  (`pair` dùng integration Paseo và không cần chuyển):
  1. `alp web` cũ còn chạy dưới `integrations/web.lock` (hoặc integration Paseo trước khi đổi tên) được
     dừng bằng SIGTERM với cùng các bằng chứng như `--stop`; nếu không chứng minh được process giữ lock
     thì không dừng, không chuyển gì, và lệnh khởi động báo lỗi;
  2. `<home>/web/` (kho credential) → `<home>/dashboard/`;
  3. `<home>/web.json` có `app: "alp-web"` → `<home>/dashboard.json` (giữ token và credential id);
     `web.json` không có `app` là danh tính của integration Paseo cũ và vẫn được chép sang `paseo.json`;
  4. `logs/integrations/alp-web.log` → `alp-dashboard.log`;
  5. `settings.json`: `web.enabled`, `web.port`, `web.permissions` chuyển sang `dashboard.*`;
     `web.relay` (của Paseo) ở lại `web`.
  `--status` không chuyển gì: nó chỉ liệt kê `alp web` cũ còn chạy và những gì lần chạy kế tiếp sẽ chuyển.
  `--stop` chuyển như các lệnh khác và exit 1 nếu `alp web` cũ còn giữ lock mà alp không chứng minh được.
  Windows: alp không dừng `alp web` cũ đang chạy; dừng process có pid trong `<home>/web.json`
  (`taskkill /F /PID <pid>`) rồi chạy `alp dashboard`.
  Mỗi bước chỉ chuyển tên cũ sang tên mới còn trống: chạy lần hai không làm gì; khi có cả hai thì tên mới
  thắng, tên cũ giữ nguyên (không gộp, không xoá) và `--status` liệt kê chúng. Settings được **chuyển tại
  chỗ** để file của người dùng chỉ còn một nơi đúng; nếu không ghi được (file sai, chỉ đọc) thì
  `dashboard.*` vẫn được đọc trước rồi tới `web.*`, nên setting cũ không bao giờ bị bỏ qua lặng lẽ.
  Biến môi trường `ALP_WEB_APP` và `ALP_WEB_GRANT_REFRESH_MS` (cho test) vẫn được đọc khi
  `ALP_DASHBOARD_APP`/`ALP_DASHBOARD_GRANT_REFRESH_MS` không đặt; tên mới thắng.
- **Không đổi tên, và vì sao:** `apps/web` và package `@anhlp/alp-web` (mã nguồn của app trình duyệt,
  không phải service); RPC `web.pairing` (extension của integration Paseo, đổi là đổi giao thức);
  kênh gate `'web'` (được ghi vào log task đã lưu); `state/web-workspaces.json` (registry của alpd và đơn
  vị backup/restore); `web.relay` trong settings (của Paseo); job CI `alp-web` (test app trình duyệt).
- Link: `http://127.0.0.1:<port>/#token=alpgw1.…`. Token là credential gateway thật, lưu trong
  `<home>/dashboard/credentials.json` (thư mục 0700, file 0600 của user; sai quyền thì service không
  chạy). Đây là kho riêng của alp-dashboard: `alp-gateway credential list/create/revoke` (đọc
  `<home>/gateway`) không thấy credential này. Lần chạy sau dùng lại token trong `dashboard.json` khi nó
  còn hợp lệ.
- `alp dashboard rotate`: dừng alp-dashboard, tạo credential mới, revoke mọi credential khác trong kho đó (token
  cũ hết hiệu lực, trang đang mở nhận 401 và báo chạy `alp dashboard` lại), rồi chạy lại service và in link
  mới. Với `"dashboard": { "enabled": false }`, rotate vẫn thay token nhưng không chạy lại service.
- Quyền mặc định: `DEFAULT_PERMISSIONS` của gateway cộng `workspace.write`, tức `session.read`,
  `session.write`, `project.read`, `project.write`, `workspace.write`. Các quyền khác (ví dụ
  `files.read`, `attachments.write`, `session.team.write`, `terminal.exec`) chỉ có khi thêm vào
  setting `dashboard.permissions` (mảng). Chỉ cần một mục không phải quyền của credential là alp-dashboard bỏ
  qua **cả danh sách** và ghi warning; grant giữ mặc định. Còn một mục sai dạng (không phải chuỗi
  chữ thường và dấu chấm, ví dụ `"files-read"`) làm cả `settings.json` không hợp lệ: cả alpd lẫn
  alp-dashboard đều bỏ qua toàn bộ file (với alp-dashboard là kể cả `dashboard.port`; với alpd là mọi setting của nó)
  và ghi `ALP_SETTINGS_INVALID` vào log. Có `terminal.exec` thì log
  ghi cảnh báo của gateway.
- Workspace được cấp: registry project của alpd (project chưa bị bỏ) ∪ thư mục mà `alp dashboard` đang
  đứng khi khởi động service (hoặc khi `alp dashboard rotate`), nếu thư mục đó có `.alp/` (là project
  ALP). Đường dẫn được so theo realpath. alp-dashboard theo dõi registry khoảng mỗi 5 giây; grant đổi
  thì credential được cập nhật (giữ token) và gateway đóng các kết nối với 4403, app tự nối lại.
- `dashboard.enabled=false` chỉ tắt alp-dashboard (`alp dashboard`); integration Paseo và `alp dashboard pair`
  vẫn chạy. Relay của Paseo vẫn tuân theo `web.relay.enabled` (và `alp dashboard pair --off`).
- Setting: `dashboard.port`, `dashboard.permissions`, `dashboard.enabled` chỉ được đọc khi service khởi động.
  `alp daemon stop` không dừng alp-dashboard. Muốn áp dụng thay đổi: `alp dashboard --stop` (Windows: dừng
  process có pid trong `<home>/dashboard.json` bằng `taskkill /F /PID <pid>`), rồi chạy `alp dashboard`; token
  được giữ.
  `alp dashboard rotate` cũng khởi động lại service, nhưng với token mới.
- Nâng cấp từ `alp web` dựa trên Paseo (trước `0.0.1-beta.4`): nếu integration Paseo cũ vẫn giữ
  `integrations/web.lock` (`web.json` không có `app`), `alp dashboard` gửi SIGTERM cho nó, chỉ khi chứng
  minh được đó là process của chính user, cùng lần boot, và pid không bị dùng lại (macOS/Linux; Windows
  không dừng nó). alp-dashboard chép token và server id của integration cũ từ `web.json` sang
  `<home>/paseo.json` một lần, chỉ khi `paseo.json` chưa có, để thiết bị đã pair vẫn dùng được.
- **Windows:** macOS vẫn là nền tảng chính; trình duyệt E2E chạy trên Linux và macOS. Service
  alp-dashboard và gateway được kiểm thử trong CI Windows (`windows-daemon` trên Node 22 và 24). Thao tác
  ghi đè `credentials.json` và `dashboard.json` có cơ chế retry/backoff để xử lý lỗi `EPERM`/`EBUSY` khi
  file đang được đọc. Trên Windows, alp không tự dừng alp-dashboard hay integration Paseo cũ đang chạy:
  `alp dashboard rotate` và bước takeover khi nâng cấp từ chối khi chúng còn chạy. Dừng process có pid
  trong `<home>/dashboard.json` (`taskkill /F /PID <pid>`), rồi chạy lại lệnh. Cách dừng này không phải shutdown
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
phân biệt được trang của `alp dashboard` với bản tự phục vụ, nên ô gateway lúc đầu là origin của trang
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
- Link của `alp dashboard` (`http://127.0.0.1:<port>/#token=alpgw1.…`, `src/lib/link-token.js`):
  - Khi trang load, `main.tsx` đọc `#token=` và kiểm tra dạng `alpgw1.<16 hex>.<43 base64url>`.
  - Fragment bị xóa ngay bằng `history.replaceState`, trước khi render, kể cả khi token hỏng.
  - Token hợp lệ được giữ trong sessionStorage của tab (key `alp-web:link-token`). Reload tab đó
    kết nối lại; tab khác và lần mở sau không thấy token.
  - App kết nối tới `location.origin` (alp-dashboard vừa serve trang), chỉ khi trang ở loopback
    (`127.0.0.1`, `localhost`). Ngoài loopback, app không giữ và không dùng token của link.
  - Lần kết nối đầu không có form: app chờ alp-dashboard lên (retry với backoff) và có nút
    "Use another access token".
  - Gateway từ chối token (401, sau `alp dashboard rotate` hay revoke): app xóa token khỏi
    sessionStorage và hiện form với thông báo "This link's access token is no longer valid. Run
    `alp dashboard` again…". Lỗi terminal khác (origin, TLS) giữ token cho lần reload sau.
  - Gateway đóng socket với 4403 (grant đổi, ví dụ alp-dashboard thêm project mới): app tự nối lại với
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

### 4.6 Host owner và Settings (t-a95b)

Gateway trong `alp-dashboard` được tạo với option `owner` ([remote-gateway.md](remote-gateway.md) §5.19):
credential của chính dashboard, trên kết nối tới thẳng từ loopback (`127.0.0.1`, `::1`), là **host
owner** và được gọi các method `owner` của matrix, do alpd hoặc handler trong
`packages/cli/src/dashboard/owner/` (`host.js`, `library.js`) trả lời. Owner được đọc lại mỗi request từ
`grant.id`, nên sau `alp dashboard rotate` token cũ không còn là owner. Credential của `alp-gateway`
riêng, thiết bị Paseo qua relay, proxy hay tunnel (có header chuyển tiếp) không bao giờ là owner và nhận
đúng lỗi như trước (`-32601 not_exposed`). App biết mình là owner qua capability `host.owner` trong
hello (`state.owner`, `useOwner()`), và gửi việc của owner bằng `controller.ownerRequest`.

Giới hạn đã biết: một ALP agent chạy bằng cùng tài khoản mà đọc được `<ALP_HOME>/dashboard.json` thì có
token và là host owner (nó chỉ không được tự khai là agent). Việc này không thêm quyền so với trước:
token đó vốn đã tạo được session `full-access`. Bộ chuyển TCP trơn trên cùng máy (`ssh -R`, `socat`)
không thêm header nên cũng không phân biệt được với client trực tiếp; nó vẫn cần token. Chi tiết ở
remote-gateway.md §5.19.

Settings bỏ bốn trang của Paseo, không còn mục nào trong nav:

- **Voice**: ALP không có speech provider nào để cài trên host; agent của ALP nhận text.
- **Pair device**: ghép app Paseo trên thiết bị khác là việc trên host, bằng `alp dashboard pair`
  (§3.1); app này không phải nơi làm việc đó.
- **Plugins**: cài plugin thay đổi host, và ALP không có đường cài plugin từ app.
- **Metadata**: ALP không có tính năng sinh tiêu đề session hay tên nhánh, nên không có gì để cài.

Các trang host (Usage, Providers, Terminals, Workspaces, Projects) nằm trong
`apps/web/src/app/settings/HostPages.tsx`, các trang library (Templates, Agents, Skills, Hooks, MCP
servers, Editor) trong `settings/LibraryPages.tsx`. Việc host owner làm được trên các trang đó ở §4.7 và §4.8.

### 4.7 Settings: host pages

Năm trang host làm việc thật khi kết nối là **host owner** (§4.6: link của `alp dashboard` trên máy
này, `useOwner()`); mọi kết nối khác (credential của `alp-gateway`, thiết bị Paseo, proxy) thấy các
trang như trước, kèm bảng "not available in this beta" không đổi. Mỗi việc đi qua
`controller.ownerRequest` (`apps/web/src/lib/owner-host.js`) tới một method owner của gateway; method
`host.*` do `packages/cli/src/dashboard/owner/host.js` trả lời, dùng lại đúng code của CLI hoặc RPC của
alpd, không chép lại:

| Trang | Owner làm được | Method | Dùng lại |
| --- | --- | --- | --- |
| Usage | xem hạn mức của từng provider (gói, cửa sổ, % đã dùng, giờ reset, việc đang park), **Refresh** hỏi lại provider trên host | `daemon.usage { refresh }` (alpd) | cách trình bày của màn Usage trong plugin Paseo (`integrations/paseo/client/usage.tsx`) |
| Providers | **thêm** provider (id, command, args, env, label, description, models): trước khi lưu, bước xác nhận hiện đúng lệnh và args sẽ chạy và **tên** biến env, giá trị luôn là `‹hidden on the host›`; chỉ tạo mới, không ghi đè provider đã có. **Test** một provider (host chạy nó và hỏi `initialize`). **Diagnose**: các check về runtime và provider của `alp doctor` (codex, claude, antigravity cài và đăng nhập chưa, command của từng provider có không), chỉ đọc, không `--fix`, mất vài giây | `host.provider.add`, `host.provider.test`, `host.provider.diagnose` | `alp provider add` (`edited` + `saveEntry`, scope library, `revision: null`), `alp provider test` (`testEntry`), `alp doctor` (`diagnose`, lọc các check trên) |
| Terminals | trạng thái công tắc terminal từ xa của host; **Allow…** hiện nguyên văn cảnh báo của `alp terminal allow` (`TERMINAL_WARNING`) và chỉ bật khi bấm xác nhận (handler từ chối `allow` thiếu `confirm: true`); **Turn off** tắt | `host.terminal.status`, `host.terminal.set { allow, confirm }` | `terminalCommand` của `alp terminal status/allow --yes/deny` (cùng file `$ALP_HOME/terminal.json`, 0600) |
| Workspaces | mọi workspace của các project còn sống, kể cả đã archive (**Show archived**): **Archive/Unarchive**, gắn và bỏ **label** (tên, màu), đổi màu và xoá label trong danh mục | `host.registry`, `host.workspace.update { archived }`, `host.workspace.label` | `registry.owner` (không operation: đọc; `label.assign/update/delete`), `workspace.update` của alpd, không có roots của credential |
| Projects | **đăng ký** bất kỳ thư mục nào có thật (đường dẫn tuyệt đối, đã chuẩn hoá, là thư mục: kiểm trên host trước khi tới alpd), **gỡ** một project (workspace của nó bị archive, file không đổi) | `host.project.register`, `host.project.remove` | `project.register`/`project.remove` của alpd; grant của dashboard theo registry (`grant.js`, watcher trên `state/`) nên trang nhận project mới ngay |

Trang Terminals còn hiện dòng **Paired Paseo app devices** khi công tắc bật: quyền mở terminal của thiết
bị Paseo đã ghép (`alp terminal allow --paseo`) là của host, Allow ở đây giữ nguyên nó như
`alp terminal allow --yes` và không bao giờ tự bật. Các trang owner đọc lại dữ liệu mỗi khi kết nối của
owner mở lại (đổi grant, khởi động lại); thông báo "may still have run" sau khi rớt kết nối được xoá khi
danh sách đã đọc lại.

Không có: **placement** (session thuộc workspace nào). alpd chỉ cho `placement.assign` một session chưa
có workspace và từ chối chuyển nó sang workspace khác (`packages/daemon/src/registry.ts`,
`placement.assign`: "Session already has another workspace"), nên không có thao tác "chuyển" nào để
đưa lên; `placement.*` không bao giờ được gửi. Pin và đổi tên vẫn là việc của mọi credential có
`workspace.write`, như trước. `requestId` của owner được gắn tiền tố `dashboard-owner:` để không trùng
receipt của credential khác trong registry.

Kiểm thử: `apps/gateway/tests/owner-host.test.js` (gateway không owner, credential khác, kết nối có
header chuyển tiếp: `-32601 not_exposed`, handler và alpd không nhận gì; owner tới đúng handler với đúng
params), `packages/cli/tests/dashboard-owner-host.test.js` (từng handler, giá trị sai bị từ chối trước khi
chạy gì), `apps/web/e2e/settings-host.spec.js` (owner qua link `alp dashboard` làm việc chính của từng
trang và host thấy kết quả; credential của `alp-gateway` riêng vẫn thấy bảng "not available").

### 4.8 Settings: library and app pages (t-a95b nhóm C)

Chỉ host owner (§4.6, `state.owner`) mới thay đổi được; mọi credential khác (gateway riêng, relay) thấy
các trang y như trước, kể cả thông báo Unavailable. Các method owner nằm trong khối
`// --- owner: library (group C) ---` của `apps/gateway/src/policy.js` (`handler: true`, chỉ các
`params` liệt kê tới handler) và handler ở `packages/cli/src/dashboard/owner/library.js`; phía app là
`apps/web/src/lib/owner-library.js`.

- **Hooks, MCP servers** (`host.library.get/save/delete/test`): owner tạo, sửa, xoá và thử entry ở
  library của host (`scope: library`, như `alp hook add/edit`, `alp mcp add/edit`) hoặc của project
  đang mở (`scope: project`). Hook và MCP là form; trước khi ghi có bước **Review** cho thấy cái host sẽ
  chạy: command và args, tên env/header (giá trị không bao giờ hiện), cwd hoặc URL, event và blocking
  của hook. Đọc qua `library.get` của alpd: giá trị env/header về là marker `{ $secret: 'keep' }`, app
  hiện `‹hidden on the host›` và nút Replace. Lưu mà không Replace thì app gửi lại marker và alpd
  (`unredact`) giữ đúng giá trị đã lưu; handler từ chối mọi chuỗi chứa text mask (`secret_marker`), nên
  mask không bao giờ được ghi. Test (nút *Test saved entry*) chạy `testEntry` của core như
  `alp mcp test`/`alp hook test`, trong tiến trình dashboard, output cắt ở 16 KiB.
- **Templates, Agents, Skills**: owner sửa cả entry của library host (không chỉ agent/skill của
  project), dạng JSON của content; mở một entry built-in ở scope library rồi lưu là tạo bản của host.
  Providers không nằm ở đây (Settings › Providers, nhóm B). Credential không phải owner giữ nguyên luật
  `library.write` cũ (chỉ agent/skill của project).
- **Files panel và Editor** (`host.files.list/read/write`): credential của dashboard **không** có
  `files.read` và không được nới; owner đọc qua `host.files.list/read` (alpd `workspace.files.list/read`
  trên kết nối của owner, sau khi handler kiểm projectRoot là workspace trong registry của alpd và
  path tương đối, không `.`/`..`, không bị chặn). Mở file, bấm **Edit**, rồi **Save** (⌘/Ctrl+S).
  `host.files.write` nằm ở handler của dashboard, không phải RPC mới của alpd: không đổi protocol, handler
  chạy bằng đúng user đó, alpd vẫn là nguồn danh tính workspace (`workspace.list`). Nó từ chối: path tuyệt
  đối, có `..`, thư mục trên đường đi là link (realpath phải trùng path), file là symlink hay hard link,
  `.git`/`.alp`/`.env`/khoá (`blockedFilePath`), file chưa có (chỉ sửa), nội dung quá 1 MiB, workspace
  không có trong registry. Điều kiện: `baseSha256` là sha256 của text đã đọc; khác thì `1004
  revision_conflict` và không ghi gì, app giữ bản nháp. Ghi atomic: file tạm cạnh file (giữ quyền
  `0o777` của file, không setuid/setgid), kiểm lại realpath thư mục cha, inode và sha256, rồi rename; lỗi
  ở bất kỳ bước nào thì xoá file tạm qua đường dẫn cũ. Ngoại lệ: nếu một process khác đã đổi thư mục
  cha thành link (bị từ chối `linked`), file tạm có thể còn lại trong thư mục đã bị dời đi; không gì được
  ghi ra ngoài workspace. Cửa sổ còn lại: khoảng ngắn giữa lần kiểm cuối và `rename()` (một lstat, đọc lại file tới 1 MiB và tính sha256),
  trong đó một process khác **của cùng user** có thể đổi thư mục thành link hay sửa file (sửa đó bị ghi
  đè). Khoá file thì không có trên mọi nền tảng; rủi ro cần code của chính user đang chạy sẵn.
- **General › Agents' language**: setting ngôn ngữ thật của ALP là ngôn ngữ agent và ALP viết cho
  người dùng (`alp language`, `settings.language.get/set`); app vẫn là tiếng Anh, không có i18n. Owner
  đặt bất kỳ tên nào tối đa 40 ký tự hoặc Reset về mặc định (Vietnamese); `settings.language.set` từ
  `denied` thành `owner`, alpd trả lời. Người khác thấy giá trị, chỉ đọc. Host › Overview vẫn hiện, chỉ
  đọc, và chỉ về General: một control duy nhất.
- **Host › Overview › Refresh** (models): `catalog.refresh` từ `denied` thành `owner` (alpd hỏi lại từng
  provider, rồi app đọc lại `catalog.get`); lỗi hiện ngay dưới tiêu đề. Người khác không thấy nút này.
- **Chat**: bỏ dòng "Always expand reasoning": runtime không bao giờ phát reasoning (item `reasoning`
  của Codex bị bỏ trong `nativeItem`, `packages/runtime/src/runtime.ts`), và
  `git grep -nE "agent_thought|reasoning|thinking_delta" -- apps/web/src packages/protocol/src apps/gateway/src`
  chỉ còn chính dòng đó.
- **Files** (trang App): ALP không có plugin file panel; trang nói token này đọc được file không và sửa
  được không.

Kiểm chứng: `apps/gateway/tests/owner-library.test.js` (không owner và credential khác → `-32601
not_exposed`, không handler nào chạy, alpd không nhận gì; owner nhận kết quả với đúng params),
`packages/cli/tests/dashboard-owner-library.test.js` (từng lần từ chối, conflict, mask, marker),
`apps/web/e2e/settings-library.spec.js` (qua `alp dashboard` thật: `e2e/support/dashboard.js`).

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
| "This link's access token is no longer valid" | Token của `alp dashboard` đã bị `alp dashboard rotate`: chạy `alp dashboard` lại để mở link mới. Credential này không có trong `alp-gateway credential list` (§3.1). |
| `alp dashboard` báo `dashboard.lock` (hoặc `web.lock` khi nâng cấp) "is held by a process that alp cannot prove…" | Một process khác giữ lock (của user khác, lần boot khác, hoặc trên Windows). Dừng nó rồi chạy `alp dashboard` lại. |
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
    - local: `alp dashboard --print` với CLI đã build, link tự kết nối, hash rỗng, token chỉ ở
      sessionStorage, reload, 4403 khi thêm project, `alp dashboard rotate`;
    - chat, new-session, settings, tabs, workspace;
    - mobile.
- Chạy E2E: `npm ci` ở gốc repo một lần (workspace dùng chung `node_modules` gốc), rồi
  `npm run test:alp-web:e2e` ở gốc hoặc `npm run test:e2e` trong `apps/web`. Cả hai đi qua
  `pretest:e2e` của `apps/web`: build lại `packages/cli`, `packages/daemon` và bundle web trước
  Playwright, nên dist cũ (lỗi "host too old: lacks attach.after") không còn xảy ra. Gọi thẳng
  `npx playwright test` thì bỏ qua bước này.
- CI: job `alp-dashboard` trên `ubuntu-latest` và `macos-latest`, Node 22, chạy `npm run validate:web`.
  Khi lỗi, CI upload trace và ảnh. Service alp-dashboard và gateway cũng chạy trong job `windows-daemon` trên Windows (Node 22 và 24; xem §3.1).

## 8. Giới hạn đã biết

- `alp dashboard`: session được ghi với projectRoot qua symlink (ví dụ `/var/…` thay vì `/private/var/…`
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
