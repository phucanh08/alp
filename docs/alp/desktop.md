# ALP desktop (macOS, MVP)

> **Trạng thái:** t-81b0.2 phần 1 (khung), phần 2 (tự kết nối lại) và phần 3 (e2e Electron), chưa
> phát hành, chưa có DMG. Quyết định: D32 (`plans/reference/DECISIONS.md`). Đóng gói DMG là phần sau.

App desktop là một **vỏ mỏng** bằng Electron bọc quanh ALP mà người dùng đã cài. Nó không mang theo
alpd, gateway hay app web: nó chạy `alp dashboard --print` của người dùng, lệnh này khởi động hoặc gắn vào
service `alp-dashboard` ([dashboard.md](dashboard.md) §3.1), rồi mở app web trong cửa sổ riêng.

## 1. Luồng

1. Tìm `alp` (§2).
2. Chạy `alp dashboard --print` bằng `execFile`, không qua shell, với PATH đã tìm được.
3. Kiểm địa chỉ in ra: phải đúng dạng `http://127.0.0.1:<port>/#token=alpgw1.<16 hex>.<43 base64url>`,
   không có path, query hay userinfo. Sai dạng thì báo lỗi, không mở.
4. `loadURL` địa chỉ đó. App web lấy token ra khỏi địa chỉ (`history.replaceState`), giữ trong
   sessionStorage của cửa sổ, và kết nối tới chính origin của trang ([dashboard.md](dashboard.md) §4.2).

Địa chỉ chứa token chỉ nằm trong bộ nhớ: không ghi log, không ghi file, không truyền qua tham số dòng
lệnh. Cửa sổ là một client cùng origin với `alp-dashboard` như một tab trình duyệt, nên gateway và alpd
không đổi gì và không có origin tin cậy mới.

## 2. Tìm `alp`

App mở từ Finder chỉ có `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, còn `alp` cài bằng npm chạy bằng
`#!/usr/bin/env node`, nên phải tìm cả `alp` lẫn `node`. Thứ tự:

1. Cài đặt `alpPath` trong `~/Library/Application Support/ALP/settings.json`
   (`{ "alpPath": "/đường/dẫn/tuyệt/đối/alp" }`), hoặc biến môi trường `ALP_DESKTOP_ALP`. Đường dẫn này
   sai thì app báo đúng đường dẫn đó, không tự lấy một `alp` khác.
2. Các thư mục bin mà alp-client cũng tìm: `~/.alp/bin`, `~/.npm-global/bin`, `~/.local/bin`,
   `/opt/homebrew/bin`, `/usr/local/bin`.
3. Login shell của người dùng (`$SHELL -ilc`, giới hạn 5 giây): `command -v alp` và `$PATH`.
   Shell chạy trong process group riêng: hết hạn thì cả group bị SIGKILL; thoát bình thường thì
   job nền mà file rc để lại trong group bị SIGTERM (job có group riêng, khi shell bật job control,
   do shell tự hang up).

Nếu PATH dựng từ (1)–(2) không có `node`, PATH của login shell được nối thêm.

## 3. Khi không mở được

| Trường hợp | App hiển thị |
|---|---|
| Không tìm thấy `alp` | Trang cài đặt trong app: lệnh `npm install -g @anhlp/alp@beta` và cách đặt `alpPath`. |
| `alp` báo lỗi (vd. `dashboard.enabled` là false, chạy trong session của agent) | Nguyên văn thông báo lỗi của `alp`. |
| `alp dashboard --print` không trả lời trong 90 giây, hoặc in ra thứ không phải địa chỉ ALP dashboard | Thông báo lỗi tương ứng. |
| Trang không tải được | Thông báo lỗi; chọn **File › Connect again** (⇧⌘R) để thử lại. |

**File › Connect again** chạy lại toàn bộ luồng ở §1, kể cả sau `alp dashboard rotate`.

### 3.1 Tự kết nối lại

Khi trang của `alp-dashboard` đã tải xong, app theo dõi nó (`src/reconnect.ts`):

| Dấu hiệu | Nghĩa |
|---|---|
| `GET <origin>/readyz` mỗi 3 giây không có trả lời HTTP nào (từ chối kết nối, quá 2 giây) hai lần liền | `alp-dashboard` dừng, crash hoặc đổi port. |
| Trang gặp 401 ở `POST <origin>/v1/tickets` | Token bị `alp dashboard rotate` hoặc revoke. |
| Tải lại trang (View › Reload, hay lần tải do app kết nối lại) thất bại | Như trên. |

Khi đó app chạy lại `alp dashboard --print` (lệnh này khởi động `alp-dashboard` nếu nó không chạy) và tải địa chỉ
mới. `/readyz` trả 503 (alpd đang khởi động lại) **không** phải dấu hiệu: `alp-dashboard` vẫn chạy và app
web tự nối lại gateway. Nếu `alp dashboard --print` in lại đúng địa chỉ cũ sau khi `alp-dashboard` sống lại, app
không tải lại trang, vì app web tự nối lại; nếu địa chỉ cũ chính là token vừa bị từ chối, app dừng
ngay và báo lỗi.

Không có bão kết nối: mỗi lúc chỉ một lần thử, mọi dấu hiệu đến trong lúc đó bị bỏ qua. Các lần thử
cách nhau 1, 2, 4, 8, 16 rồi 30 giây; sau 8 lần, app hiện trang lỗi và chờ **File › Connect again**.
Bộ đếm chỉ về 0 khi trang đã sống ổn định 60 giây. Không tìm thấy `alp` thì hiện trang cài đặt ngay.
Trong lúc thử, cửa sổ vẫn giữ trang cũ (app web hiện trạng thái mất kết nối của nó). Connect again
hủy mọi lần thử đang chờ. `/readyz` không gửi credential; với 401, app chỉ đọc status và path của
request, không đọc header hay body, và chỉ tính 401 của trang đã commit cho địa chỉ vừa tải (401 muộn
của trang cũ đang bị thay thì bỏ qua). Một lần tải không xong cũng không lỗi trong 30 giây được tính
là thất bại. Reload trang không đặt lại bộ đếm. Sau `alp dashboard rotate` trên cùng port, địa chỉ mới chỉ
khác ở fragment (`#token=`), nên Chromium chỉ điều hướng trong trang. Vì vậy app tải lại trang để app
web đọc token mới. Còn một khe rất nhỏ: một 401 của trang cũ đã nằm sẵn trong hàng đợi đúng lúc commit
vẫn được tính, và hệ quả tối đa là thêm một lần thử.

Giới hạn: `/readyz` có trả lời HTTP bất kỳ là được coi là còn sống, nên nếu một server khác chiếm port
cũ ngay sau khi `alp-dashboard` dừng, app không nhận ra cho tới khi trang tự báo lỗi hoặc người dùng chọn
Connect again.

## 4. Bảo mật của cửa sổ

- `contextIsolation`, `sandbox`, không `nodeIntegration`, không preload, không `webview`;
  `app.enableSandbox()`.
- Chỉ điều hướng trong đúng origin của `alp-dashboard` (`will-navigate`, `will-frame-navigate`,
  `will-redirect`), ở cả frame chính lẫn subframe. Trang nội bộ (đang kết nối, lỗi, chưa cài) không
  được điều hướng đi đâu. Subframe `about:blank` và `about:srcdoc` bị từ chối như mọi đích khác (origin
  của URL là `null`): app web không có iframe, và một iframe sau này phải tải URL thật trên origin của
  `alp-dashboard`.
- `window.open` luôn bị từ chối; link `https:` được mở bằng trình duyệt mặc định, scheme khác bị bỏ.
- Mọi quyền (camera, micro, notification, vị trí…) bị từ chối, trừ `clipboard-sanitized-write` từ
  origin của `alp-dashboard` (các nút Copy của app web). Vì vậy notification của app web không hoạt động
  trong app desktop ở bản này.
- Single-instance: mở app lần hai chỉ focus cửa sổ đang có (không còn cửa sổ nào thì mở và kết nối).
- DevTools chỉ có khi chạy từ source (chưa đóng gói).

## 5. Build và chạy từ source

`apps/desktop` là project **bun** độc lập, không nằm trong `workspaces` của `package.json` gốc, có
`bun.lock` riêng và không phụ thuộc package `@anhlp/*` nào; `npm ci` và runner test gốc không chạy
nó. Test của nó (`apps/desktop/test`, `bun:test`) được miễn khỏi luật bố cục test trong
`test/integration/layout.test.js` chỉ khi script `test` của nó là `bun test test`; job CI
`desktop-macos` chạy `bun install --frozen-lockfile`, `bun test test`, typecheck và build, rồi
`npm ci`, `node scripts/build-workspace.mjs cli` và e2e (`bun run e2e`). Lệnh: xem `apps/desktop/README.md` (`bun install`, `bun test test`, `bun run build`,
`bun run start`).

Shell của agent trong môi trường này có `ELECTRON_RUN_AS_NODE=1`: phải bỏ biến này khi chạy Electron
(`bun run start` đã làm). `alp dashboard` từ chối chạy khi `ALP_AGENT_SESSION` được đặt, nên agent thử app
bằng một host dùng một lần (`ALP_HOME` tạm) và một `alp` giả in địa chỉ của host đó, không bao giờ
dùng `~/.alp` của người dùng (`ALP_DESKTOP_ALP`, `ALP_DESKTOP_USER_DATA`).

### 5.1 E2E

`apps/desktop/e2e/shell.spec.mjs` (`node --test`, tên `*.spec.mjs` như `apps/web/e2e`, nên runner
gốc và luật bố cục test không chọn nó) chạy app Electron thật bằng `_electron` của `playwright-core`
(lấy từ cài đặt gốc) và gồm hai thành phần:

- **Host dùng một lần:** `packages/cli/dist/alp-dashboard.js --service` đã build từ checkout này, chạy với
  `ALP_HOME` và `HOME` tạm, `dashboard.port` riêng và `ALP_SUPERVISE=0`, nên không có alpd. Biến session
  của agent (`ALP_AGENT_SESSION`…) bị bỏ bằng `hermeticEnv` của `scripts/test-lib.mjs`, giống runner
  test gốc; alp-dashboard không bao giờ thấy `~/.alp`.
- **`alp` giả:** một script shell in địa chỉ của host đó, báo lỗi hoặc chờ trước khi in, được chỉ tới
  qua `ALP_DESKTOP_ALP`.

Các ca kiểm tra:

- kết nối, và app web lấy token ra khỏi địa chỉ;
- trang chưa cài `alp`;
- trang lỗi của `alp`;
- mở lại cửa sổ từ Dock trong lúc đang kết nối;
- Connect again khi không còn cửa sổ;
- kết nối cũ trả về muộn một địa chỉ không tải được, sau kết nối mới (qua Dock hay Connect again):
  kết quả cũ bị bỏ, không hiện trang lỗi. Chromium hủy navigation cũ ngay khi navigation mới bắt
  đầu (`ERR_ABORTED`, bị bỏ qua), nên trường hợp cũ thật sự có thể xảy ra là kết quả `alp` đến
  muộn. `alp` giả của lần đầu chỉ trả lời khi test mở cổng, tức là sau khi kết nối mới đã xong, nên
  thứ tự này luôn đúng dù máy chậm. Hai test này fail khi bỏ điều kiện `id === generation` trong
  `connect()`;
- trang đầu tiên không tải được thì cửa sổ vẫn hiện;
- instance thứ hai khi không có cửa sổ;
- `alp-dashboard` khởi động lại trên port khác;
- `alp dashboard rotate` trên cùng port.

Teardown dùng `defer` của `test/support/teardown.js`: đóng Electron (quá 15 giây thì SIGKILL), dừng
host, rồi mới xóa thư mục. App chạy với `HOME` tạm.

```sh
npm ci && node scripts/build-workspace.mjs cli   # ở gốc repo
cd apps/desktop && bun run e2e
```

## 6. Chưa có trong bản này

DMG ký ad-hoc (arm64, x64) và Electron fuses; `alp dashboard --print --json`; dừng `alp dashboard` khi thoát app;
ký và notarize; Windows và Linux; mang alpd theo app.

## 7. `alp desktop`

`alp desktop` (t-81b0.5) mở app này, theo thứ tự:

1. `ALP.app` trong `/Applications`, rồi `~/Applications` (macOS): mở bằng `open`;
2. nếu không có: checkout do `ALP_DESKTOP_CHECKOUT` chỉ tới (gốc repo, hoặc chính `apps/desktop`), với app
   đã build (`bun install && bun run build` trong `apps/desktop`): chạy bằng Electron của checkout đó,
   bỏ `ELECTRON_RUN_AS_NODE`;
3. không có cả hai: in cách cài (đặt `ALP.app` vào `/Applications`, hoặc đặt `ALP_DESKTOP_CHECKOUT`) và
   exit 1; trong lúc chờ, `alp dashboard` mở ALP trên trình duyệt.

`alp desktop` không đọc và không truyền token: app tự chạy `alp dashboard --print` (§1). Tên biến theo
các biến `ALP_DESKTOP_*` khác (`ALP_DESKTOP_ALP`, `ALP_DESKTOP_USER_DATA`). DMG cho `/Applications` là
t-81b0.3.
