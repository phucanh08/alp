# ALP desktop (macOS, MVP)

> **Trạng thái:** t-81b0.2 phần 1 (khung), phần 2 (tự kết nối lại) và phần 3 (e2e Electron); t-81b0.3:
> DMG ký ad-hoc (arm64, x64) build trong CI thành artifact (§6); t-81b0.8: tự cài ALP
> khi máy chưa có (§3.2); t-81b0.10: phát hành hai DMG trong GitHub Release từ `0.0.1-beta.10` (§8). Quyết định: D32, D35 (`plans/reference/DECISIONS.md`).

App desktop là một **vỏ mỏng** bằng Electron bọc quanh ALP mà người dùng đã cài. Nó không mang theo
alpd, gateway hay app web: nó chạy `alp dashboard --print --json` của người dùng (`--print` với alp ≤ `0.0.1-beta.13`), lệnh này khởi động hoặc gắn vào
service `alp-dashboard` ([dashboard.md](dashboard.md) §3.1), rồi mở app web trong cửa sổ riêng.

## 1. Luồng

1. Tìm `alp` (§2).
2. Chạy `alp dashboard --print --json` bằng `execFile`, không qua shell, với PATH đã tìm được, và đọc dòng JSON
   cuối của stdout (hợp đồng ở [dashboard.md](dashboard.md) §3.3). Một `alp` cũ (`0.0.1-beta.13` trở về trước) không
   biết `--json` (in usage, không có JSON): app chạy lại `alp dashboard --print` và đọc địa chỉ như trước.
3. Kiểm `url` (hoặc địa chỉ in ra, với `alp` cũ): phải đúng dạng `http://127.0.0.1:<port>/#token=alpgw1.<16 hex>.<43 base64url>`,
   không có path, query hay userinfo. Sai dạng thì báo lỗi, không mở.
4. `loadURL` địa chỉ đó. App web lấy token ra khỏi địa chỉ (`history.replaceState`), giữ trong
   sessionStorage của cửa sổ, và kết nối tới chính origin của trang ([dashboard.md](dashboard.md) §4.2).

Địa chỉ chứa token chỉ nằm trong bộ nhớ: không ghi log, không ghi file, không truyền qua tham số dòng
lệnh. Cửa sổ là một client cùng origin với `alp-dashboard` như một tab trình duyệt, nên gateway và alpd
không đổi gì và không có origin tin cậy mới. Như tab đó, cửa sổ là **host owner** (§9): token của
dashboard trên loopback.

### 1.1 Khung cửa sổ (t-81b0.12)

Như Paseo (`packages/desktop/src/window/window-manager.ts`, chế độ `native-mac`): trên macOS cửa sổ
**không có thanh tiêu đề riêng** (`titleBarStyle: 'hidden'`, `src/window-chrome.ts`). Ba nút đỏ/vàng/xanh
nằm ở `{ x: 16, y: 12 }`, giữa hàng header 36px của dashboard. `titleBarOverlay: true` bật Window
Controls Overlay: trang biết nút ở đâu qua `navigator.windowControlsOverlay` và `env(titlebar-area-*)`
(`titlebar-area-x` ≈ 85px), và chỉ dựa vào đó (apps/web `styles.css`):

- `.window-drag` (đầu `<body>` trong `index.html`): dải 36px trên cùng kéo được cửa sổ; mọi control
  (`button`, `a`, `input`, `[role=tab]`, `[tabindex]`, `[role=separator]`…) là `no-drag`.
- Sidebar (và sidebar của Settings) có một hàng trống 36px trên cùng cho ba nút; header nằm sát mép trái
  (sidebar đóng) chừa `titlebar-area-x`.
- Hai nút bật/tắt của hàng trên cùng thuộc về cửa sổ, như titlebar desktop của Paseo
  (`app/_layout.tsx` `WindowSidebarMenuToggle`, `screens/workspace/workspace-explorer-toggle.tsx`
  `titlebarAction`; apps/web `WindowChrome.tsx`, `lib/window-controls.js`): nút sidebar ngay sau ba nút
  (x ≈ 87px), nút panel phải ở mép phải cửa sổ, trong hàng tab Files/Changes khi panel mở và cuối
  header khi panel đóng. Đóng/mở sidebar hay panel thì hai nút đứng yên (và giữ focus); header chỉ chừa
  một ô trống chỗ nút đè lên. Chỉ khi overlay hiển thị và panel được dock (cửa sổ ≥ 768px cho sidebar,
  ≥ 1024px cho panel phải, ở màn hình workspace, Settings không mở); còn lại header tự vẽ nút như trước.
- Toàn màn hình: ba nút ẩn, overlay báo không hiển thị, `env()` không còn giá trị, mọi khoảng chừa về 0,
  hai nút bật/tắt về lại header.
- Trình duyệt, hay một ALP.app cũ còn thanh tiêu đề: không có overlay, trang y như trước.
- Trang nội bộ (`src/pages/page.css`) cũng có dải kéo trên cùng.

Windows và Linux giữ khung hệ thống: Paseo tự vẽ nút cửa sổ ở đó (`frame: false`), dashboard của ALP
không có các nút ấy. Một ALP.app mới mở một `alp dashboard` cũ (chưa có CSS trên) thì ba nút đè lên góc
trái trang và không có chỗ kéo cửa sổ, cho tới khi cập nhật `alp`.

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
| Không tìm thấy `alp` (và không đặt `alpPath`/`ALP_DESKTOP_ALP`) | Đề nghị cài ALP (§3.2); trang này cũng ghi lệnh cài từ terminal (`install.sh`, npm) và cách đặt `alpPath`. |
| `alpPath`/`ALP_DESKTOP_ALP` trỏ tới đường dẫn không chạy được | Trang chưa cài, nêu đúng đường dẫn đó; không đề nghị cài (bản cài vào `~/.alp` sẽ không được dùng). |
| `alp` báo lỗi (vd. `dashboard.enabled` là false, chạy trong session của agent) | `error.message` trong dòng JSON của `alp` (không có message thì mã lỗi và exit code); với `alp` cũ, nguyên văn thông báo lỗi. |
| `alp` trả dòng JSON với `version` mà app không biết | Một câu nói app đọc version nào và đề nghị cập nhật ALP desktop app; app không đoán. |
| `alp` quá cũ, chưa có `alp dashboard` (0.0.1-beta.8 trở về trước: in usage thay vì địa chỉ) | Một câu nói rõ phiên bản (`alp --version`) và đường dẫn của `alp` đó, kèm cách cập nhật (`alp update`, hoặc cài bản build từ main); không dán usage. |
| `alp dashboard --print --json` (hoặc `--print` với `alp` cũ) không trả lời trong 90 giây, hoặc `url` không phải địa chỉ ALP dashboard | Thông báo lỗi tương ứng. |
| Trang không tải được | Thông báo lỗi; chọn **File › Connect again** (⇧⌘R) để thử lại. |

**File › Connect again** chạy lại toàn bộ luồng ở §1, kể cả sau `alp dashboard rotate`.

### 3.1 Tự kết nối lại

Khi trang của `alp-dashboard` đã tải xong, app theo dõi nó (`src/reconnect.ts`):

| Dấu hiệu | Nghĩa |
|---|---|
| `GET <origin>/readyz` mỗi 3 giây không có trả lời HTTP nào (từ chối kết nối, quá 2 giây) hai lần liền | `alp-dashboard` dừng, crash hoặc đổi port. |
| Trang gặp 401 ở `POST <origin>/v1/tickets` | Token bị `alp dashboard rotate` hoặc revoke, hoặc `alp-dashboard` đã khởi động lại: mỗi lần khởi động nó tạo token mới và thu hồi token cũ (t-cee3). |
| Tải lại trang (View › Reload, hay lần tải do app kết nối lại) thất bại | Như trên. |

Khi đó app chạy lại `alp dashboard --print --json` (`--print` với alp cũ, §1; lệnh này khởi động `alp-dashboard` nếu nó không chạy) và tải địa chỉ
mới. `/readyz` trả 503 (alpd đang khởi động lại) **không** phải dấu hiệu: `alp-dashboard` vẫn chạy và app
web tự nối lại gateway. Nếu lệnh đó trả lại đúng địa chỉ cũ sau khi `alp-dashboard` sống lại, app
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

### 3.2 Cài ALP khi máy chưa có (t-81b0.8, D35)

Khi §2 không tìm thấy `alp` nào và không có `alpPath`, app:

1. Đọc **chỉ** `SHA256SUMS` của bản phát hành mới nhất
   (`https://github.com/phucanh08/alp/releases/latest/download/SHA256SUMS`, qua `net.fetch` của Chromium,
   theo proxy của hệ thống), chọn archive `alp-<version>-darwin-<arch>.tar.gz` giống cách `install.sh`
   chọn (app x64 chạy qua Rosetta thì chọn bản arm64, như `install.sh`). Bản cũ hơn 0.0.1-beta.9 (chưa có `alp dashboard`) bị từ chối. Đọc không được thì trang chưa cài
   nêu lý do và lệnh cài từ terminal.
2. Hiện trang xác nhận `install.html` trong cửa sổ: phiên bản, nguồn tải (`…/releases/download/v<version>`),
   tên archive và checksum mà `SHA256SUMS` liệt kê lúc đó (để tham khảo: `install.sh` tự tải lại
   `SHA256SUMS` của phiên bản đó và chỉ tin bản đó), thư mục cài (`~/.alp/app/<version>`), lệnh
   `~/.alp/bin/alp`, thư mục dữ liệu ALP (`$ALP_HOME` hoặc `~/.alp`; `install.sh` chỉ tạo nó, 0700, khi nó
   chính là `~/.alp` và chưa có; thư mục có sẵn giữ nguyên quyền), và việc PATH/shell profile không bị sửa. **Chưa
   ghi gì** cho tới khi người dùng bấm **Install**. **Cancel** quay về trang chưa cài; Connect again đề
   nghị lại.
3. Bấm Install: chạy `install.sh` **đóng gói sẵn trong app** (`dist/install.sh`, bản sao của `install.sh`
   ở gốc repo lúc build; app không tải và chạy script nào từ mạng) bằng `/bin/sh -s -- --version <v>
   --base-url <nguồn của v> --root ~/.alp --dir ~/.alp/bin --no-modify-path`. Môi trường của nó bỏ
   `ALP_INSTALL_BASE_URL`/`ALP_INSTALL_REPO`, nên nguồn luôn đúng nguồn trang đã nêu, và PATH của nó đặt
   `/usr/bin:/bin:/usr/sbin:/sbin` trước PATH của app (curl, shasum, tar của hệ thống). `install.sh` tải
   archive, so SHA-256 với `SHA256SUMS`, kiểm `bin/alp --version` (và `bin/alpd --version` của alpd
   native), tạo ALP home 0700 khi nó là `~/.alp` và chưa có (t-66a4), rồi mới chuyển bản cài vào chỗ.
4. Xong thì kết nối như §1 (`~/.alp/bin/alp` đứng đầu §2). Lỗi thì trang lỗi nêu lý do của `install.sh`
   (vd. `checksum mismatch …`, `could not download …`) và: nếu `~/.alp` chưa có trước đó và vẫn chưa có,
   "Nothing was installed"; nếu không, rằng trình cài dừng giữa chừng và ALP có thể đã nằm một phần dưới
   `~/.alp` (Connect again sẽ dùng hoặc đề nghị cài lại).

**Được kiểm và không được kiểm.** Được kiểm (bởi `install.sh`): archive đúng từng byte với checksum mà `SHA256SUMS` của
chính bản phát hành đó (tải lại qua HTTPS từ github.com lúc cài) liệt kê, và hai binary trong đó báo đúng
phiên bản. Checksum hiện trên trang xác nhận không được truyền cho `install.sh`: nếu bản phát hành bị thay
giữa lúc xem và lúc cài, `install.sh` kiểm theo `SHA256SUMS` mới.
Điều này chống file hỏng, tải dở hay một bản sao trung gian bị đổi, nhưng **không** chứng minh ai đã build
bản phát hành: ai sửa được release trên GitHub thì sửa được cả `SHA256SUMS`. App **không** kiểm GitHub
attestation (Sigstore) — làm vậy cần `gh` hoặc một bộ kiểm Sigstore trong app; trang xác nhận ghi lệnh
`gh attestation verify` để người dùng tự kiểm.

**ALP home có sẵn nhưng không riêng tư** (vd. `~/.alp` 0755 do `install.sh` của beta.8/beta.9 để lại):
`install.sh` không chmod một home có sẵn, chỉ in `alp-install: warning: …`, và alpd sẽ từ chối home đó.
App xem quyền của home trước: trang xác nhận ghi rõ mode hiện tại và lệnh `chmod 700 '<home>'`. Cài xong mà
`install.sh` có cảnh báo thì app không tự kết nối (sẽ kết thúc bằng lỗi ALP_HOME_UNUSABLE khó hiểu) mà hiện
trang "ALP <v> was installed …, but the installer warned:" kèm cảnh báo và lệnh sửa; sửa xong chọn Connect again.

**Không bị ghi một nửa.** Checksum sai, tải lỗi hay Cancel: không có gì được tạo dưới `~/.alp` (`install.sh`
chỉ ghi sau khi kiểm xong, và tự xóa thư mục tạm). Lỗi ở bước chuyển vào chỗ thì `install.sh` dọn bản
đang dựng; có thể còn lại thư mục rỗng `~/.alp/app` và `~/.alp/bin`, hoặc (lỗi sau khi bản cài đã vào
chỗ, vd. bước tạo link) một bản cài chưa trọn mà trang lỗi nói rõ. Hết thời gian (20 phút) thì app dừng cả
process group của `install.sh`; thư mục dựng `.alp-update-*` còn lại được lần cài sau dọn, và (SIGKILL bỏ qua `trap` của `install.sh`) thư mục tạm `alp-install.*` cùng archive đã tải có thể còn lại trong `TMPDIR`.

**`alp` cũ hơn 0.0.1-beta.9 đã có:** app không tự cập nhật nó (có thể là bản npm hay bản hệ thống mà app
không quản lý, và đang chạy một alpd); trang lỗi nêu phiên bản và cách cập nhật (`alp update`) như §3.

**Nguồn thử nghiệm.** `ALP_DESKTOP_INSTALL_MIRROR` (thư mục tuyệt đối hoặc `file://`) thay GitHub bằng một
bản sao cục bộ, **chỉ** khi app chạy từ source (`app.isPackaged` là false). ALP.app bỏ qua biến này
(unit test `installSource` và e2e đóng gói kiểm điều đó).

## 4. Bảo mật của cửa sổ

- `contextIsolation`, `sandbox`, không `nodeIntegration`, không preload; `app.enableSandbox()`.
  `webviewTag` bật chỉ cho cửa sổ dashboard, cho tab Browser (§4.1); mọi `webview` khác, ở bất kỳ
  webContents nào, bị từ chối.
- Chỉ điều hướng trong đúng origin của `alp-dashboard` (`will-navigate`, `will-frame-navigate`,
  `will-redirect`), ở cả frame chính lẫn subframe. Trang nội bộ (đang kết nối, lỗi, chưa cài) không
  được điều hướng đi đâu. Subframe `about:blank` và `about:srcdoc` bị từ chối như mọi đích khác (origin
  của URL là `null`): app web không có iframe, và một iframe sau này phải tải URL thật trên origin của
  `alp-dashboard`.
- `window.open` luôn bị từ chối; link `https:` được mở bằng trình duyệt mặc định, scheme khác bị bỏ.
- Mọi quyền (camera, micro, vị trí…) bị từ chối, trừ `clipboard-sanitized-write` (các nút Copy của app
  web) và `notifications` (t-0166: báo khi session chờ trả lời hay xong lượt), và chỉ khi yêu cầu đến từ
  webContents của cửa sổ dashboard với đúng origin của `alp-dashboard`. Trang nội bộ (`alp-page://`) và
  tab Browser (partition riêng, §4.1) vẫn bị từ chối mọi quyền. Với bản ký ad-hoc, macOS có thể không
  hiện notification (đã thấy trên bản đóng gói thử 2026-11-22: trang tạo được, không có `show`).
- Menu không giữ ⌘W: trang dashboard dùng nó để đóng tab hiện tại (bộ phím desktop của Paseo, t-0166);
  không còn tab nào để đóng (hay đang ở History) thì trang gọi `window.close()`, trừ khi đang mở
  dialog, menu hay Settings (một overlay); trên trang nội bộ ⌘W đóng cửa sổ (`before-input-event`). File › Close Window không có phím
  tắt. Trong trang của tab Browser, ⌘W, ⌘1-9 và ⌥⌘1-9 bị giữ lại (`before-input-event` của guest) và
  cửa sổ dashboard nhận cùng phím đó: một `keydown` dựng chỉ từ tên phím cố định (`shell-keys.ts`
  `dashboardKeyScript`), không dữ liệu nào của trang đi theo.
- Settings › Shortcuts ghi phím mà không cần cầu nối nào tới main process (không preload, không
  `setCapturingShortcut`; quyết định của người dùng ở gate t-81b0.14/g2, 2026-11-23). Trên macOS,
  Electron đưa phím Cmd (key equivalent) cho trang đang có focus trước; chỉ khi trang không xử lý thì
  mục menu mới chạy. Trong lúc một dòng chờ phím, listener của trang (`apps/web`
  `settings/ShortcutsPage.tsx`, window, capture phase) gọi `preventDefault` với mọi phím, nên ⌘Q, ⌘H,
  ⌘Z, ⇧⌘Z, ⌘X, ⌘C, ⌘V, ⌥⇧⌘V, ⌘A, ⌘R, ⌘0, ⌘=, ⌘-, ⌃⌘F, ⌘M, ⇧⌘R (và ⌥⌘I ở bản dev) được ghi vào dòng đó
  và mục menu không chạy; hết capture thì menu nhận phím lại như cũ. Paseo cần `setCapturingShortcut`
  chỉ để tắt ba mục Zoom (`enabled: false`, dựng lại menu; `dist/features/menu.js` trong app.asar
  của Paseo). E2E `apps/desktop/e2e/shortcut-capture.spec.mjs` kiểm bằng phím thật (CoreGraphics
  `CGEventPostToPid` chỉ tới process của app đang test; `webContents.sendInputEvent` không đi qua
  menu), và skip, kèm lý do, khi máy không cho process gửi phím (thiếu quyền Accessibility). ⌥⌘H
  không được bấm vì nó sẽ ẩn các app khác của người dùng. Ngoại lệ đã đo: khi focus nằm trong guest
  của một tab Browser, phím thuộc trang đó, dòng vẫn chờ, và menu chạy (⌘M thu nhỏ cửa sổ); giao diện
  không dẫn tới trạng thái này vì Settings phủ cả cửa sổ.
- Kích thước, vị trí và trạng thái phóng to của cửa sổ được lưu ở `<userData>/window-state.json` (0600)
  và dùng lại khi mở app, chỉ khi vẫn thấy ít nhất 100×80 của cửa sổ trên một màn hình đang nối.
- Dock hiện chấm (•) khi favicon của dashboard là favicon attention; đọc qua `page-favicon-updated`,
  không cần preload.
- Single-instance: mở app lần hai chỉ focus cửa sổ đang có (không còn cửa sổ nào thì mở và kết nối).
- DevTools chỉ có khi chạy từ source (chưa đóng gói).
- Trang nội bộ được phục vụ qua scheme riêng `alp-page://app/<tên>`, không qua `file://` (xem §6.4).
  Handler trong main process chỉ trả đúng chín file `connecting.html`, `error.html`, `missing-alp.html`,
  `install.html`, `installing.html`, `page.css`, `page.js`, `missing-alp.js`, `install.js` trong `dist/pages` của app (`app.getAppPath()`); mọi đường
  dẫn khác, `..`, dấu phân cách đã mã hóa hay đường dẫn tuyệt đối đều nhận 404. Scheme được đăng ký chỉ
  với `standard` (để `page.css`/`page.js` tương đối và CSP `'self'` resolve về `alp-page://app`);
  không có `secure`, `supportFetchAPI`, `corsEnabled`, `bypassCSP`, `allowServiceWorkers` hay `stream`. Trang của `alp-dashboard` không được
  điều hướng tới, mở hay xin quyền từ scheme này: chốt origin ở trên không đổi.
- Nút Install/Cancel của trang xác nhận (§3.2) là một navigation tới `alp-page://app/confirm?action=…&nonce=…`
  mà main process chặn (`will-frame-navigate`, chỉ main frame) và đọc. Nonce là ngẫu nhiên, chỉ có trong
  địa chỉ của trang xác nhận đang hiện, dùng một lần; câu trả lời khác hoặc cũ bị bỏ qua. Trang vẫn không
  có preload hay Node.

### 4.1 Tab Browser (t-9116)

Menu "+" của workspace có **Browser** (icon quả địa cầu, sau Diff, như Paseo) **chỉ trong ALP.app**:
main process thêm `ALPDesktop/1` vào user agent của cửa sổ dashboard và `apps/web` chỉ hiện mục này
khi thấy nó. Dấu đó không phải quyền: ranh giới bảo mật là các chốt của main process
(`apps/desktop/src/browser.ts`), không phải trang web. Ngoài ALP.app (trình duyệt thường) mục này không
có, và một tab Browser đã lưu chỉ hiện "Only available in ALP.app".

Một tab Browser là một `<webview>` trong cửa sổ dashboard, có Back, Forward, Reload và ô địa chỉ.
Địa chỉ gõ vào được đọc như `normalizeBrowserUrl` của Paseo: `localhost`, IPv4 hay `[IPv6]` (có hoặc
không có cổng) nhận `http://`, có scheme thì giữ, còn lại nhận `https://`; không có công cụ tìm kiếm
(chữ có khoảng trắng bị từ chối). Kết quả phải là http, https hay `about:blank`. Mỗi workspace giữ
tối đa 20 tab Browser với địa chỉ của chúng trong `alp-web:layout` (kiểm lại khi đọc; không bao giờ là
địa chỉ của dashboard; fragment của mọi địa chỉ bị bỏ khi đọc và khi lưu).

**Các chốt (main process, bất kể trang yêu cầu gì):**

- `will-attach-webview` (mọi webContents): chỉ cửa sổ dashboard được gắn webview; partition phải là
  `persist:alp-browser` (không bao giờ session mặc định, nơi dashboard và token của nó ở) và `src`
  phải là http, https, `about:blank` hoặc trống, nếu không thì từ chối. Preferences là một allowlist:
  mọi key trang đặt (trực tiếp, qua thuộc tính `webpreferences`, hay như `enableBlinkFeatures`,
  `additionalArguments`, `javascript`…) bị xóa, cùng các thuộc tính `webpreferences`, `preload`,
  `nodeintegration*`, `disablewebsecurity`, `plugins`, `*blinkfeatures` trong params; chỉ còn
  `sandbox`, `contextIsolation`, không `nodeIntegration` (kể cả subframe và worker), `webSecurity`,
  không `webviewTag`, plugins, WebSQL hay experimental features, DevTools tắt (mở DevTools bị đóng
  ngay), `javascript`, `safeDialogs`, `disablePopups: false` (để `window.open` tới handler bên dưới) và
  `zoomFactor` nếu là số dương.
- Điều hướng của guest (`will-navigate`, `will-frame-navigate`, `will-redirect`; main frame và
  subframe): chỉ http, https, `about:blank` (subframe còn được `about:srcdoc`, tài liệu inline của
  iframe). Bị chặn: `file:`, `data:`, `javascript:`, `chrome:`, `devtools:`, `blob:` ở main frame,
  `alp-page:`. Dashboard bị chặn dưới **mọi cách viết** trên cổng của nó: `127.0.0.0/8` (kể cả
  `2130706433`, `0x7f.1`: URL parser viết lại thành `127.0.0.1`), `localhost` và `*.localhost`,
  `[::1]`, IPv4 viết dạng IPv6 (`[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[::127.0.0.1]`; cũng áp dụng
  cho địa chỉ interface), `0.0.0.0`, `[::]`, hostname của máy (`os.hostname()`, dạng trơn và
  `.local`) và địa chỉ của các network interface. Cổng là mọi cổng dashboard đã có trong lần chạy này
  (đổi khi dashboard khởi động lại; cổng mới được thêm lúc tải; origin không ghi cổng tính theo cổng
  mặc định của scheme, không bao giờ là 0).
- Lần tải do chính trang dashboard bắt đầu (`webview.loadURL`, đổi `src`) không phát các sự kiện
  trên: `<webview>` nhờ main process gọi `loadURL` của guest, và hàm đó (đã bọc) từ chối mọi địa chỉ
  ngoài quy tắc trên. Một điều hướng main frame vẫn lọt thì bị `stop()` ngay sau `did-start-navigation`
  (gọi `stop()` ngay trong sự kiện làm Electron 44 crash); việc `stop()` này chỉ là lớp chặn dự phòng
  best-effort, đứng sau chốt `loadURL` và `will-navigate`/`will-frame-navigate`, không phải chốt chính. Và partition trả 403 cho mọi `file:`
  (`protocol.handle('file')`), bất kể lần tải bắt đầu từ đâu.
- `session.webRequest.onBeforeRequest` trên partition `persist:alp-browser`: mọi request (fetch, XHR,
  WebSocket, ảnh, iframe…) tới những host:cổng ấy bị hủy, cùng mọi request `file:`, `chrome:`,
  `devtools:`; không chỉ điều hướng.
- Quyền của partition (`setPermissionRequestHandler`, `setPermissionCheckHandler`,
  `setDevicePermissionHandler`): từ chối hết. Download (`will-download`): bị hủy ở v1.
- `window.open` / `target=_blank` từ guest: không bao giờ có cửa sổ. Main process từ chối cửa sổ và gửi
  cho trang dashboard sự kiện `alp-desktop:browser-open` (`executeJavaScript` chỉ chứa dữ liệu JSON:
  id webContents của guest và địa chỉ); tab Browser có guest đó mở một tab Browser mới trong cùng
  workspace. Tối đa 5 lần mỗi 10 giây cho mỗi guest, và địa chỉ phải qua cùng chốt điều hướng.
- Điều hướng **của chính trang** (bấm link, redirect, đổi `location`) bị chốt điều hướng chặn ở main
  frame thì main process gửi cho trang dashboard sự kiện `alp-desktop:browser-blocked` theo cùng cách
  (dữ liệu JSON: id guest và địa chỉ, cắt còn 300 ký tự; tối đa 10 lần mỗi 2 giây cho mỗi guest). Chỉ
  tab có guest đó hiện dòng "Blocked navigation to <địa chỉ>" (dạng chữ thuần, bỏ ký tự điều khiển,
  cắt còn 200 ký tự), thay vì đứng yên không nói gì; điều hướng kế tiếp xóa dòng đó. Subframe bị chặn
  thì không báo. `file:`, `data:`, `chrome:`, `devtools:` mà trang tự đi tới bị chính Chromium từ chối
  trong renderer, trước khi tới chốt, nên không có thông báo; lần tải từ ô địa chỉ bị từ chối thì hiện
  dòng lỗi "… is blocked in Browser or did not load." như trước.

**Trang sống khi tab không ở phía trước (t-a35b).** Như webview "resident" của Paseo: mọi tab Browser
của workspace đã từng được hiện được render một lần, trong một lớp phủ trên các pane (`BrowserHost`,
`apps/web/src/app/BrowserPanel.tsx`), và đặt khít lên ô (`BrowserSlot`) của pane đang hiện tab đó. Tab
không ở phía trước vẫn giữ `<webview>` (cùng webContents, không tải lại; scroll, ô nhập, state của
script còn nguyên) nhưng bị ẩn: `visibility: hidden`, `inert` (không nhận focus), không nhận con trỏ.
Chuyển tab sang pane khác chỉ di chuyển ô; phần tử `<webview>` không bao giờ đổi chỗ trong DOM (Electron
tải lại guest có phần tử bị di chuyển). `window.open` từ một tab đang ẩn vẫn mở tab mới. Đóng tab thì
gỡ `<webview>` và trang bị hủy. Đổi workspace, hay mở màn Tasks, History, Schedules (thay cả vùng
pane) thì bỏ hết các trang; tab tải lại địa chỉ đã lưu khi được hiện lần sau. Tab Browser đã lưu mà
chưa từng được hiện thì chưa tải gì.

**Guest với tới được gì:** mọi trang http/https mà máy với tới được, kể cả server khác trên loopback
(dev server của người dùng là mục đích chính), với cookie và storage riêng trong `persist:alp-browser`
(giữ qua lần khởi động sau). Không: token, `localStorage`/`sessionStorage`/cookie của dashboard (khác
session, khác origin), Node, preload, cửa sổ mới, quyền, file trên đĩa.

**Rủi ro còn lại:**

- Một XSS trong trang dashboard có thể tự tạo webview. Các chốt trên ép partition và bỏ preload, nên
  một webview như vậy không mạnh hơn một iframe: nó vẫn không đọc được gì của dashboard.
- DNS rebinding (một tên miền trỏ về `127.0.0.1`) vượt qua chốt theo tên host; gateway của dashboard
  tự kiểm tra header `Host` (`apps/gateway/src/server.ts`), và mọi request vẫn cần token.
- Guest với tới các dịch vụ loopback khác của máy (không phải dashboard), như một trình duyệt thường.
- Mỗi tab Browser đã hiện giữ một trang sống (bộ nhớ, timer, kết nối) cho đến khi tab bị đóng hay đổi
  workspace; tối đa 20 tab mỗi workspace.

## 5. Build và chạy từ source

`apps/desktop` là project **bun** độc lập, không nằm trong `workspaces` của `package.json` gốc, có
`bun.lock` riêng và không phụ thuộc package `@anhlp/*` nào; `pnpm install --frozen-lockfile` và runner test gốc không chạy
nó. Test của nó (`apps/desktop/test`, `bun:test`) được miễn khỏi luật bố cục test trong
`test/integration/layout.test.ts` chỉ khi script `test` của nó là `bun test test`; job CI
`desktop-macos` chạy `bun install --frozen-lockfile`, `bun test test`, typecheck và build, rồi
`pnpm install --frozen-lockfile`, `node scripts/build-workspace.ts cli`, e2e (`bun run e2e`), rồi build hai DMG và chạy
e2e của app đã đóng gói trên từng DMG (§6). Lệnh: xem `apps/desktop/README.md` (`bun install`, `bun test test`, `bun run build`,
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
  của agent (`ALP_AGENT_SESSION`…) bị bỏ bằng `hermeticEnv` của `scripts/test-lib.ts`, giống runner
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
- `alp-dashboard` khởi động lại trên cùng port, không rotate (t-cee3): `alp` giả hỏi token qua socket của
  service đang chạy như `alp dashboard --print --json` thật, nên chỉ việc app chạy lại `--print --json` mới đưa được token
  mới vào cửa sổ; test kiểm token cũ bị 401 ở `/v1/tickets` và fail khi tắt `Reconnector.trigger`.

`apps/desktop/e2e/install.spec.mjs` (t-81b0.8) chạy app với `HOME`, `ALP_HOME`, `TMPDIR` tạm, một login
shell giả không tìm thấy `alp`, và một bản sao phát hành cục bộ (`releaseMirror`: `SHA256SUMS` và archive
chứa bundle giả) qua `ALP_DESKTOP_INSTALL_MIRROR`, không dùng mạng:

- trang xác nhận nêu phiên bản và mọi đường dẫn, không có gì được ghi trước Install, Install xong thì ALP
  home là 0700, `bin/alp` và `app/current` đúng, không file profile nào bị ghi, cửa sổ mở alp dashboard;
- archive bị sửa (checksum sai), archive thiếu (tải lỗi): trang lỗi nêu lý do, không có `~/.alp`, không
  còn thư mục tạm của `install.sh`;
- Cancel: không ghi gì; nonce cũ không làm gì; Connect again đề nghị lại;
- không đọc được `SHA256SUMS`;
- `~/.alp` có sẵn ở 0755: trang xác nhận nêu mode và lệnh `chmod 700`, cài xong thì hiện cảnh báo của
  `install.sh` thay vì kết nối, và mode của home không bị đổi.

Ca cuối cài **bản phát hành thật** từ một bản sao tài sản của nó, chỉ khi `ALP_DESKTOP_E2E_RELEASE_MIRROR`
trỏ tới thư mục chứa `SHA256SUMS` và archive darwin: alpd thật chạy dưới ALP home tạm (kiểm đường dẫn socket
trước khi dừng), `alp dashboard --print` chạy được và cửa sổ mở nó.

`apps/desktop/e2e/owner.spec.mjs` (t-ff83) chạy app với host owner thật: một alpd và `alp dashboard`
dưới `HOME`/`ALP_HOME`/`TMPDIR` tạm (đường dẫn socket trong `alpd.lock` được kiểm nằm trong thư mục tạm
trước mọi thay đổi), `alp` là một wrapper `env -i` chỉ giữ biến ALP, PATH (có `gh` giả, không mạng),
HOME, TMPDIR; provider là `fake-codex.js` của `apps/web/e2e/support`:

- sidebar: các repo Git thật đăng ký làm project, session nằm dưới workspace của nó, hàng mới nhất có
  nhánh, `+thêm -bớt`, số PR và CI (từ `gh` giả, chỉ chạy trong các repo), icon `logo.svg` qua `<img>`,
  ô chữ cái cho project không có icon, và Schedules liệt kê job đã tạo;
- một thao tác owner trong Settings: General › Agents' language đặt English, `settings.json` ghi lại,
  `alp language` đọc ra, vẫn còn sau khi tải lại trang.

`apps/desktop/e2e/browser.spec.mjs` (t-9116) dựng host giống vậy (alpd thật, một project, không
session, không provider) cùng một server http cục bộ của test, rồi kiểm tab Browser (§4.1): menu "+"
có Browser sau Diff; tab tải trang cục bộ gõ không có scheme; guest ở `persist:alp-browser`, không
preload, không đọc được token, storage, cookie, Node hay `window.top` của dashboard; điều hướng tới
`file:`, `data:`, `chrome:`, `devtools:`, `blob:` và dashboard dưới mọi cách viết (kể cả qua redirect
và iframe) bị chặn; fetch/XHR/WebSocket tới cổng dashboard bị `onBeforeRequest` hủy (fetch tới server
của test thì đi); quyền bị từ chối, DevTools không mở, download bị hủy; `window.open` và
`target=_blank` mở tab Browser mới, không bao giờ thêm cửa sổ; (t-a35b) chuyển sang tab khác rồi quay
lại giữ nguyên trang (cùng guest, không điều hướng mới, scroll, ô nhập và biến script còn), tab ẩn thì
`inert` và `visibility: hidden`; điều hướng bị chặn hiện "Blocked navigation to …" (kể cả địa chỉ sau
redirect), chỉ ở tab của guest đó; tab đang ẩn vẫn mở được tab mới bằng `window.open`; webview không partition, partition khác
hay `src` `file:` bị từ chối, và preload bị bỏ. Với `ALP_DESKTOP_SHOTS=<thư mục>` test lưu hai ảnh
chụp (menu "+" và tab Browser). Phía trình duyệt thường là `apps/web/e2e/browser-tab.spec.js` (với một `<webview>` giả: lớp
resident qua đổi tab và chuyển pane, thông báo chặn điều hướng chỉ dạng chữ, dòng lỗi khi lần tải bị
từ chối sau `dom-ready`).

`apps/desktop/e2e/shortcut-capture.spec.mjs` (t-81b0.14; chạy tay trên một Mac cho phép gửi phím: `bun run build && node --test e2e/shortcut-capture.spec.mjs`, chưa nằm trong `bun run e2e` hay CI) dựng host giống vậy (alpd thật, chưa đăng ký
project) và gửi phím thật qua `osascript -l JavaScript` (CoreGraphics `CGEventCreateKeyboardEvent` +
`CGEventPostToPid`, chỉ tới pid của app đang test): trong lúc Settings › Shortcuts chờ phím, mỗi phím
menu (§4, trừ ⌥⌘H) được dòng đó ghi và cửa sổ không reload, zoom, thu nhỏ, ẩn, full screen hay mở
DevTools; hết capture thì ⌘=, ⌘M, ⌘R chạy mục menu của chúng; một capture vẫn còn sau khi cửa sổ mất
rồi lấy lại focus thì vẫn ghi ⌘R, ⌘M; focus trong guest của tab Browser thì dòng không thấy phím (menu
làm gì thì chỉ báo lại). Một phím đầu tiên (A) phải tới được trang, nếu không test skip kèm lý do (máy
không cho process gửi phím: thiếu quyền Accessibility, có thể là CI). Một lần bấm chỉ được lặp lại (tối
đa ba lần) khi cửa sổ mất focus trong lúc bấm; phím bị mất khi cửa sổ vẫn giữ focus thì test fail.

Teardown dùng `defer` của `test/support/teardown.ts`: đóng Electron (quá 15 giây thì SIGKILL), dừng
host (với `owner.spec.mjs`, `browser.spec.mjs` và `shortcut-capture.spec.mjs`: `alp dashboard --stop`, rồi `alp daemon stop`), rồi mới xóa thư mục. App chạy với `HOME` tạm.

```sh
pnpm install --frozen-lockfile && node scripts/build-workspace.ts cli   # ở gốc repo
cd apps/desktop && bun run e2e
```

## 6. Đóng gói: DMG cho macOS

`bun run dist` (trong `apps/desktop`) build `dist/` rồi chạy electron-builder (`electron-builder.yml`):
hai DMG, `release/ALP-<version>-arm64.dmg` và `release/ALP-<version>-x64.dmg` (mỗi file khoảng
130 MB), mỗi DMG chứa `ALP.app`. `<version>` là version trong `apps/desktop/package.json`, từ
`0.0.1-beta.10` bằng version của bản phát hành. electron-builder không publish gì (`publish: null`,
`--publish never`); workflow phát hành gắn DMG vào bản nháp của GitHub Release (§8).

| Mục | Giá trị |
|---|---|
| Tên bundle | `ALP.app` (`productName: ALP`): `alp desktop` tìm đúng tên này (§7) |
| Bundle id | `com.anhlp.alp.shell`, khác app desktop cũ `com.anhlp.alp.desktop`; `alp desktop` chỉ mở bundle có id này |
| Chữ ký | ad-hoc (`identity: '-'`), hardened runtime; không có Apple Developer ID, không notarize. Không ký thì Apple Silicon báo app "bị hỏng" |
| Entitlements | `build/entitlements.mac.plist`: `allow-jit` và `disable-library-validation` (app ký ad-hoc nạp framework Electron mang Team ID khác) |
| Electron fuses | `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` tắt; `OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation`, `EnableCookieEncryption` bật; `GrantFileProtocolExtraPrivileges` tắt |
| Icon | `build/icon.png` (1024×1024), vẽ bằng `node scripts/icon.mjs`; electron-builder đổi sang `.icns` |
| macOS tối thiểu | 12.0 |

electron-builder dò package manager và workspace root bằng cách đi ngược lên tới `package.json` đầu
tiên có trường `workspaces`, tức là `package.json` gốc (npm), dù `apps/desktop` không nằm trong đó, rồi
fail khi gom `node_modules`. Vì vậy `apps/desktop/package.json` có `"packageManager": "bun@1.4.2"` và
`"workspaces": []`: nó tự là gốc, và electron-builder dùng bun. App không có dependency lúc chạy nên
không có `node_modules` nào được đóng gói.

### 6.1 Mở app đã tải về (Gatekeeper)

App chỉ ký ad-hoc, chưa notarize, nên Gatekeeper chặn lần mở đầu tiên một app **tải về** (có thuộc
tính `com.apple.quarantine`):

1. Mở DMG, kéo `ALP.app` vào `/Applications` (hoặc `~/Applications`).
2. Mở `ALP.app`; macOS báo không thể kiểm tra app. Chọn **Done** (không chọn Move to Trash).
3. Từ macOS 15 (Sequoia), Control-click › Open không còn bỏ qua được: vào **System Settings ›
   Privacy & Security**, tìm dòng về "ALP" và chọn **Open Anyway**, xác nhận bằng mật khẩu, rồi mở lại.

Build tại máy (không qua trình duyệt) không có quarantine nên mở được ngay. Nếu cần bỏ quarantine
của một bản mình tự build và chép qua kênh khác: `xattr -dr com.apple.quarantine /Applications/ALP.app`.
Đừng làm vậy với app không rõ nguồn.

### 6.2 Kiểm tra app đã đóng gói

`e2e/packaged.spec.mjs` (`ALP_DESKTOP_DMG=<dmg> bun run e2e:packaged`, cần cài đặt gốc và CLI đã build
như §5.1) mount DMG, chép `ALP.app` vào một thư mục `Applications` tạm (`HOME` tạm), rồi kiểm:

- `Info.plist` (tên, bundle id), chữ ký ad-hoc có cờ `runtime` (`codesign -dv`, `codesign --verify
  --deep --strict`) và các fuse (`@electron/fuses`);
- app kết nối tới host dùng một lần qua `alp` giả, và app web lấy token ra khỏi địa chỉ;
- với `ELECTRON_RUN_AS_NODE=1`, app vẫn chạy như app (Electron dev, không có fuse, thì chạy script như
  Node: đó là đối chứng);
- `alp desktop` (CLI đã build, `HOME` tạm, `open` giả ghi lại đối số) mở đúng `ALP.app` theo thứ tự §7.
- ba trang nội bộ (đang kết nối, lỗi với một `alp` như 0.0.1-beta.8, chưa cài) nạp từ
  `alp-page://app/…` của chính app, có tiêu đề `h1` (§6.4).

Playwright `_electron` cần Node inspector, mà fuse `EnableNodeCliInspectArguments` đã tắt, nên test đọc
cửa sổ qua DevTools protocol (`--remote-debugging-port`). Mọi lần chạy app tự động (cả e2e dev ở §5.1)
có `--use-mock-keychain`: với `HOME` tạm không có login keychain, và app có `EnableCookieEncryption`
sẽ hiện hộp thoại "Keychain Not Found" trên màn hình người dùng. Test còn theo dõi cửa sổ trên màn
hình (chỉ pid, tên process và layer, không đọc tiêu đề hay pixel): hễ có cửa sổ mới của
SecurityAgent, UserNotificationCenter, CoreServicesUIAgent, coreautha, hoặc app có thêm cửa sổ, app bị
kill ngay và test fail. Không bao giờ bấm hay script câu trả lời cho hộp thoại như vậy.

Trong CI, job `desktop-macos` (macos-latest, arm64) build với `CSC_FOR_PULL_REQUEST=true`, vì
electron-builder bỏ ký trên build của pull request (lo ngại chứng chỉ và secret lọt sang PR từ fork;
ký ad-hoc không dùng chứng chỉ, secret hay keychain nào), và `CSC_IDENTITY_AUTO_DISCOVERY=false`. Job
giữ hai artifact `alp-desktop-macos-arm64-dmg` và `alp-desktop-macos-x64-dmg` trong 14 ngày (tải lên
trước khi test, để một lần chạy đỏ vẫn còn DMG mà xem), rồi chạy test này với DMG arm64 và DMG x64.
App x64 chạy qua Rosetta: lần khởi động đầu phải dịch Electron nên chậm hơn nhiều, test chờ tới 300
giây thay vì 60 giây; khi test fail, thông báo lỗi kèm output và trạng thái thoát của app.

### 6.3 Chưa có trong bản này

Dừng `alp dashboard` khi thoát app; ký bằng Developer ID và notarize;
tự cập nhật; Windows và Linux; mang alpd theo app.

### 6.4 Bài học: cửa sổ trắng của bản đóng gói (t-81b0.7)

`ALP.app` từ artifact của main ff7c98be mở ra một cửa sổ trắng trên máy người dùng: DevTools cho thấy
`chrome-error://chromewebdata/` với body rỗng, log ghi `ERR_FILE_NOT_FOUND` cho mọi trang nội bộ. Có
hai nguyên nhân chồng lên nhau, và e2e đóng gói không thấy cái nào:

1. `bun build` thay `__dirname` (và `import.meta.dir`/`path`/`url`) bằng thư mục nguồn **trên máy
   build**, nên app tìm trang ở `/Users/runner/work/alp/alp/apps/desktop/src/pages` của runner CI. E2E
   chạy trên chính runner đó, nơi đường dẫn ấy tồn tại, nên vẫn xanh. Trang giờ lấy từ
   `app.getAppPath()/dist/pages`; `test/bundle.test.ts` fail nếu bundle còn chứa đường dẫn tuyệt đối
   của cây build, và e2e dev build một bản sao rồi xóa `src` của nó trước khi chạy.
2. Fuse `GrantFileProtocolExtraPrivileges` tắt thì `file://` không đọc được bên trong `app.asar`.
   Electron dev không có fuse, còn đường dẫn sai ở (1) lại nằm ngoài asar, nên lỗi này bị che. Fuse vẫn
   tắt; trang đi qua `alp-page://` (§4), đọc bằng main process nơi `app.asar` là một thư mục.

Quy tắc: một trang hay tài nguyên mà app đóng gói nạp phải được kiểm trên **app đóng gói** và bằng
URL nó thật sự nạp (scheme, nguồn) cùng nội dung hiển thị, không chỉ bằng việc test xanh trên máy đã
build nó. `e2e/packaged.spec.mjs` kiểm ba trang nội bộ như vậy; DMG của ff7c98be fail cả ba.

## 7. `alp desktop`

`alp desktop` (t-81b0.5) mở app này, theo thứ tự:

1. `ALP.app` trong `/Applications`, rồi `~/Applications` (macOS): mở bằng `open`. Chỉ tính bundle có
   `CFBundleIdentifier` là `com.anhlp.alp.shell` (§6); một app khác cùng tên (vd. app desktop cũ
   `com.anhlp.alp.desktop`) bị bỏ qua với một dòng `Skipped <đường dẫn>: its bundle id is …` trên
   stderr, rồi tìm tiếp;
2. nếu không có: checkout do `ALP_DESKTOP_CHECKOUT` chỉ tới (gốc repo, hoặc chính `apps/desktop`), với app
   đã build (`bun install && bun run build` trong `apps/desktop`): chạy bằng Electron của checkout đó,
   bỏ `ELECTRON_RUN_AS_NODE`;
3. không có cả hai: in cách cài (đặt `ALP.app` vào `/Applications`, hoặc đặt `ALP_DESKTOP_CHECKOUT`) và
   exit 1; trong lúc chờ, `alp dashboard` mở ALP trên trình duyệt.

`alp desktop` không đọc và không truyền token: app tự chạy `alp dashboard --print --json` (§1). Tên biến theo
các biến `ALP_DESKTOP_*` khác (`ALP_DESKTOP_ALP`, `ALP_DESKTOP_USER_DATA`). DMG cho `/Applications`: §6.

## 8. Tải và cài DMG từ GitHub Release (t-81b0.10)

Từ `0.0.1-beta.10`, mỗi GitHub Release (`https://github.com/phucanh08/alp/releases`) có:

| File | Nội dung |
|---|---|
| `ALP-<version>-arm64.dmg` | App cho Apple Silicon (M1 trở lên) |
| `ALP-<version>-x64.dmg` | App cho Intel; trên Apple Silicon chạy được qua Rosetta nhưng nên dùng bản arm64 |
| `DESKTOP-SHA256SUMS` | SHA-256 của hai DMG. `SHA256SUMS` của release chỉ liệt kê archive và trình cài của ALP, không có DMG |

Workflow `release-binaries.yml` build hai DMG từ đúng SHA của main mà các archive được build, kiểm
version của DMG bằng version của bản phát hành, chạy e2e của app đóng gói trên từng DMG (§6.2), rồi gắn
chúng vào bản nháp kèm `DESKTOP-SHA256SUMS` và attestation build provenance. Workflow chỉ tạo bản
nháp; bản phát hành được publish bằng tay.

Cài:

1. Tải DMG đúng kiến trúc và `DESKTOP-SHA256SUMS` vào cùng một thư mục, rồi kiểm:
   ```sh
   grep ' ALP-<version>-arm64.dmg$' DESKTOP-SHA256SUMS | shasum -a 256 -c
   gh attestation verify ALP-<version>-arm64.dmg --repo phucanh08/alp \
     --signer-workflow phucanh08/alp/.github/workflows/release-binaries.yml
   ```
   Checksum chỉ chống file hỏng hay tải dở; attestation (cần `gh`) mới chứng minh DMG được build bởi
   workflow phát hành của repo này.
2. Mở DMG, kéo `ALP.app` vào `/Applications` (hoặc `~/Applications`).
3. Lần mở đầu: Gatekeeper chặn vì app chỉ ký ad-hoc, chưa notarize (§6.1). macOS 14 trở về trước:
   Control-click (chuột phải) `ALP.app` › Open. macOS 15 trở đi: mở một lần, chọn Done, rồi System
   Settings › Privacy & Security › Open Anyway. Hoặc, **sau khi** đã kiểm ở bước 1:
   `xattr -dr com.apple.quarantine /Applications/ALP.app`.
4. App tìm `alp` (§2). Máy chưa có ALP thì app đề nghị cài bản phát hành **mới nhất** (§3.2; app chỉ
   kiểm checksum, không kiểm attestation). Đã có `alp` cũ hơn 0.0.1-beta.9 thì cập nhật bằng
   `alp update` hoặc npm. Sau đó `alp desktop` cũng mở được app này (§7).

App không tự cập nhật: bản mới thì tải DMG mới và thay `ALP.app`. Gỡ: thoát app, xóa `ALP.app`; dữ
liệu của app nằm ở `~/Library/Application Support/ALP` (ALP đã cài dưới `~/.alp` không bị đụng tới).

## 9. Settings trong app (t-a95b)

Settings của app là Settings của app web ([dashboard.md](dashboard.md) §4.6). Cửa sổ dùng token của
`alp dashboard` trên kết nối loopback, nên nó là **host owner**
([remote-gateway.md](remote-gateway.md) §5.19): các việc đổi host trong Settings mở cho nó (dần dần, mỗi
trang một thay đổi), còn cùng app web nối tới một `alp-gateway` từ xa thì không bao giờ được, và nhận lỗi
như trước.

Voice, Pair device, Plugins và Metadata không còn trong Settings: ALP không có speech provider; ghép
thiết bị là `alp dashboard pair` chạy trên host; cài plugin thay đổi host và ALP không có đường cài
plugin từ app; ALP không có tính năng sinh tiêu đề session hay tên nhánh.
