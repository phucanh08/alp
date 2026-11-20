# ALP desktop (macOS, MVP)

> **Trạng thái:** t-81b0.2 phần 1 (khung) và phần 2 (tự kết nối lại), chưa phát hành, chưa có DMG.
> Quyết định: D32 (`plans/reference/DECISIONS.md`). E2E và đóng gói DMG là các phần sau.

App desktop là một **vỏ mỏng** bằng Electron bọc quanh ALP mà người dùng đã cài. Nó không mang theo
alpd, gateway hay app web: nó chạy `alp web --print` của người dùng, lệnh này khởi động hoặc gắn vào
service `alp-web` ([web.md](web.md) §3.1), rồi mở app web trong cửa sổ riêng.

## 1. Luồng

1. Tìm `alp` (§2).
2. Chạy `alp web --print` bằng `execFile`, không qua shell, với PATH đã tìm được.
3. Kiểm địa chỉ in ra: phải đúng dạng `http://127.0.0.1:<port>/#token=alpgw1.<16 hex>.<43 base64url>`,
   không có path, query hay userinfo. Sai dạng thì báo lỗi, không mở.
4. `loadURL` địa chỉ đó. App web lấy token ra khỏi địa chỉ (`history.replaceState`), giữ trong
   sessionStorage của cửa sổ, và kết nối tới chính origin của trang ([web.md](web.md) §4.2).

Địa chỉ chứa token chỉ nằm trong bộ nhớ: không ghi log, không ghi file, không truyền qua tham số dòng
lệnh. Cửa sổ là một client cùng origin với `alp-web` như một tab trình duyệt, nên gateway và alpd
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
| `alp` báo lỗi (vd. `web.enabled` là false, chạy trong session của agent) | Nguyên văn thông báo lỗi của `alp`. |
| `alp web --print` không trả lời trong 90 giây, hoặc in ra thứ không phải địa chỉ ALP web | Thông báo lỗi tương ứng. |
| Trang không tải được | Thông báo lỗi; chọn **File › Connect again** (⇧⌘R) để thử lại. |

**File › Connect again** chạy lại toàn bộ luồng ở §1, kể cả sau `alp web rotate`.

### 3.1 Tự kết nối lại

Khi trang của `alp-web` đã tải xong, app theo dõi nó (`src/reconnect.ts`):

| Dấu hiệu | Nghĩa |
|---|---|
| `GET <origin>/readyz` mỗi 3 giây không có trả lời HTTP nào (từ chối kết nối, quá 2 giây) hai lần liền | `alp-web` dừng, crash hoặc đổi port. |
| Trang gặp 401 ở `POST <origin>/v1/tickets` | Token bị `alp web rotate` hoặc revoke. |
| Tải lại trang (View › Reload, hay lần tải do app kết nối lại) thất bại | Như trên. |

Khi đó app chạy lại `alp web --print` (lệnh này khởi động `alp-web` nếu nó không chạy) và tải địa chỉ
mới. `/readyz` trả 503 (alpd đang khởi động lại) **không** phải dấu hiệu: `alp-web` vẫn chạy và app
web tự nối lại gateway. Nếu `alp web --print` in lại đúng địa chỉ cũ sau khi `alp-web` sống lại, app
không tải lại trang, vì app web tự nối lại; nếu địa chỉ cũ chính là token vừa bị từ chối, app dừng
ngay và báo lỗi.

Không có bão kết nối: mỗi lúc chỉ một lần thử, mọi dấu hiệu đến trong lúc đó bị bỏ qua. Các lần thử
cách nhau 1, 2, 4, 8, 16 rồi 30 giây; sau 8 lần, app hiện trang lỗi và chờ **File › Connect again**.
Bộ đếm chỉ về 0 khi trang đã sống ổn định 60 giây. Không tìm thấy `alp` thì hiện trang cài đặt ngay.
Trong lúc thử, cửa sổ vẫn giữ trang cũ (app web hiện trạng thái mất kết nối của nó). Connect again
hủy mọi lần thử đang chờ. `/readyz` không gửi credential; với 401, app chỉ đọc status và path của
request, không đọc header hay body, và chỉ tính 401 của trang đã commit cho địa chỉ vừa tải (401 muộn
của trang cũ đang bị thay thì bỏ qua). Một lần tải không xong cũng không lỗi trong 30 giây được tính
là thất bại. Reload trang không đặt lại bộ đếm.

Giới hạn: `/readyz` có trả lời HTTP bất kỳ là được coi là còn sống, nên nếu một server khác chiếm port
cũ ngay sau khi `alp-web` dừng, app không nhận ra cho tới khi trang tự báo lỗi hoặc người dùng chọn
Connect again.

## 4. Bảo mật của cửa sổ

- `contextIsolation`, `sandbox`, không `nodeIntegration`, không preload, không `webview`;
  `app.enableSandbox()`.
- Chỉ điều hướng trong đúng origin của `alp-web` (`will-navigate`, `will-frame-navigate`,
  `will-redirect`), ở cả frame chính lẫn subframe. Trang nội bộ (đang kết nối, lỗi, chưa cài) không
  được điều hướng đi đâu. Subframe `about:blank` và `about:srcdoc` bị từ chối như mọi đích khác (origin
  của URL là `null`): app web không có iframe, và một iframe sau này phải tải URL thật trên origin của
  `alp-web`.
- `window.open` luôn bị từ chối; link `https:` được mở bằng trình duyệt mặc định, scheme khác bị bỏ.
- Mọi quyền (camera, micro, notification, vị trí…) bị từ chối, trừ `clipboard-sanitized-write` từ
  origin của `alp-web` (các nút Copy của app web). Vì vậy notification của app web không hoạt động
  trong app desktop ở bản này.
- Single-instance: mở app lần hai chỉ focus cửa sổ đang có (không còn cửa sổ nào thì mở và kết nối).
- DevTools chỉ có khi chạy từ source (chưa đóng gói).

## 5. Build và chạy từ source

`apps/desktop` là project **bun** độc lập, không nằm trong `workspaces` của `package.json` gốc, có
`bun.lock` riêng và không phụ thuộc package `@anhlp/*` nào; `npm ci` và runner test gốc không chạy
nó. Test của nó (`apps/desktop/test`, `bun:test`) được miễn khỏi luật bố cục test trong
`test/integration/layout.test.js` chỉ khi script `test` của nó là `bun test test`; job CI
`desktop-macos` chạy `bun install --frozen-lockfile`, `bun test test`, typecheck và build. Lệnh: xem `apps/desktop/README.md` (`bun install`, `bun test test`, `bun run build`,
`bun run start`).

Shell của agent trong môi trường này có `ELECTRON_RUN_AS_NODE=1`: phải bỏ biến này khi chạy Electron
(`bun run start` đã làm). `alp web` từ chối chạy khi `ALP_AGENT_SESSION` được đặt, nên agent thử app
bằng một host dùng một lần (`ALP_HOME` tạm) và một `alp` giả in địa chỉ của host đó, không bao giờ
dùng `~/.alp` của người dùng (`ALP_DESKTOP_ALP`, `ALP_DESKTOP_USER_DATA`).

## 6. Chưa có trong bản này

E2e Playwright (phần 3);
DMG ký ad-hoc (arm64, x64) và Electron fuses; `alp web --print --json`; dừng `alp web` khi thoát app;
ký và notarize; Windows và Linux; mang alpd theo app.
