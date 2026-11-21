# ALP desktop (macOS, MVP)

> **Trạng thái:** t-81b0.2 phần 1 (khung), phần 2 (tự kết nối lại) và phần 3 (e2e Electron); t-81b0.3:
> DMG ký ad-hoc (arm64, x64) build trong CI thành artifact (§6), chưa phát hành; t-81b0.8: tự cài ALP
> khi máy chưa có (§3.2). Quyết định: D32, D35 (`plans/reference/DECISIONS.md`).

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
| Không tìm thấy `alp` (và không đặt `alpPath`/`ALP_DESKTOP_ALP`) | Đề nghị cài ALP (§3.2); trang này cũng ghi lệnh cài từ terminal (`install.sh`, npm) và cách đặt `alpPath`. |
| `alpPath`/`ALP_DESKTOP_ALP` trỏ tới đường dẫn không chạy được | Trang chưa cài, nêu đúng đường dẫn đó; không đề nghị cài (bản cài vào `~/.alp` sẽ không được dùng). |
| `alp` báo lỗi (vd. `dashboard.enabled` là false, chạy trong session của agent) | Nguyên văn thông báo lỗi của `alp`. |
| `alp` quá cũ, chưa có `alp dashboard` (0.0.1-beta.8 trở về trước: in usage thay vì địa chỉ) | Một câu nói rõ phiên bản (`alp --version`) và đường dẫn của `alp` đó, kèm cách cập nhật (`alp update`, hoặc cài bản build từ main); không dán usage. |
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

## 5. Build và chạy từ source

`apps/desktop` là project **bun** độc lập, không nằm trong `workspaces` của `package.json` gốc, có
`bun.lock` riêng và không phụ thuộc package `@anhlp/*` nào; `npm ci` và runner test gốc không chạy
nó. Test của nó (`apps/desktop/test`, `bun:test`) được miễn khỏi luật bố cục test trong
`test/integration/layout.test.js` chỉ khi script `test` của nó là `bun test test`; job CI
`desktop-macos` chạy `bun install --frozen-lockfile`, `bun test test`, typecheck và build, rồi
`npm ci`, `node scripts/build-workspace.mjs cli`, e2e (`bun run e2e`), rồi build hai DMG và chạy
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

Teardown dùng `defer` của `test/support/teardown.js`: đóng Electron (quá 15 giây thì SIGKILL), dừng
host, rồi mới xóa thư mục. App chạy với `HOME` tạm.

```sh
npm ci && node scripts/build-workspace.mjs cli   # ở gốc repo
cd apps/desktop && bun run e2e
```

## 6. Đóng gói: DMG cho macOS

`bun run dist` (trong `apps/desktop`) build `dist/` rồi chạy electron-builder (`electron-builder.yml`):
hai DMG, `release/ALP-<version>-arm64.dmg` và `release/ALP-<version>-x64.dmg` (mỗi file khoảng
130 MB), mỗi DMG chứa `ALP.app`. Không có gì được publish (`publish: null`, `--publish never`).

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

`alp dashboard --print --json`; dừng `alp dashboard` khi thoát app; ký bằng Developer ID và notarize;
tự cập nhật; phát hành DMG; Windows và Linux; mang alpd theo app.

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

`alp desktop` không đọc và không truyền token: app tự chạy `alp dashboard --print` (§1). Tên biến theo
các biến `ALP_DESKTOP_*` khác (`ALP_DESKTOP_ALP`, `ALP_DESKTOP_USER_DATA`). DMG cho `/Applications`: §6.
