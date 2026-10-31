# Phạm vi beta (`0.0.0-beta.1` đến `0.0.1-beta.7`)

> **Beta.7 (`0.0.1-beta.7`, t-7933):** bản đầu tiên phát hành dạng bundle Node (GitHub release) và npm 8 gói (`@anhlp/alp` là wrapper của `@anhlp/alp-cli`). Người dùng beta.5/6 phải chạy lại `install.sh`/`install.ps1` rồi `alp daemon restart`. Xem [beta-release-notes.md](beta-release-notes.md).

> **Beta.6 (`0.0.1-beta.6`, t-693e):** sửa lỗi của beta.5: file thực thi không nhúng Claude Agent SDK, nên mọi phiên Claude đều lỗi `Cannot find package '@anthropic-ai/claude-agent-sdk'`. npm bỏ qua beta.5; beta.6 phát hành cả npm lẫn GitHub release từ cùng một SHA của main. Chưa phát hành (t-36f6). Xem [beta-release-notes.md](beta-release-notes.md).

> **Beta.5 (`0.0.1-beta.5`, t-1e02):** cùng version cho npm (dist-tag `beta`) và binary GitHub release (release thường, không prerelease); xem [beta-release-notes.md](beta-release-notes.md) và [binary-install.md](binary-install.md). GitHub release đã publish (từ `2b63a7a`). Trên npm (t-cd7f), `@anhlp/alp` là launcher, đi cùng 5 package platform (13 tarball, thứ tự ở §7.4). File thực thi trong các package platform lấy từ asset của release `v0.0.1-beta.5`, pack bằng `release:pack --binaries-release v0.0.1-beta.5` ([binary-install.md](binary-install.md#npm-packages)). **Đã thay thế:** npm không bao giờ publish beta.5; npm phát hành từ beta.6, xem dòng Beta.6 ở trên. **t-1807:** launcher và 5 package platform đã bỏ; `@anhlp/alp` là wrapper của `@anhlp/alp-cli` (8 tarball).
>
> **Beta.4 (`0.0.1-beta.4`):** phạm vi và gate ở **§13**; chưa publish.

> **Beta.3 (`0.0.1-beta.3`):** phạm vi, gate, kế hoạch publish và acceptance ở **§12**, dùng lại
> quy trình của §7 và §11.
>
> **Beta.2 (`0.0.0-beta.2`):** phạm vi, gate, kế hoạch publish và acceptance ở **§11**. §1–§10 là
> quy trình và kết quả của beta.1, giữ nguyên làm lịch sử; §11 dùng lại quy trình đó với version
> mới và ghi chỗ khác.

Đã chốt với anh ngày 2026-10-16; bổ sung các điểm review cùng ngày (§10). Tài liệu này chốt phạm vi,
gate và quy trình phát hành tay. Nó không thay cho kiểm thử trên release SHA: bằng chứng cũ (CI,
kết quả local ở các tài liệu khác) chỉ để định hướng, và chưa dòng nào trong §6 đã pass trên release
SHA vì SHA chưa chốt.

Nhãn bằng chứng:
- **[Local]** đọc từ repo (checkout có thay đổi chưa commit, 2026-10-16);
- **[Registry]** đọc từ npm registry và API lượt tải ngày 2026-10-16;
- **[Docs npm]** trích tài liệu chính thức của npm (link ở §1.3);
- **[Suy luận]** chưa kiểm chứng; phải được xác nhận ở bước ghi bên cạnh.

## 1. Version và kênh phát hành

- Bản publish đầu tiên: **`0.0.0-beta.1`**, dist-tag **`beta`**, `--access public`. Bản kế tiếp:
  `0.0.0-beta.2`, … Không publish `0.0.0-beta`.
- Mọi package dùng chung một version; dependency nội bộ pin đúng version đó.
- Tên package: root `@anhlp/alp`; các package khác `@anhlp/alp-*`; plugin là **`@anhlp/alp-paseo`**.
- Publish tay theo checklist §7. Workflow publish tự động: deferred.

### 1.1 Bản cũ trên npm

Ý định của anh: dọn các bản cũ trước khi phát hành. Phương án dự phòng: deprecate.

[Registry] Hiện trạng:

| Package | Version | `latest` | Lượt tải tuần trước | Maintainer |
|---|---|---|---|---|
| `@anhlp/alp` | 16 bản, `0.0.0-stage`, `0.3.0` … `0.10.0` | `0.10.0` | 1313 | 1 |
| `@anhlp/alp-protocol`, `-core`, `-runtime`, `-client`, `-daemon`, `-cli` | 2 bản mỗi package | `0.10.0` | API không trả số liệu | — |
| `alp-paseo-plugin` (tên plugin cũ, không scope) | 15 bản, `0.0.0-stage`, `0.1.0` … `0.10.0` | `0.10.0` | 1870 | 1 |
| `@anhlp/alp-paseo`, `@anhlp/alp-gateway` | chưa có | — | — | — |

[Registry] `@anhlp/alp@0.10.0` phụ thuộc `@anhlp/alp-core`, `-client`, `-protocol` bản `0.10.0`.

[Docs npm] Chính sách unpublish:
- Trong 72 giờ đầu sau khi publish: unpublish được, nếu không package nào trên registry công khai
  phụ thuộc vào nó.
- Sau 72 giờ: chỉ khi đủ cả ba điều kiện: không package nào trên registry phụ thuộc vào nó; dưới
  300 lượt tải trong tuần trước; một owner/maintainer.
- Version đã dùng thì không dùng lại được, kể cả sau khi unpublish.
- Unpublish hết mọi version của một package: 24 giờ sau mới publish version mới được.
- Unpublish không hoàn tác được.
- Không đủ điều kiện thì npm khuyên deprecate. Bản deprecated vẫn tải được nhưng có cảnh báo; deprecate
  cả package thì package bị bỏ khỏi kết quả tìm kiếm.

Áp vào repo này:
- `@anhlp/alp` có 1313 lượt tải tuần trước, nên **theo docs không tự unpublish được** các bản đã quá
  72 giờ.
- Các package core đang bị `@anhlp/alp@0.10.0` phụ thuộc. [Suy luận] Còn bản cũ của `@anhlp/alp` thì
  core cũng không tự unpublish được. Docs không nói rõ "phụ thuộc" tính theo mọi version hay version
  nào.
- Nếu unpublish trọn một tên, phải chờ 24 giờ trước khi publish `0.0.0-beta.1` cho tên đó (P4).
- Docs trang unpublish không nói dist-tag (`latest`) thay đổi thế nào sau unpublish.

Phương án deprecate cho các bản cũ không xóa được (`latest` chuyển sang beta theo D2, §1.2).
**Đã chạy (T7) ngày 2026-10-16, sau Q4**, đúng các lệnh dưới (16 lệnh, exit 0; kết quả §6.4):

```sh
# [Docs npm] Range có gồm cả prerelease (1.x gồm 1.0.0-beta.0), nên KHÔNG dùng range kiểu "<=0.10.0"
# vì nó có thể gồm 0.0.0-beta.1. Liệt kê rõ các bản cũ:
M="Bản cũ. Cài bản beta: npm install -g @anhlp/alp@beta"
npm deprecate "@anhlp/alp@>=0.3.0 <=0.10.0" "$M"
npm deprecate "@anhlp/alp@0.0.0-stage"      "$M"
# 6 package core (protocol, core, runtime, client, daemon, cli): đúng hai bản cũ mỗi package
npm deprecate "@anhlp/alp-<pkg>@0.0.0-stage" "$M"
npm deprecate "@anhlp/alp-<pkg>@0.10.0"      "$M"
# Bản giữ chỗ registry tạo khi publish tên mới (§6.4); anh duyệt thêm lúc chạy T7:
npm deprecate "@anhlp/alp-paseo@0.0.0-stage" "Bản giữ chỗ. Cài: npm install -g @anhlp/alp-paseo@beta"
# Tên plugin cũ không có bản beta nào, nên deprecate cả package (bị bỏ khỏi kết quả tìm kiếm).
# Thông điệp dùng cách cài theo đường dẫn vì `paseo plugin add npm:` hỏng ở beta.1 (#111):
npm deprecate alp-paseo-plugin 'Đổi tên thành @anhlp/alp-paseo. Cài: paseo plugin remove alp-provider; npm install -g @anhlp/alp-paseo@beta; paseo plugin add "$(npm root -g)/@anhlp/alp-paseo" (xem github.com/phucanh08/alp/issues/111)'
# Sau khi publish 0.0.0-beta.2 (đã sửa #111), đổi thông điệp sang lệnh cài chuẩn:
npm deprecate alp-paseo-plugin 'Đổi tên thành @anhlp/alp-paseo. Cài: paseo plugin remove alp-provider; paseo plugin add npm:@anhlp/alp-paseo@beta'
```

[Registry] `alp-paseo-plugin` có 1870 lượt tải tuần trước, nên theo docs cũng không tự unpublish
được. Người dùng cũ chạy `paseo plugin add npm:alp-paseo-plugin` hoặc `npm i -g alp-paseo-plugin`
vẫn nhận `0.10.0`. Hướng dẫn nâng cấp nằm trong docs của T5.

Trước khi chạy, với từng package, đối chiếu `npm view <pkg> versions --json` để bảo đảm spec chỉ
khớp các bản cũ, không khớp `0.0.0-beta.1`. Bỏ deprecate nhầm: `npm deprecate <pkg>@<version> ""`
[Docs npm].

### 1.2 Tag `beta` và `latest`

- [Docs npm] Publish đặt `latest` cho version vừa publish, trừ khi dùng `--tag`.
- [Docs npm] `npm install <pkg>` không có `@version`/`@tag` sẽ cài bản `latest`. Ngoài `latest`, npm
  không gán ý nghĩa đặc biệt cho tag nào.
- [Docs npm] Tag là chuỗi hiểu được như semver range sẽ bị từ chối; `beta` hợp lệ.
- Hệ quả: nếu các bản cũ còn và vẫn mang `latest`, thì `npm install -g @anhlp/alp` (không `@beta`)
  cài `0.10.0`. Mọi docs và release notes vẫn ghi `@beta`.
- **Đã chốt (D2):** chuyển `latest` của cả 8 package sang `0.0.0-beta.1`, để lệnh cài không tag cũng
  ra bản beta. Chỉ làm sau khi Q1–Q3 (§7.5) pass, bằng bước Q4. Nếu registry đã tự gán `latest`
  cho bản beta, bước đó chỉ là kiểm lại.
- **Đã rõ ở Q1** (docs không nói): khi một tên chưa có `latest` (tên mới như `@anhlp/alp-paseo`)
  mà publish lần đầu chỉ với `--tag beta`, registry **có** tự gán `latest`. [Registry]
  `@anhlp/alp-paseo` có `latest` = `beta` = `0.0.0-beta.1` ngay sau publish, kèm một bản giữ chỗ
  `0.0.0-stage` (§6.4). Các tên đã có `latest` thì giữ nguyên (`0.10.0`) cho tới Q4. Trường hợp tên
  vừa unpublish hết không được thử.
- **Q4 đã chạy** ngày 2026-10-16: `latest` = `beta` = `0.0.0-beta.1` cho cả 8 package.

### 1.3 Nguồn

- <https://docs.npmjs.com/policies/unpublish>
- <https://docs.npmjs.com/cli/v11/commands/npm-dist-tag>
- <https://docs.npmjs.com/cli/v11/commands/npm-publish>
- <https://docs.npmjs.com/cli/v11/commands/npm-deprecate>

## 2. Package phát hành

| Package | Beta | Ghi chú |
|---|---|---|
| `@anhlp/alp` | Phát hành | Từ t-1807 là wrapper mỏng (`npm/alp`: chỉ `bin/alp.js`, không postinstall), phụ thuộc đúng `@anhlp/alp-cli` cùng version và chạy CLI đó trên Node của người dùng; 5 package platform `@anhlp/alp-<os>-<arch>` của t-cd7f đã bỏ. Không chứa Paseo ([binary-install.md](binary-install.md#npm-packages)). Repo root là package private `alp-monorepo` |
| `@anhlp/alp-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-linux-arm64` (glibc), `-win32-x64` | **Đã bỏ** (t-1807) | Từng là package chứa file thực thi một file (t-cd7f); không phát hành nữa |
| `@anhlp/alp-protocol`, `-core`, `-runtime`, `-client`, `-daemon`, `-cli` | Phát hành (bắt buộc) | Vẫn là package JS; plugin pin đúng version. `-cli` mang `alp web` (`dist/alp-web.js`, `dist/alp-web/`, `THIRD-PARTY-NOTICES.txt`) |
| `@anhlp/alp-paseo` | Phát hành | plugin Paseo, web của Paseo (bản fork, Apache-2.0; tới `0.0.1-beta.3` là `alp web`), `alp-paseo-integration` (`alp-web-integration` là alias trong một bản phát hành) |
| `@anhlp/alp-gateway` | **Không phát hành** (deferred) | workspace private (`apps/gateway`); từ bản sau `0.0.1-beta.3` được bundle vào `dist/alp-web.js` của CLI, nên không thêm tarball nào |
| `@anhlp/alp-web` (`apps/web`) | Không phát hành riêng | private; từ bản sau `0.0.1-beta.3`, bản build nằm trong CLI và mở bằng `alp web` ([web.md](web.md) §3.1) |
| `@anhlp/alp-tui` | Không phát hành | private, rỗng |

Thứ tự publish: protocol → core → runtime → client → daemon → cli → plugin → `@anhlp/alp` (wrapper, cuối cùng) (§7.4). Tổng cộng 8 tarball (t-1807 bỏ 5 package platform).

## 3. Nền tảng

| | Supported | Experimental | Không hỗ trợ |
|---|---|---|---|
| OS | macOS (nền tảng test chính, D7), Linux (CI hermetic và fake; provider thật khi có thể) | Windows: CLI và alpd cục bộ; không có `alp daemon install`; CI chỉ chạy subset daemon/IPC và fake; test thật khi có thể | — |
| Node | 22.12+, 24 | 26 (chỉ có bằng chứng local) | 20 (EOL 2026-04-30) |
| Provider | Codex CLI, Claude Code | ACP (OpenCode, Gemini CLI), Antigravity (full-access; read-only chỉ là lời dặn trong prompt) | — |
| Host Paseo | `>=0.11.1 <0.13.0` (0.11.x, 0.12.x; tới `0.0.0-beta.2`: `<0.12.0`) | — | 0.13 trở lên |

[Local] `engines` hiện vẫn ghi `>=20` ở mọi package; nâng lên `>=22.12` là T3, chưa làm.

## 4. Tính năng

**Included** (nằm trong acceptance gate; coverage ở §6.2):
- CLI và alpd: `init`, `update-template`, `update`, `setup`, `doctor`, `daemon start|stop|restart|status`, `run`,
  `ps`, `top`, `attach`, `send`, `questions`, `answer`, `log`, `interrupt`, `board`, `tasks`/`task`,
  `formula`, `verify`, `recall`, `pause`/`resume`, `backup`/`restore`.
- Teams Phở và Cafe, team tự định nghĩa, permission profiles và duyệt quyền (Allow once / Always
  allow / Deny), worktree và `alp_merge`, tạm dừng khi hết usage, phục hồi sau khi alpd restart
  hoặc crash.
- Plugin Paseo: provider `alp`, Tasks panel, Settings → ALP, ALP project panel, giám sát alpd.
- `alp web` cục bộ, chỉ loopback (port 7433, có token): tới `0.0.1-beta.3` là web của Paseo qua
  `alp-web-integration`; từ bản sau là service `alp-web` của CLI (app `apps/web` + gateway nhúng,
  không cần plugin).

**Experimental** (có trong docs, ghi nhãn experimental, không nằm trong gate):
- Provider ACP và Antigravity; `alp acp` cho editor.
- Relay pairing tới app Paseo trên thiết bị khác (`relay.paseo.sh`); mặc định tắt.
- Entry `@anhlp/alp-client/portable` và `/websocket` cho browser và React Native.
- `alp daemon install` (launchd, systemd).
- Windows.

**Deferred** (chưa có trong beta):
- `@anhlp/alp-gateway`, chế độ remote của plugin (`ALP_GATEWAY_URL`), mẫu Caddy/nginx.
- App web độc lập `apps/web`; TUI.
- Đọc và ghi library qua remote; git, file, terminal trong web.
- React Native trên Hermes hoặc thiết bị thật.
- Workflow publish tự động.

## 5. Giới hạn đã biết

- Bằng chứng với provider thật hiện chỉ có từ các E2E opt-in cũ, chạy trên mã nguồn trong repo chứ
  không trên tarball; gate beta dựa vào ma trận §6.1.
- [Local] Lane CI `core` và `paseo` (toàn bộ test hermetic) chạy trên Ubuntu (Node 22, 24), và từ
  D8 cả trên macOS (job `core-paseo-macos`, Node 24) cho H2. Job macOS chưa là required check của
  `main`.
- Windows: không có service; test dùng fake Codex hoặc process POSIX bị bỏ qua (ví dụ
  `test/integration/backup-restore.test.js` bỏ qua trên win32); chưa có lane chạy toàn bộ suite.
  [Local] Hai test hỏng vì môi trường Windows, không phải vì artifact:
  - `integrations/paseo/tests/panel.test.js:331` hỏng khi `TEMP` nằm dưới thư mục home có `~/.alp`
    thật (đi ngược lên thì gặp nó);
  - `integrations/paseo/tests/paseo.test.js:323` hỏng khi `TEMP=C:\Windows\TEMP` (esbuild).
- Script `release:check` không đổi và không đủ làm gate. [Local] `validate:packages` (H3) giờ chạy
  chuỗi `release-check` → `release-pack` (rehearsal, `--ignore-scripts`) → `release-consumer`. Gate
  thật dùng các lane CI, công cụ release ở §7.2 và các dòng chạy tay ở §6.
- [Local] Công cụ release (`scripts/release-*.mjs`) mới chỉ có bằng chứng rehearsal trên Windows
  (Node 26.8.1, npm 11.19.0, checkout dirty `5c474f8`, 2026-10-16), do agent release-gate chạy.
  Chưa chạy trên macOS hay Linux, trong khi máy build thật theo §7.2 là macOS hoặc Linux.
- Client SDK smoke (browser, metro, tarball) chưa vào CI.
- `npm audit` (T6, đã phân loại local). [Local] Agent T6 chạy trên Node 26.8.1/npm 11.19.0, ở
  `5c474f8` cùng checkout bẩn; đây chưa phải gate trên release SHA. Report:
  `.cache/audit-beta/REPORT.md`. Thư mục `.cache/` bị gitignore, nên phải lưu report này cùng bằng
  chứng S1 trước P5.
  - Con số 21 là tổng của cây dev gốc. Trong code chạy của 8 package: 0 critical.
  - High duy nhất gọi tới được là `linkify-it@2.2.0` trong browser bundle của `alp web` (**F3**,
    DoS phía client). Anh đã chấp nhận cho beta.1 (D5); hạn sửa trước beta.2 hoặc 2026-11-15.
  - Peer `react-native` của plugin kéo 16 high khi cài bằng npm mặc định (**F1**). Code này không
    chạy. Đề xuất đánh dấu peer là optional, chờ bạn license.
  - `ajv@8.17.1` inline trong alpd không bị ảnh hưởng, vì `$data` tắt (**F2**). Có đề xuất nâng lên
    8.20.0 cho sạch.
- Backup không giữ thread của Codex và Claude (chúng do provider giữ); restore sang máy khác không
  mang được ngữ cảnh native.
- `alp web` là web của Paseo tại commit đã pin, cộng các patch của ALP; phần Paseo có mà ALP chưa
  làm (terminal, commit/push, worktree từ app, voice…) báo "đang phát triển".
- Session chạy Claude không stream text vào Paseo hay `alp web`: mỗi message chỉ hiện khi đã xong
  (`claude-transport.ts` đặt `includePartialMessages: false`). Codex stream bình thường; Stop vẫn
  chạy. Tìm ra ở R5 W3; anh chấp nhận là known issue cho beta.1 (2026-10-16), sửa ở bản sau
  ([#107](https://github.com/phucanh08/alp/issues/107), T13).
- [Local] Một số E2E opt-in mặc định model `codex:gpt-5.6-sol` (`test/e2e/worktree-e2e.mjs:11`); khi
  chạy cho gate, đặt `ALP_TEST_MODEL` rõ ràng theo catalog hiện tại.

## 6. Acceptance

Mọi dòng chạy trên **cùng release SHA** và, với các dòng cài đặt, trên **đúng các tarball đã lưu** (8 tarball từ t-1807 — beta.5 không lên npm; mỗi máy cài cả 8)
(§7.2). Ghi SHA, link CI, SHA-256 tarball đã dùng và kết quả vào bảng §6.4.

### 6.1 Pre-publish gate

**CI và hermetic** (gate cho mã nguồn ở release SHA, không cho tarball):

| # | Kiểm tra | Môi trường | Người chạy | Chặn |
|---|---|---|---|---|
| H1 | CI `core` và `paseo` (`validate:core`, `validate:paseo`) | Ubuntu, Node 22 và 24 | CI | Có |
| H2 | `npm run validate:core` và `npm run validate:paseo` tại release SHA | macOS, Node 24 (CI `core-paseo-macos`, D8) | CI | Có; evidence là link run CI ở release SHA |
| H3 | CI `packages-and-web` (`validate:packages`; đến t-55ce.3 còn `web-app-smoke`, đã gỡ cùng web của Paseo) | Ubuntu, Node 22 | CI | Có |
| H4 | CI `windows-daemon` | Windows, Node 22 và 24 | CI | Có (giữ lane xanh) |
| H5 | CI `alp-web` | Ubuntu, macOS | CI | Không (app chưa phát hành) |
| L1 | License, trường `license`, metadata repo trỏ `phucanh08/alp` | — | task T4 | Có |
| S1 | Phân loại `npm audit` mức high/critical trong dependency runtime của 8 package | — | task T6 | Có |

**Artifact** (trên các tarball đã lưu, 8 tarball từ t-1807 — beta.5 không lên npm):

| # | Kiểm tra | Môi trường | Người chạy | Chặn |
|---|---|---|---|---|
| A5 | `npm run release:verify -- "$OUT" --sha "$RELEASE_SHA" --record release-evidence.json` (`release:pack` cũng tự chạy A5). Kiểm: checksum khớp `SHA256SUMS`; đúng 8 tarball, không có tgz thừa (gateway); version `0.0.0-beta.1`; `entryCount` khớp số file trong tgz; dependency nội bộ trong `package.json` **đã pack** pin đúng version và chỉ trỏ tới 8 package; LICENSE mọi tarball giống tarball root; NOTICE; THIRD-PARTY-NOTICES liệt kê mọi module esbuild đã inline; plugin có `LICENSE.paseo.txt` (đến t-55ce.3: `web-app/LICENSE.paseo.txt` và `NOTICE.txt` của web Paseo, đã gỡ), và NOTICE = NOTICE root + Paseo; core không có đường dẫn hay dependency Paseo | máy build | người build (§7.2) | Có |

**Provider thật trên tarball** (checklist §6.3). Đề xuất chia Node để cả hai major đều có smoke thật:
macOS Node 24, Linux Node 22.12+.

| # | OS | Provider | Phạm vi | Người chạy | Chặn |
|---|---|---|---|---|---|
| R1 | macOS | Codex | CLI/alpd: C1–C9 | anh | Có |
| R2 | macOS | Claude Code | CLI/alpd: C1–C9 | anh | Có |
| R3 | Linux | Codex | CLI/alpd: C1–C9 | anh, khi có thể (D7) | Không (D7) |
| R4 | Linux | Claude Code | CLI/alpd: C1–C9 | anh, khi có thể (D7) | Không (D7) |
| R5 | macOS | Codex và Claude (mỗi provider một session) | plugin trong Paseo 0.11.x, `alp web` loopback: W1–W6 | anh | Có |
| R6 | Linux | Codex hoặc Claude | plugin trên Paseo 0.11.x, `alp web` loopback: W1–W6 (D4: anh đã xác nhận Paseo chạy được trên Linux) | anh, khi có thể (D7) | Không (D7) |
| R7 | macOS và Linux | Codex và Claude | worktree/merge thật: `test/e2e/worktree-e2e.mjs` tại release SHA (mã nguồn, không phải tarball) | anh (macOS chặn; Linux khi có thể, D7) | Có (phần macOS) |

### 6.2 Coverage của các tính năng Included được review

"Có test" nghĩa là test tồn tại trong repo [Local]. "Pass trên release SHA": **chưa** cho mọi dòng
(SHA chưa chốt); test hermetic được tính khi H1/H2 xanh, bước thật khi R1–R7 pass.

| Tính năng | Test tự động, fake provider (hermetic) | Provider thật đã có | Bước nghiệm thu bổ sung | Còn thiếu, việc phải bổ sung |
|---|---|---|---|---|
| **Duyệt quyền** (permission profile hỏi user: Allow once / Always allow / Deny, qua `alp answer` hoặc Paseo) | `test/integration/permissions.test.js`: `:102` Codex hỏi ALP trước khi ra khỏi sandbox; `:191` Claude hỏi cho rule `ask` và cho việc mode read-only từ chối; `:213` user trả lời, Always allow ghi rule và thôi hỏi; `:320` Always allow ghi vào đúng file định nghĩa profile; `:285` câu hỏi và câu trả lời tiếng Việt. Paseo (T10, chưa commit): `integrations/paseo/tests/permissions.test.js:58` câu hỏi quyền là question card, Allow once / Always allow / Deny (Codex `requestApproval`, Claude `canUseTool`) về đúng request, Always allow ghi `Bash(npm install *)`, rule `ask` chỉ có hai lựa chọn; `:116` đóng card, trả lời rỗng, trả lời câu đã xử lý, Stop khi card đang chờ đều để request bị từ chối; `:154` Always allow còn hiệu lực với provider/runtime mới; `integrations/paseo/tests/bridge-socket.test.js:271` cùng luồng qua socket của Paseo bridge. Lane: `validate:paseo` (H1, H2) | Chưa có. `test/e2e/human-e2e.mjs` chỉ trả lời câu hỏi `alp_ask`, không phải câu hỏi quyền | C6 (CLI), W4 (Paseo) | (1) Test Paseo đã có (T10). [Local] Pass 17/17 trên Windows, Node 26.8.1, checkout bẩn; chưa pass trên release SHA. (2) Chưa có E2E thật; C6 và W4 là bằng chứng tối thiểu |
| **Hủy / interrupt** (`alp interrupt`, Ctrl-C ở `alp run`, Stop trong Paseo) | `packages/runtime/tests/runtime.test.js:150` interrupt đóng subtree; `packages/daemon/tests/persistence.test.js:267` race giữa interrupt và prompt; `packages/daemon/tests/crash-recovery.test.js:187` provider chết giữa turn; `packages/runtime/tests/pause.test.js:222` `alp_cancel` một assignment đang park; `integrations/paseo/tests/team.test.js:118,:300,:559,:574` interrupt cả cây và peer; `integrations/paseo/tests/paseo.test.js:131` vòng đời có cancel | `test/e2e/runtime-e2e.mjs` (Codex, `session.interrupt` qua kết nối provider) | C5 (CLI), W3 (Paseo) | Không có E2E thật cho `alp interrupt`/Ctrl-C hay cho Claude; C5 và W3 phủ phần này |
| **Restore từ backup** (`alp backup`, `alp restore`) | `packages/core/tests/backup.test.js:72` restore đúng session, task, settings và hoàn tác được; `:159` restore hỏng giữa chừng được rollback; `:186`; `:197` state mới hơn không bị ghi đè; `:335`; `test/integration/backup-restore.test.js:103,:153,:176,:207` qua alpd (bỏ qua trên Windows) | Không áp dụng trực tiếp: restore không gọi provider; phần cần provider là session chạy tiếp sau restore | C8, C9 | Chưa có test trên package đã cài từ tarball; C8–C9 phủ. Không cần test mới nếu C8–C9 pass |
| **Worktree và `alp_merge`** | `packages/runtime/tests/worktree.test.js:84` peer ghi song song trong worktree và merge; `:126` conflict có marker, giữ branch, discard; `:183` việc chưa merge còn trên branch sau khi đóng hoặc crash; `:204` ngoài git báo lỗi rõ; `test/integration/verify.test.js:160,:204` `alp_merge` chạy verify trước; `packages/daemon/tests/recovery.test.js:79` assignment worktree sống qua restart alpd; `test/integration/hooks.test.js:160` hook chặn merge | `test/e2e/worktree-e2e.mjs`: mặc định Codex, chạy CLI từ mã nguồn repo | R7, C7 | Chưa có bằng chứng thật cho Claude và trên tarball. R7 chạy E2E có sẵn với cả hai provider; C7 là bước tay trên tarball |

### 6.3 Checklist provider thật

**Linux trên WSL2** (khi không có máy Linux riêng; D1):
- PowerShell: `wsl --install -d Ubuntu-24.04`. Các distro `docker-desktop*` có sẵn trong `wsl -l`
  không dùng được cho việc này.
- Trong Ubuntu:
  - cài git và Node 22.12+ (ví dụ qua nvm);
  - cài và đăng nhập Codex CLI và Claude Code, Paseo 0.11.x;
  - làm việc trong `~` của Linux, không trong `/mnt/c`, để tránh lỗi quyền và lỗi socket.
- WSL2 mặc định đẩy cổng `localhost` sang Windows: W6 mở `alp web` bằng trình duyệt Windows ở đúng
  địa chỉ `alp web --print` in ra. [Suy luận] Nếu không mở được, mở trình duyệt ngay trong WSL.
- [Suy luận] Sandbox của Claude (bước C6) cần `bubblewrap` trên Linux. Nếu C6 báo thiếu sandbox,
  chạy `sudo apt install bubblewrap socat`, ghi lại, rồi chạy lại.

**Chuẩn bị** (mỗi máy R1–R6):
- Node đúng dòng §6.1 (`node -v`, `npm -v` ghi lại). Codex và/hoặc Claude Code đã đăng nhập.
- Nếu đang điều khiển release từ ALP chạy trong Paseo, giữ nguyên daemon/session điều khiển.
  Mở terminal riêng cho acceptance, dùng **cả `PASEO_HOME` mới và `ALP_HOME` mới, tách nhau**;
  chỉ đổi `PASEO_HOME` vẫn có thể trỏ plugin về alpd đang điều khiển release. Không dừng/copy
  home mặc định để chuẩn bị gate. User OS riêng cũng phải dùng các home dành riêng cho lần chạy.
- Chép nguyên thư mục `$OUT` của §7.2 (8 tarball, `SHA256SUMS`, `release-manifest.json`) sang
  `/tmp/alp-beta/packs`, rồi kiểm: `shasum -a 256 -c SHA256SUMS` (macOS) hoặc `sha256sum -c SHA256SUMS`
  (Linux).
- Kiểm hermetic, không gọi provider, trong một checkout ở `RELEASE_SHA`:
  `npm run release:consumer -- /tmp/alp-beta/packs`. Script cài đúng các tarball đã lưu (cả 8), so
  `integrity`/`resolved` (`file:`) trong lockfile với manifest, chạy `tarball-consumer` và
  `package-smoke` với `--packs`, rồi kiểm lại SHA-256 sau khi chạy. Bước này không thay các dòng R.

**Paseo riêng cho release đang được ALP/Paseo điều khiển (R5/R6):**

Sau khi cài tarball và đặt PATH tới consumer ở dưới, tạo một lần trong terminal acceptance:

```sh
RUN_ROOT=$(mktemp -d /tmp/alp-beta-hosted.XXXXXX)
export PASEO_HOME="$RUN_ROOT/paseo" ALP_HOME="$RUN_ROOT/alp"
mkdir -m 700 "$PASEO_HOME" "$ALP_HOME"
WEB_PORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
printf '{"web":{"port":%s,"relay":{"enabled":false}}}\n' "${WEB_PORT:?không lấy được cổng trống}" > "$ALP_HOME/settings.json"
paseo daemon run --help
paseo daemon config set --help
paseo plugin --help
paseo daemon config set daemon.listen 127.0.0.1:6868 --string --home "$PASEO_HOME"
paseo daemon config set daemon.relay.enabled false --home "$PASEO_HOME"
paseo daemon config set pluginsEnabled true --home "$PASEO_HOME"
paseo daemon run --home "$PASEO_HOME" > "$RUN_ROOT/paseo.log" 2>&1 &
PASEO_PID=$!
```

- Chọn cổng loopback còn trống thay cho `6868` nếu cần; không dùng cổng của Paseo điều khiển.
  `WEB_PORT` là cổng loopback còn trống lúc tạo (`web.port` chỉ nhận 1024–65535, không nhận `0`),
  cấp cổng web riêng. Kiểm đường dẫn home, log, lock và cổng trước khi chạy R5/R6;
  trong app thêm host `127.0.0.1:6868` của daemon thử nghiệm.
- [Local] Paseo 0.11.x `daemon run --help` có `--home`, `daemon config set --help` có
  `--home`/`--string`, `plugin --help` có `--home` và alias `install|add`. Cổng đặt qua
  `daemon.listen` trong config, không giả định `daemon run --port` tồn tại. Kiểm lại help của
  binary đang dùng; source CLI chọn `PASEO_HOME` khi không có `--home`/`--host`.
- Chạy harness trong cùng terminal, cùng hai biến home; các lệnh plugin tay thêm
  `--home "$PASEO_HOME"`. Không để `PASEO_HOST` kế thừa chọn daemon khác; bỏ biến đó trong
  terminal acceptance trước khi chạy harness. Không đổi môi trường của session điều khiển.
- Live harness giữ daemon/plugin để người chạy hoàn tất bước manual. Khi xong, đóng session thử,
  gỡ plugin bằng `paseo plugin remove alp-provider --home "$PASEO_HOME"`, dừng và chờ PID
  `$PASEO_PID` do terminal này tạo. Nếu có alp-web (`web.json`, `integrations/web.lock`) hoặc
  integration Paseo riêng (`paseo.json`, `integrations/paseo.lock`), ghi PID từ các file đó
  **của `ALP_HOME` mới này**, dừng/chờ chúng trước, rồi
  `alp daemon stop` với đúng `ALP_HOME`; xác nhận các PID đã hết trước khi xóa fixture.
  Giữ lại log/evidence. Không dùng PID lịch sử, `pkill`, `killall`, hoặc xóa home/worktree người dùng.

**Harness (tùy chọn, chưa commit; agent T10):** chạy các bước C1–C9, W1–W6 và R7 bằng script, trên
đúng thư mục đã lưu (`PACKS=/tmp/alp-release/v0.0.0-beta.1`, không pack lại):

| Dòng | Lệnh |
|---|---|
| R1 (macOS), R3 (Linux) | `node scripts/beta-acceptance-cli.mjs --packs "$PACKS" --live --provider codex` |
| R2 (macOS), R4 (Linux) | `node scripts/beta-acceptance-cli.mjs --packs "$PACKS" --live --provider claude` |
| R5 (macOS), R6 (Linux) | `ALP_HOME=<home mà Paseo dùng> node scripts/beta-acceptance-web.mjs --packs "$PACKS" --live --provider codex` (chạy lại với `claude` cho R5) |
| R7 | `node scripts/beta-acceptance-r7.mjs --live --sha "$RELEASE_SHA" --model codex:<m> --model claude:<m>`, sau `npm ci && npm run build` ở release SHA |
| Rehearsal, không phải evidence | thay `--live --provider …` bằng `--fake [--provider codex\|claude]` (fake Codex hoặc fake Claude của repo); row luôn có status `rehearsal` |
| CI (D6, D7): pack, `release:consumer`, rehearsal fake trên macOS, Linux, Windows | workflow `release-acceptance` (`workflow_dispatch`: `sha`, `packs_run`); xem dưới |

- Tùy chọn:
  - `--work DIR` (mặc định `$TMPDIR/alp-beta`);
  - `--runner NAME`;
  - `--rehearsal`: nhận thư mục pack từ checkout bẩn; kết quả không bao giờ là evidence;
  - `ALP_ACCEPT_TIMEOUT_MS`: thời gian chờ mỗi lần `alp run`, mặc định 20 phút.
- Kết quả:
  - mỗi bước in `PASS`, `FAIL`, `CHECK`, `SKIP` hoặc `TODO`;
  - `CHECK` là bước cần người đọc kết quả (C5, C6, C8 khi live); terminal hỏi y/n;
  - cuối mỗi lần chạy có `results-<run>.json` và `logs/<run>/`; `results-<run>.json` chứa fragment
    `rows` đúng shape evidence của `release:gate` (§6.4).
- Home của ALP:
  - CLI dùng `ALP_HOME` mới dưới `--work`, không chạm `~/.alp`;
  - web `--live` dùng `ALP_HOME` của Paseo. Nếu đó là `~/.alp`, script từ chối, trừ khi thêm
    `--use-default-home` (chỉ dùng sau khi đã dừng alpd và sao lưu);
  - gỡ plugin sau khi chạy: `paseo plugin remove alp-provider --home "$PASEO_HOME"`;
    dọn theo thứ tự và quyền sở hữu trong hướng dẫn hosted ở trên. Fake harness tự dừng/chờ
    integration trước alpd, cả khi setup hay W6 lỗi; live vẫn cần người chạy dọn sau bước manual.
- [Local] Rehearsal `--fake` trên artifact rehearsal (`5c474f8`, checkout bẩn), Windows, Node 26.8.1:
  - CLI: 8 pass; C6, C7 skip vì cần model thật; Ctrl-C không thử trên Windows;
  - web: W6 pass.
- `--unattended` (chỉ với `--live`, cho lần chạy không có người ngồi): C5, C6, C8 được chấm bằng quy tắc ghi kèm trong
  kết quả (C5: câu trả lời có số và `alp ps` không còn dòng `running`; C6: câu trả lời sau Deny nói bị
  từ chối; C8: nhắc lại ít nhất một tên file mà C4 đã nêu). Bước không thỏa quy tắc vẫn là `check`,
  dòng R vẫn `pending` cho tới khi người đọc kết quả. `--evidence URL` ghi link (ví dụ run CI) vào row.
- Exit code: 0 xong (live: pass), 1 có bước fail, 3 live nhưng dòng còn `pending`.
- Workflow `release-acceptance` (D6, D7). Chỉ dùng fake: không secret, không tốn tiền, không gọi
  provider thật; kết quả luôn là rehearsal, không phải evidence cho R1–R7.
  - job `pack`: clone ở `sha` (phải nằm trên `main`), tạo tag `v0.0.0-beta.1` **chỉ trên runner**
    (không push; anh push tag ở P5), `npm ci`, `build:web`, `build:packages`, `release:pack`,
    `release:verify --sha`; upload artifact `alp-release` (90 ngày). Đây là bộ tarball duy nhất của
    release; R1, R2, R5 trên macOS tải đúng artifact này (`gh run download <run> -n alp-release`).
  - `packs_run`: dùng lại artifact của một run trước, không pack lại.
  - job `acceptance`, ma trận macOS, Ubuntu, Windows: `release:consumer`, CLI C1–C9 với fake Codex
    và với fake Claude (`packages/daemon/tests/support/fake-claude.js`), W6 (token gate của
    `alp web`). Kết quả của macOS quyết định run đỏ hay xanh; Ubuntu và Windows chạy
    `continue-on-error` (D7), lỗi ở đó được báo nhưng không chặn.
  - Kết quả và log là artifact `acceptance-fake-<os>`.
- Harness thay việc gõ tay nhưng không thay tiêu chí: một dòng R chỉ pass khi mọi bước pass, kể cả
  các bước `CHECK` đã được người chạy xác nhận.

**Cài từ tarball** (khi chạy tay):

```sh
mkdir -p /tmp/alp-beta/consumer && cd /tmp/alp-beta/consumer && npm init -y
npm install --save-exact /tmp/alp-beta/packs/*.tgz
export PATH="$PWD/node_modules/.bin:$PATH"
npm ls @anhlp/alp @anhlp/alp-paseo          # 0.0.0-beta.1, không có bản 0.10.0
mkdir -p /tmp/alp-beta/project && cd /tmp/alp-beta/project && git init -b main
git commit --allow-empty -m init
```

**CLI và alpd, mỗi provider** (`P` là `codex` hoặc `claude`):

| Bước | Lệnh | Mong đợi |
|---|---|---|
| C1 | `alp doctor` | provider `P` được nhận; không có lỗi chặn |
| C2 | `alp daemon start && alp daemon status --json` | alpd chạy, đúng version |
| C3 | `alp init && alp setup --runtime P` | `.alp/settings.json` có team Phở và Cafe |
| C4 | `alp run --team pho "Đọc thư mục này và trả lời nó có những file nào. Không sửa gì."` rồi `alp ps --all` | stream câu trả lời, kết thúc không lỗi; session có trong danh sách |
| C5 | `alp run --team pho "Đếm chậm từ 1 tới 200, mỗi số một dòng."`; giữa chừng chạy `alp interrupt <session>` ở terminal khác, sau đó lặp lại bằng Ctrl-C | turn dừng, ghi là interrupted/canceled; `alp ps` không còn turn chạy; `alp send <session> "Bạn đã dừng ở số mấy?"` chạy được |
| C6 | Thêm vào `.alp/settings.json`: `"permissions": { "profiles": { "review": { "base": "read-only", "ask": ["Bash(touch *)"], "beyondMode": "ask" } }, "agents": { "main": "review" } }`. Ba lần chạy, mỗi lần xem `alp questions` rồi `alp answer <id> "<lựa chọn>"`: (1) `alp run --team pho "Chạy đúng lệnh: touch c6-once.txt"` → Allow once; (2) `… "touch c6-deny.txt"` → Deny; (3) `… "mkdir -p c6-always"` (vượt mode, không có rule) → Always allow, rồi chạy lại đúng lệnh đó | (1) hai lựa chọn (Allow once / Deny), `c6-once.txt` có; (2) `c6-deny.txt` không có, agent báo bị từ chối; (3) ba lựa chọn, profile `review` có thêm rule `Bash(mkdir …)`, lần chạy lại không hỏi. Ngôn ngữ mặc định là tiếng Việt: lựa chọn hiện là "Cho phép lần này / Luôn cho phép / Từ chối" |
| C7 | `alp run --team pho "Giao hai peer ghi song song, mỗi peer trong worktree riêng: peer 1 tạo a.txt chứa A, peer 2 tạo b.txt chứa B; rồi merge cả hai bằng alp_merge."` | `alp log <session>` có hai worktree và hai merge; `a.txt`, `b.txt` có trong checkout; `git worktree list` không còn worktree thừa |
| C8 | `alp daemon restart`, rồi `alp send <session của C4> "Nhắc lại câu trả lời trước trong một dòng."` | session chạy tiếp, nhớ ngữ cảnh |
| C9 | `alp backup --stop`, `alp backup verify <file>`; `alp restore <file> --stop --dry-run`; rồi đặt `ALP_HOME` sang thư mục mới trống, `alp restore <file> --stop`, `alp daemon start`, `alp ps --all`, `alp tasks` | verify qua; dry-run không đổi gì; sau restore thấy lại các session và task; `alp send` vào một session đã restore chạy được trên cùng máy |

Về C6:
- [Local] `alp answer` nhận cả chữ tiếng Anh lẫn tiếng Việt của lựa chọn
  (`test/integration/permissions.test.js:213,:285`).
- [Suy luận từ code, chưa thử với provider thật] Profile dùng `touch` chứ không dùng `git status`.
  Với base read-only, Codex chạy với `approvalPolicy: on-request`. Lệnh chạy được trong sandbox
  read-only (như `git status`) có thể không bao giờ xin phép, mà ALP chỉ hỏi user khi Codex gửi
  `requestApproval` (`packages/runtime/src/session-config.ts:27-36`).

Sau mỗi máy: `~/.alp/logs/alpd.log` (hoặc `$ALP_HOME/logs/alpd.log`) không có lỗi chưa giải thích.
Ghi lại các session id và kết quả vào §6.4.

**Plugin và `alp web`** (R5, R6):

| Bước | Lệnh / thao tác | Mong đợi |
|---|---|---|
| W1 | `alp daemon start`; `paseo plugin add "/tmp/alp-beta/consumer/node_modules/@anhlp/alp-paseo"` (đường dẫn tuyệt đối) | thêm được plugin |
| W2 | `paseo plugin ls`; `paseo provider models alp` | `alp-provider` đang chạy; có Phở và Cafe |
| W3 | Trong Paseo: tạo session ALP · Phở ở `/tmp/alp-beta/project`, gửi prompt dài, bấm Stop | stream; Stop dừng turn; prompt tiếp theo chạy được |
| W4 | Dùng profile ở C6; trong Paseo gửi "Chạy đúng lệnh: touch w4-once.txt" → Allow once, rồi "touch w4-deny.txt" → Deny | câu hỏi quyền hiện thành question card trong Paseo; `w4-once.txt` có, `w4-deny.txt` không có |
| W5 | Tasks panel: thêm, đóng, mở lại một task | `.alp/tasks` đổi đúng; panel làm mới |
| W6 | `alp web --print` (service `alp-web`, không cần plugin); mở địa chỉ trên máy đó (Linux headless: `ssh -L <port>:127.0.0.1:<port> <host>`, mở trên máy mình) | in `http://127.0.0.1:<port>/#token=alpgw1.…`; `GET /` trả app; `POST /v1/tickets` trả 401 khi không có token hoặc token sai, 201 với token đã in (`scripts/beta-acceptance-web.mjs`); trên trình duyệt thấy project và session của W3, hỏi đáp và Tasks hoạt động |

[Suy luận] Hai điểm chưa được thử: thêm plugin từ `node_modules` của project consumer (để các
dependency `@anhlp/*` chưa publish được tìm thấy), và `alp web` qua SSH tunnel (host header vẫn là
`127.0.0.1`). Nếu W1 thất bại, ghi lỗi và thử cách cài của `scripts/tarball-consumer.mjs`. Nếu W6 qua
tunnel thất bại, mở trình duyệt ngay trên máy Linux.

**Worktree thật từ mã nguồn** (R7), trong checkout ở release SHA sau `npm ci && npm run build`:

```sh
ALP_TEST_MODEL=codex:<model Codex hiện tại>  node test/e2e/worktree-e2e.mjs
ALP_TEST_MODEL=claude:<model Claude hiện tại> node test/e2e/worktree-e2e.mjs
```

Mong đợi: script kết thúc mã 0; hai file của hai peer được merge vào checkout.

### 6.4 Bảng kết quả (điền khi chạy)

Có thể giữ song song bằng file evidence. Đặt file **ngoài** `$OUT`, vì `$OUT` đã khóa:

```sh
npm run release:gate -- "$OUT" --init release-evidence.json
```

- Mỗi dòng (H1–H5, L1, S1, A5, R1–R7, Q1–Q5) có `{status, sha, artifacts, environment, runner,
  evidence, date}`.
- Một dòng chỉ được tính khi đủ cả bốn điều kiện:
  - `status` là pass;
  - `sha` = `RELEASE_SHA`;
  - với A5, R1–R6, Q1–Q5: `artifacts` = `sha256sums` trong manifest;
  - có `evidence`.
- H5 không chặn.
- Các mốc chạy `npm run release:gate -- "$OUT" release-evidence.json --phase <mốc>`; lệnh phải exit 0:
  - `--phase publish`: ở P4 và P5;
  - `--phase latest` (pre-publish và Q1–Q3): trước Q4 (D2);
  - `--phase announce` (tới Q5): trước khi bỏ draft GitHub release.

| # | SHA | Tarball SHA-256 khớp | Máy, OS, Node | Kết quả | Bằng chứng (link CI, log, session id) |
|---|---|---|---|---|---|
| H1–H4 | `2230aa5` | — | CI: Ubuntu Node 22/24 (H1, H3), macOS Node 24 (H2, `core-paseo-macos`), Windows Node 22/24 (H4) | pass | [CI 38901104491](https://github.com/phucanh08/alp/actions/runs/38901104491) |
| H5 | `2230aa5` | — | CI: Ubuntu, macOS | pass (không chặn) | [CI 38901104491](https://github.com/phucanh08/alp/actions/runs/38901104491) |
| L1 | `2230aa5` | — | macOS | pass | manifest và license không đổi từ `6765826`; `release:check-version`; LICENSE/NOTICE trong tarball do A5 kiểm |
| S1 | `2230aa5` | khớp (audit consumer trên 8 tarball) | macOS arm64, Node 24.22.0, bật kiểm TLS | pass; F3 chấp nhận theo D5 | lockfile không đổi; `--omit=dev` 0; consumer 0/0 (146/131 package); ajv 8.20.0 inline |
| A5 | `2230aa5` | `SHA256SUMS` = `523cf5cc…b81c` | pack: [release-acceptance 38901108957](https://github.com/phucanh08/alp/actions/runs/38901108957), Ubuntu Node 22; verify lại: macOS Node 24.22.0 | pass | `release:pack` + `release:verify` trên runner; `release:verify --record` và `release:consumer` trên Mac |
| R1 | `2230aa5` | khớp | macOS 27 arm64, Node 24.22.0, Codex CLI 0.162.1, `gpt-6.1-sol` | pass (C5 anh xác nhận) | `--unattended`; C5: bị ngắt trước khi có output, câu trả lời đúng |
| R2 | `2230aa5` | khớp | như R1, Claude Code 2.1.300, `claude-opus-5-5` | pass 10/10 | `--unattended` |
| R5 | `2230aa5` | khớp | như R1, Paseo 0.11.4 | pass: W1–W6 (Codex, Claude); W5, W6 anh xác nhận; W3 Claude không stream: known issue #107 anh chấp nhận | harness web, W3/W4 qua API Paseo |
| R7 | `2230aa5` | — (mã nguồn) | như R1 | pass (Codex, Claude) | `beta-acceptance-r7.mjs` |
| P4 | `2230aa5` | `SHA256SUMS` = `523cf5cc…b81c` (`shasum -c` OK) | macOS arm64, Node 24.22.0, npm 11.19.1 | pass | `release:gate --phase publish` exit 0; `npm whoami` = `anhlp`; cả 8 package E404 ở `0.0.0-beta.1`; không tên nào bị unpublish |
| P5 | `2230aa5` | asset tải lại: `shasum -c` OK, giống từng byte | như P4 | **go**, anh quyết định 2026-10-16 | tag `v0.0.0-beta.1` (annotated) đã push, trỏ `2230aa5`; GitHub prerelease ở dạng draft, 8 tarball + `SHA256SUMS` + `release-manifest.json`; T7 hoãn (§10) |
| Publish (§7.4) | `2230aa5` | `shasum -c` OK trước và sau; dry-run: tên, version, tag `beta`, số file khớp manifest, không có bước build | như P4, không cần OTP | pass 8/8, 2026-10-16 | `npm publish ./<file>.tgz --tag beta --access public`, từng package một; `dist.integrity` trên registry khớp manifest cho cả 8 (bảng dưới) |
| Q1 | `2230aa5` | `SHA256SUMS` = `523cf5cc…b81c`; `dist.integrity` khớp manifest 8/8 | macOS arm64, Node 24.22.0, npm 11.19.1 | pass, 2026-10-16 14:58Z | `beta` = `0.0.0-beta.1` cả 8; `latest` trước Q4: `0.10.0` ở 7 package, `0.0.0-beta.1` ở `@anhlp/alp-paseo` (registry tự gán, §1.2) |
| Q2 | `2230aa5` | lockfile consumer: `integrity` khớp manifest 8/8, `resolved` là `registry.npmjs.org` | như Q1; HOME mới (cache rỗng), prefix `/tmp/alp-q2`; Linux không chạy (D7, máy không có Docker) | pass (macOS) | `npm install -g --prefix … @anhlp/alp@beta @anhlp/alp-paseo@beta`: 10 bản `@anhlp/*` trong cây đều `0.0.0-beta.1`; root không phụ thuộc `alp-cli` (CLI nằm trong root), nên consumer cài cả 8 tên để so lockfile |
| Q3 | `2230aa5` | bản cài của Q2 | như Q1, Codex CLI 0.162.1, Paseo 0.11.4 | pass, với known issue [#111](https://github.com/phucanh08/alp/issues/111) anh chấp nhận | C1, C2, C4 (Codex, `ALP_HOME` tạm 0700) pass. **`paseo plugin add npm:@anhlp/alp-paseo@beta` lỗi** `Could not resolve type dependency "@getpaseo/relay/e2ee"`: Paseo cài nguồn `npm:` với `--legacy-peer-deps` rồi kiểm cả import type trong `.d.ts`; `@getpaseo/*` chỉ là peer. Cách tạm `paseo plugin add "$(npm root -g)/@anhlp/alp-paseo"` (bản cài từ registry): plugin chạy, W2 có Phở và Cafe; W6: cổng token đúng (không token / sai token bị từ chối), web mở thấy project. R5 không bắt được vì W1 thêm plugin từ consumer có sẵn peer |
| Q4 | `2230aa5` | — | như Q1 | pass, 15:24Z (anh go) | `npm dist-tag add @anhlp/<pkg>@0.0.0-beta.1 latest` cho 7 package (exit 0, không cần OTP); `latest` = `beta` = `0.0.0-beta.1` cả 8 |
| Q5 | `2230aa5` | — | như Q1; HOME mới, prefix `/tmp/alp-q5` | pass | `npm install -g @anhlp/alp @anhlp/alp-paseo` không tag: mọi `@anhlp/*` là `0.0.0-beta.1` |
| T7 | — | — | như Q1 | xong, 15:27Z (anh go) | 16 lệnh §1.1, exit 0; kiểm packument: 52/52 version đúng (mọi bản cũ có `deprecated`, `0.0.0-beta.1` của cả 8 không có). Thông điệp của `alp-paseo-plugin` hiện ra sau khoảng 30 giây (cache registry) |
| Announce | `2230aa5` | asset không đổi (10 file) | — | pass | `release:gate --phase latest` và `--phase announce` exit 0; notes cập nhật (cài plugin theo đường dẫn, #111, bỏ known issue `0.10.0`); [prerelease](https://github.com/phucanh08/alp/releases/tag/v0.0.0-beta.1) bỏ draft 2026-10-16 15:30Z (anh go) |
| Ghi chú | `6765826`, `dc2621c` | — | — | bị thay | live trên hai SHA này tìm ra lỗi, sửa ở PR #105, #106; bộ tarball cũ không dùng |

Publish `0.0.0-beta.1` ngày 2026-10-16 (giờ UTC). "Registry" là `time["0.0.0-beta.1"]` trong
packument. Dist-tags đọc lúc 14:26:53Z, sau package cuối; `latest` chỉ ghi lại, không sửa (D2, Q4).

| # | Package | Lệnh publish xong | Registry | `dist.integrity` | `beta` | `latest` |
|---|---|---|---|---|---|---|
| 1 | `@anhlp/alp-protocol` | 14:02:07Z | 14:03:03Z | khớp | `0.0.0-beta.1` | `0.10.0` |
| 2 | `@anhlp/alp-core` | 14:05:49Z | 14:06:44Z | khớp | `0.0.0-beta.1` | `0.10.0` |
| 3 | `@anhlp/alp-runtime` | 14:07:12Z | 14:08:07Z | khớp | `0.0.0-beta.1` | `0.10.0` |
| 4 | `@anhlp/alp-client` | 14:08:34Z | 14:10:11Z | khớp | `0.0.0-beta.1` | `0.10.0` |
| 5 | `@anhlp/alp-daemon` | 14:10:28Z | 14:11:25Z | khớp | `0.0.0-beta.1` | `0.10.0` |
| 6 | `@anhlp/alp-cli` | 14:11:52Z | 14:12:47Z | khớp | `0.0.0-beta.1` | `0.10.0` |
| 7 | `@anhlp/alp-paseo` | 14:13:19Z | 14:24:35Z | khớp | `0.0.0-beta.1` | `0.0.0-beta.1` |
| 8 | `@anhlp/alp` | 14:25:17Z | 14:26:33Z | khớp | `0.0.0-beta.1` | `0.10.0` |

[Registry] `@anhlp/alp-paseo` là tên mới:
- lúc publish (14:13:18Z), registry tạo một bản placeholder `0.0.0-stage` ("Temporary package
  placeholder for staged publishing", 2 file) và đặt `latest` vào đó;
- `npm stage list @anhlp/alp-paseo` rỗng, tức là bản beta không bị đưa vào hàng chờ duyệt;
- `0.0.0-beta.1` hiện ra sau khoảng 11 phút, chậm hơn các package khác (khoảng 1–2 phút). Khi đó
  registry tự chuyển `latest` sang `0.0.0-beta.1`, dù publish có `--tag beta`.

Các tên cũ cũng có một bản `0.0.0-stage` từ lần publish đầu: `@anhlp/alp`, `alp-paseo-plugin` và
`@anhlp/alp-protocol`. Q1 xác nhận lại `latest` và trả lời câu "chưa rõ" ở §1.2. Mọi bản
`0.0.0-stage` đã được deprecate ở T7.

Evidence của Q1–Q5 và T7 (output lệnh, lockfile, ảnh web) nằm ngoài repo, trên máy anh:
`~/alp-release/evidence/q-2230aa5/`; các dòng đã ghi vào `release-evidence-2230aa5.json`.

## 7. Checklist publish tay

Pre-publish gate (P0–P5) phải xong và xanh trước khi bất kỳ package nào lên registry.
Post-publish acceptance (Q1–Q5) kiểm thứ đã thực sự lên registry. Các script `release:*` chỉ pack,
kiểm và đánh giá gate; chúng không publish. Automation publish vẫn deferred.

### 7.1 Chuẩn bị (pre-publish)

- **P0. Điều kiện vào:**
  - T1–T6 (§8) đã merge vào `main`;
  - `git status` sạch (không tính file của môi trường);
  - CI xanh ở commit dự kiến.

  Chốt `RELEASE_SHA=$(git rev-parse HEAD)`.
- **P1. Tag cục bộ:** `git tag -a v0.0.0-beta.1 "$RELEASE_SHA" -m "ALP 0.0.0-beta.1"`.
  - Chưa push. Nếu gate hỏng trước khi push: xóa tag cục bộ, sửa, chốt SHA mới.
  - Đã push thì không di chuyển tag.

### 7.2 Build và pack một lần

- **P2.** Build trong **clone sạch ở tag**, không dùng checkout đang làm việc (checkout có file
  untracked và cache).

```sh
git clone --branch v0.0.0-beta.1 "file://$(pwd)" /tmp/alp-release/src   # từ repo cục bộ: tag chưa push
git -C /tmp/alp-release/src rev-parse HEAD        # phải bằng RELEASE_SHA
cd /tmp/alp-release/src
node -v; npm -v                                   # ghi lại; Node 22.12+ hoặc 24
npm ci
npm run build:web
npm run build:packages
OUT=/tmp/alp-release/v0.0.0-beta.1                # thư mục mới hoặc rỗng; script không ghi vào thư mục đã có file
npm run release:pack -- --out "$OUT"
```

- `release:pack`:
  - từ chối checkout dirty hoặc commit không có tag (trừ `--rehearsal`);
  - chạy `prepack` như khi publish;
  - ghi các file `pack-*.json`, `SHA256SUMS` (định dạng `sha256sum`) và `release-manifest.json`;
  - tự chạy A5.
- **P3. Manifest phát hành** `release-manifest.json`, gồm:
  - `schema`, `version`, `distTag`;
  - `git {sha, tag, dirty}`;
  - `build {node, npm, platform, arch, os, date}`;
  - `pack {ignoreScripts, rehearsal}`;
  - `sha256sums`: SHA-256 của chính file `SHA256SUMS`;
  - `packages[]`: mỗi package có `{name, version, filename, size, sha256, integrity, shasum, entryCount}`, theo thứ tự publish.

  Kiểm: `git.sha` = `RELEASE_SHA`, `git.dirty` = false, `pack.rehearsal` = false. Sau đó khóa thư
  mục (`chmod -R a-w "$OUT"`) và lưu một bản sao ngoài máy build.
- Từ đây mọi bước gate và publish dùng **đúng các file này**. Không pack lại. Pack lại nghĩa là
  artifact mới, phải chạy lại A5 và R1–R6.

### 7.3 Gate trên artifact

- **P4.**
  - Nếu ALP/Paseo đang điều khiển release, chuẩn bị terminal và hai home riêng theo §6.3
    trước mọi acceptance có startup; giữ daemon điều khiển chạy. Build/pack dùng clone §7.2;
    R5/R6 dùng Paseo có `PASEO_HOME` riêng và alpd có `ALP_HOME` riêng, cổng riêng.
  - Chạy A5, rồi R1–R6 trên các tarball của §7.2; R7 và H2 trên `RELEASE_SHA`.
    Ghi home/log/cổng và PID do lần chạy tạo vào evidence; sau gate dọn/chờ đúng PID đó theo §6.3,
    kể cả khi fail hoặc startup lỗi. Không lấy PID từ ghi chú lịch sử làm quyền dừng process.
  - Điền §6.4. Mọi dòng "Chặn: Có" phải pass. Dòng nào TBD chưa có người chạy thì gate chưa qua.
    `npm run release:gate -- "$OUT" release-evidence.json --phase publish` phải exit 0.
  - Kiểm registry trước khi publish:
    - `npm whoami` đúng tài khoản; tài khoản là owner của scope `@anhlp`;
    - với từng package, `npm view <pkg>@0.0.0-beta.1 version` phải không có (E404);
    - nếu tên nào vừa bị unpublish hết thì đã qua 24 giờ (§1.1).
- **P5. Go/no-go:**
  - anh ghi quyết định publish vào §6.4;
  - push tag: `git push origin v0.0.0-beta.1`;
  - tạo GitHub release ở dạng **draft** (§7.6).

### 7.4 Publish

Thứ tự theo dependency: protocol → core → runtime → client → daemon → cli → plugin → `@anhlp/alp` (wrapper). Wrapper đi cuối để không bao giờ trỏ tới `@anhlp/alp-cli` chưa có trên registry. Từ t-1807 bộ release có 8 tarball (thứ tự trên trong `release-manifest.json`); 5 package platform của t-cd7f đã bỏ.

```sh
cd /tmp/alp-release/v0.0.0-beta.1
shasum -a 256 -c SHA256SUMS
for f in anhlp-alp-protocol anhlp-alp-core anhlp-alp-runtime anhlp-alp-client \
         anhlp-alp-daemon anhlp-alp-cli anhlp-alp-paseo \
         anhlp-alp; do
  npm publish "./$f-0.0.0-beta.1.tgz" --tag beta --access public --dry-run
done
```

- Đọc output của `--dry-run`: đúng tên, version, tag `beta`, số file khớp manifest.
  - [Suy luận] npm publish một tarball như nó đang có, không chạy lại `prepack`. Xác nhận bằng
    output dry-run (không có bước build).
- Rồi publish **từng package một**, đúng thứ tự, thêm `--otp <mã>` nếu tài khoản bật 2FA:

```sh
npm publish ./anhlp-alp-protocol-0.0.0-beta.1.tgz --tag beta --access public
npm view @anhlp/alp-protocol@0.0.0-beta.1 dist.integrity   # phải bằng integrity trong release-manifest.json
# … lặp lại cho core, runtime, client, daemon, cli, alp-paseo, rồi alp (wrapper)
```

- Ghi thời điểm và kết quả từng package vào §6.4.
- Dừng ngay khi một package lỗi; xem §7.7.

### 7.5 Post-publish acceptance

| # | Kiểm tra | Mong đợi |
|---|---|---|
| Q1 | Với cả 8 package: `npm view <pkg> dist-tags --json`, `npm view <pkg>@0.0.0-beta.1 dist.integrity dist.tarball` | `beta` = `0.0.0-beta.1`; integrity khớp `release-manifest.json`. Ghi giá trị `latest` của từng package trước Q4 (trả lời câu "chưa rõ" ở §1.2) |
| Q2 | Cài sạch từ registry trên macOS và Linux, HOME và `ALP_HOME` mới, prefix riêng: `npm install -g --prefix /tmp/alp-q2 @anhlp/alp@beta @anhlp/alp-paseo@beta`; `npm ls -g --prefix /tmp/alp-q2`; trong một project consumer, so `integrity` trong `package-lock.json` với manifest | toàn bộ `@anhlp/*` là `0.0.0-beta.1`; integrity khớp |
| Q3 | Smoke ngắn trên bản cài từ registry: C1, C2, C4 với một provider; `paseo plugin add npm:@anhlp/alp-paseo@beta`, W2; W6 | như §6.3 |
| Q4 | Chỉ khi Q1–Q3 pass (D2) và `release:gate … --phase latest` exit 0: với cả 8 package, `npm dist-tag add @anhlp/<pkg>@0.0.0-beta.1 latest` (thêm `--otp` nếu có 2FA), rồi `npm view @anhlp/<pkg> dist-tags --json` | `latest` = `beta` = `0.0.0-beta.1` cho cả 8 |
| Q5 | `npm install -g --prefix /tmp/alp-q5 @anhlp/alp @anhlp/alp-paseo` (không tag); `npm ls -g --prefix /tmp/alp-q5` | toàn bộ `@anhlp/*` là `0.0.0-beta.1` |

### 7.6 GitHub prerelease

- Trước khi publish (P5), tạo draft:

```sh
gh release create v0.0.0-beta.1 --verify-tag --prerelease --draft --title "ALP 0.0.0-beta.1" \
  --notes-file release-notes.md /tmp/alp-release/v0.0.0-beta.1/*.tgz \
  /tmp/alp-release/v0.0.0-beta.1/SHA256SUMS /tmp/alp-release/v0.0.0-beta.1/release-manifest.json
```

- Release notes gồm:
  - lệnh cài có `@beta`;
  - package phát hành (§2) và nền tảng (§3);
  - Included / Experimental / Deferred (§4);
  - known issues (§5, cộng mọi lỗi phát hiện ở R1–R7 được chấp nhận), trong đó có F3 (D5):
    `linkify-it@2.2.0` trong `alp web` có thể làm treo tab trình duyệt khi hiển thị một tin nhắn dài
    được tạo có chủ đích; chỉ ảnh hưởng phía client, trên loopback; sẽ sửa trước beta.2 hoặc
    2026-11-15;
  - checksum;
  - ghi chú cho người đang dùng 0.10.0. [Local] CLI 0.10.0 chưa có `alp backup`/`alp restore`
    (`git show v0.10.0:packages/cli/src/usage.js`; `docs/alp/data-recovery.md`):
    - trước khi nâng: `alp daemon stop`, rồi chép nguyên `$ALP_HOME` (mặc định `~/.alp`) ra chỗ khác;
    - sau khi cài beta: alpd tự lưu một backup `pre-migrate-v1-v2-*` khi migrate schema 1 → 2
      (`packages/core/src/migrations.js:88`), và có thể chạy `alp backup --stop` ngay;
    - plugin cũ: `paseo plugin remove alp-provider`, rồi `paseo plugin add npm:@anhlp/alp-paseo@beta`
      (beta.1: lệnh này lỗi, [#111](https://github.com/phucanh08/alp/issues/111); notes dùng
      `npm install -g @anhlp/alp-paseo@beta` rồi `paseo plugin add "$(npm root -g)/@anhlp/alp-paseo"`);
  - link tới tài liệu này.
- Sau Q1–Q5, khi `release:gate … --phase announce` exit 0: `gh release edit v0.0.0-beta.1 --draft=false`. Nếu Q1–Q5 phát hiện lỗi, sửa known
  issues trước khi công bố, hoặc xử lý theo §7.8.

### 7.7 Publish dở dang

- **Lỗi giữa chừng không phải do nội dung package** (mạng, OTP, quyền):
  - trước khi thử lại, kiểm `npm view <pkg>@0.0.0-beta.1 version dist.integrity`;
  - nếu version đã có và integrity khớp: coi như đã publish, đi tiếp package sau;
  - nếu chưa có: publish lại **đúng tarball đó**;
  - không pack lại.
- **Version đã có nhưng integrity khác manifest:** dừng; coi là release lỗi (§7.8).
- **Cần sửa mã hoặc manifest để đi tiếp:**
  - không publish tiếp `0.0.0-beta.1` cho các package còn lại. Dependency pin đúng version, nên một
    bộ beta.1 thiếu package thì cài không được;
  - phát hành cả 8 package ở `0.0.0-beta.2` từ SHA mới, chạy lại toàn bộ §7;
  - các package beta.1 đã lên: xử lý theo §7.8.
- Không giả định version đã publish có thể ghi đè hay dùng lại. [Docs npm] Đã dùng thì không bao giờ
  dùng lại được.

### 7.8 Rollback một beta lỗi

1. Dừng công bố: giữ GitHub release ở draft, hoặc sửa notes ghi rõ lỗi.
2. Deprecate đúng version lỗi, cho từng package đã lên:
   `npm deprecate "@anhlp/<pkg>@0.0.0-beta.1" "<lỗi>; dùng 0.0.0-beta.2"`.
3. Dist-tag:
   - nếu đã có một beta tốt trước đó: `npm dist-tag add @anhlp/<pkg>@<bản tốt> beta`;
   - với beta đầu tiên không có bản tốt: `npm dist-tag rm @anhlp/<pkg> beta` (ghi lại kết quả; docs
     không nói gì về việc gỡ tag duy nhất của một package);
   - nếu lỗi được phát hiện trước Q4: không chuyển `latest` (D2 chỉ áp dụng cho bản đã qua Q1–Q3);
   - nếu `latest` đã chuyển sang bản lỗi: chuyển về một bản tốt trước đó nếu còn
     (`npm dist-tag add @anhlp/<pkg>@<bản tốt> latest`). Với beta đầu tiên, bản trước đó chỉ có thể
     là bản 0.x cũ còn lại và đã deprecate. Nếu không còn bản nào, giữ `latest` ở bản lỗi đã
     deprecate (người cài thấy cảnh báo) cho tới khi `0.0.0-beta.2` qua Q1–Q3, rồi chuyển `latest`
     sang bản đó. [Suy luận] npm không cho gỡ hẳn tag `latest`; docs không nói, ghi lại nếu thử.
4. Unpublish chỉ khi còn trong 72 giờ và đủ điều kiện (§1.1). Các package của ALP phụ thuộc nhau,
   nên phải gỡ từ ngoài vào: root → plugin → cli → daemon → client → runtime → core → protocol.
   Unpublish không hoàn tác được, và version không dùng lại được.
5. Sửa, rồi phát hành `0.0.0-beta.2` theo §7 từ đầu.

## 8. Việc phải làm trước khi publish (mỗi việc một task riêng)

Trạng thái ngày 2026-10-16, ở release SHA `2230aa5`.

| # | Việc | Chặn | Trạng thái |
|---|---|---|---|
| T1 | Đổi `0.0.0-beta` → `0.0.0-beta.1` trong manifest, lockfile, dependency nội bộ | Có | xong (PR #101) |
| T2 | `apps/gateway`: `"private": true` (gateway không vào `npm publish --workspaces`; `gateway-smoke` vẫn pack được) | Có | xong (PR #101) |
| T3 | `engines.node` `>=22.12` cho các package phát hành; docs ghi "Node.js 20+" đổi theo (`README.md`, `integrations/paseo/README.md`) | Có | xong (PR #101) |
| T4 | LICENSE, trường `license`, `repository`/`homepage` trỏ `phucanh08/alp`; LICENSE/NOTICE của Paseo trong tarball plugin | Có | xong (PR #101); L1 pass |
| T5 | Docs: mọi lệnh cài ghi `@beta` (`integrations/paseo/README.md:56`, `docs/alp/codex-only.md:18`); sửa model supervisor không khớp (`integrations/paseo/README.md:10` ghi Sonnet 4.6, `README.md` ghi Sonnet 5); chuyển "Remote mode (beta)" và `paseo-remote.md` sang deferred; gắn nhãn experimental như §4; link tới tài liệu này | Có | xong (PR #101) |
| T6 | Phân loại `npm audit` (S1) | Có | xong: F1, F2 đã sửa; chạy lại trên `RELEASE_SHA` và 8 tarball, S1 pass; F3 chấp nhận (D5) |
| T7 | Dọn npm: unpublish nếu đủ điều kiện, không thì deprecate (§1.1), gồm cả tên plugin cũ `alp-paseo-plugin` | anh làm | xong 2026-10-16 sau Q4: deprecate (§1.1, §6.4), không unpublish |
| T8 | Chạy §6 và §7, ghi kết quả vào §6.4 | anh (macOS, D7; H2 trên CI theo D8) | xong 2026-10-16: gate `publish`, `latest`, `announce` pass ở `2230aa5`; prerelease đã công bố |
| T9 | Đưa client SDK smoke vào CI; workflow publish; ~~thêm macOS vào lane `core`/`paseo`~~ (đã làm theo D8) | Không (sau beta) | deferred; phần acceptance Linux kéo lên trước theo D6 (T12) |
| T12 | Workflow `release-acceptance` (D6, D7): pack một lần trên CI + `release:consumer` + rehearsal fake (Codex, Claude, W6) trên macOS, Ubuntu, Windows | Có (pack là bộ tarball của release) | xong (PR #102); bộ tarball release: [release-acceptance 38901108957](https://github.com/phucanh08/alp/actions/runs/38901108957) |
| T10 | Test fake-provider cho câu hỏi quyền trong Paseo (§6.2, hàng duyệt quyền, ý 1) | Có | xong: test đã merge, pass trong `validate:paseo` ở release SHA (H1, H2) |
| T11 | Sửa F3 (`linkify-it@2.2.0` trong `alp web`); owner anh | Không chặn beta.1; chặn beta.2, hạn 2026-11-15 | xong cho beta.2: patch `paseo-web/patches/0020-ALP-bound-linkify-on-long-messages.patch` (PR #126, `7469721`); D9 = sửa (§11.5) |
| T13 | Claude stream text vào Paseo/`alp web` (`includePartialMessages`, map `stream_event`) | Không chặn beta.1 (known issue, anh chấp nhận 2026-10-16) | Đã triển khai trong source sau beta.2: bật partial messages, stream text theo message ID và đối chiếu từng block hoàn tất từ SDK; kiểm tra replay và SDK giả lập qua public runtime, gồm resume/stop/error. Đã kiểm chứng Claude thật trên Windows 2026-10-19 qua public runtime (45 delta, nội dung khớp final) và giao diện `alp web` bằng Chromium (25 dòng xuất hiện dần trong khi Stop còn hiện; chữ đầu ~1,8 giây, hoàn tất ~5 giây). Chưa kiểm tra ứng dụng Paseo native, chưa phát hành; ghi nhận beta.1/beta.2 bên dưới vẫn là lịch sử. [#107](https://github.com/phucanh08/alp/issues/107) |
| T14 | `paseo plugin add npm:@anhlp/alp-paseo@beta` cài được: không ship `.d.ts` import type từ peer `@getpaseo/*` (hoặc bỏ hẳn `.d.ts` của plugin); thêm kiểm CI cài plugin như Paseo cài nguồn `npm:` (`--legacy-peer-deps`); rồi bỏ cách tạm khỏi docs | Không chặn beta.1 (known issue, anh chấp nhận 2026-10-16); chặn beta.2 | xong: plugin không ship `.d.ts`; `scripts/paseo-source-check.mjs` trong `release:tarball-check`/`validate:packages`; docs dùng `npm:`, cách tạm chỉ còn cho beta.1. Q3 của beta.2 (2026-10-18): `paseo plugin add npm:@anhlp/alp-paseo@beta` cài được; [#111](https://github.com/phucanh08/alp/issues/111) đã đóng |

## 9. Không thuộc tài liệu này

Không publish, unpublish, deprecate, tag hay commit nào được thực hiện khi soạn tài liệu. Không chạy
provider thật.

## 10. Lịch sử và quyết định còn mở

**Bổ sung ngày 2026-10-16 theo review:**
1. Thêm acceptance provider thật trên Linux. Ma trận R1–R7 tách theo OS × provider; người chạy Linux
   lúc đó là TBD; sau đó anh nhận chạy (D1).
2. Map duyệt quyền, hủy, restore, worktree/merge tới test có sẵn và bước nghiệm thu (§6.2). Phân
   biệt fake với thật, và "có test" với "pass trên release SHA". Thêm T10 cho chỗ còn hở.
3. Thêm checklist publish tay đầy đủ (§7): tag, build/pack một lần, checksum và manifest, gate trên
   artifact, publish theo thứ tự, kiểm registry, GitHub prerelease, publish dở dang, rollback.
   Tách pre-publish gate với post-publish acceptance.
4. Thay suy đoán về npm bằng trích dẫn docs chính thức (§1.1–1.3). Giữ phần docs không nói rõ ở
   dạng "chưa rõ", kèm bước xác nhận.
5. Ghi trạng thái thật của T1–T3 (chưa làm). T4 thuộc một bạn Opus khác; tài liệu này không đụng file
   của bạn đó.
6. Thêm H2: lane `core`/`paseo` chạy tay trên macOS, vì CI chỉ chạy các lane đó trên Ubuntu.
7. Theo đề xuất của agent T5 (đã kiểm chứng lại): thêm tên plugin cũ `alp-paseo-plugin` vào §1.1 và
   T7; sửa ghi chú nâng cấp từ 0.10.0 ở §7.6, vì 0.10.0 chưa có `alp backup`.
8. Theo đề xuất của agent release-gate (đã đối chiếu tên lệnh và tham số với `scripts/release-*.mjs`
   và `package.json`):
   - §7.2 dùng `release:pack` thay cho các bước pack, checksum và manifest viết tay;
   - A5 chạy bằng `release:verify`, với danh sách kiểm mở rộng;
   - §6.3 thêm bước `release:consumer` trên mỗi máy;
   - §6.4 có thêm file evidence và các mốc `release:gate --phase publish|latest|announce`;
   - §5 cập nhật theo chuỗi kiểm mới của H3.

   Tooling chưa commit và mới có rehearsal trên Windows.
9. Theo đề xuất của agent T6/S1 (đã đọc report): ghi kết quả phân loại audit vào §5, trạng thái T6
   (§8), điều kiện chặn của S1, D5 cho F3, và known issue F3 (§7.6).
   - Thêm lưu ý: report nằm trong `.cache/` bị gitignore.
   - Môi trường của agent T6 đặt `NODE_TLS_REJECT_UNAUTHORIZED=0`. Agent đã đối chiếu advisory với
     GitHub Advisory API qua curl có kiểm TLS. Khi chạy lại S1 trên release SHA, dùng môi trường bật
     kiểm TLS.
10. Theo agent T10 (đã đối chiếu tên test, dòng và tham số của harness):
    - T10 có test (§6.2, §8);
    - C6 và W4 đổi sang rule `Bash(touch *)`, có thêm lựa chọn tiếng Việt;
    - §6.3 tham chiếu harness `scripts/beta-acceptance-*.mjs`;
    - §5 ghi hai test hỏng vì môi trường Windows.
    - Phần T5 chuyển tiếp: harness là quy trình gate, không đưa vào docs cài đặt.

**Quyết định của anh ngày 2026-10-16:**
- **D2.** Chuyển `latest` của cả 8 package sang `0.0.0-beta.1`, sau khi Q1–Q3 pass (§1.2, bước Q4
  ở §7.5). Rollback khi `latest` trỏ bản lỗi: §7.8.
- **D3.** Anh chạy H2 trên macOS, lần đầu tối 2026-10-16. Lần đó chạy trước khi chốt release SHA nên
  chỉ để định hướng; H2 phải chạy lại trên release SHA mới tính cho gate.
- **D4.** Anh đã kiểm: Paseo chạy được trên Linux. R6 giữ phạm vi đầy đủ (plugin và `alp web`) và
  chặn gate như R5.
- **D5.** F3 (`linkify-it@2.2.0` trong `alp web`, DoS phía client) được chấp nhận cho beta.1 và ghi
  vào known issues (§7.6). Owner: anh. Hạn xử lý: trước beta.2 hoặc 2026-11-15, mốc nào tới trước.
  Hai cách sửa còn lại khi xử lý:
  - patch ALP tắt linkify cho tin nhắn dài; phải build lại web app, chạy lại A5, R5, R6;
  - override `linkify-it@5`; không khuyến nghị.
- **D1.** Anh chạy phần Linux (R3, R4, R6, R7 phần Linux), lần đầu tối 2026-10-16.
  - Máy này không có Docker. Nếu không có máy Linux riêng thì đề xuất dùng WSL2 Ubuntu 24.04 (§6.3).
  - Bằng chứng ghi rõ môi trường, ví dụ "Linux (WSL2 Ubuntu 24.04)".
  - Như H2, lần chạy tối nay diễn ra trước khi chốt SHA và trước T1 (chưa có version
    `0.0.0-beta.1`, `release:pack` chỉ chạy được với `--rehearsal`), nên chỉ để định hướng. Gate
    cần chạy lại trên release SHA với đúng 8 tarball đã lưu.
  - GitHub Actions tự động hóa C1–C9, W1/W2, W6: sau beta, gộp vào T9.

**Quyết định của anh ngày 2026-10-16 (bổ sung):**
- **D6.** CI là máy build: một run `release-acceptance` pack đúng một lần; mọi dòng R, kể cả macOS,
  dùng artifact đó. §7.2 chạy trên runner thay cho clone sạch trên máy anh; P1 (tag) chỉ tạo trên
  runner, anh tạo tag cục bộ ở cùng SHA và push ở P5.
  - OpenCode (ACP, experimental) không thay được Codex/Claude cho R3/R4: nó đi đường code khác và
    ALP không có sandbox quanh agent ACP.
- **D7.** Chỉ macOS là nền tảng test chính. Windows và Ubuntu test khi có thể. Thay D1 và D4 về việc
  chặn:
  - GitHub Actions chỉ dùng fake Codex và fake Claude, không gọi provider thật, không secret.
  - Dòng chặn với provider thật: R1, R2, R5 và R7 phần macOS (anh chạy tay). R3, R4, R6 và phần
    Linux của R7 không chặn; anh chạy khi có thể và ghi lại. Q2 chặn với macOS, Linux khi có thể.
  - Lane CI hermetic (H1, H3 trên Ubuntu, H4 trên Windows) vẫn chặn như cũ: chúng chạy fake, tự
    động, và là required check của nhánh `main`.
  - Release notes ghi rõ: provider thật mới được nghiệm thu trên macOS; Linux có CI hermetic và
    rehearsal fake trên tarball; Windows vẫn experimental.
- **D8.** H2 chạy trên CI: job `core-paseo-macos` (macOS, Node 24, `validate:core` và
  `validate:paseo`) trong `ci.yml`, thay việc chạy tay (D3). Lý do: máy anh có `@anhlp/alp-paseo`
  cài global, mà ALP luôn tìm `alp-web-integration` trong `/opt/homebrew/bin`, nên
  `core-standalone-smoke` trong `validate:core` không chạy sạch được trên máy đó. Runner CI không có
  bản cài global. Tên job mới để không đổi các required check hiện có; nên thêm job này vào
  required check của `main` sau khi nó xanh ổn định.

**Live trên macOS ngày 2026-10-16 (anh giao Claude Code chạy):**
- `6765826`: R2 C6 (Claude được Allow once vẫn bị sandbox chặn), R1 C5 (supervisor review turn bị
  ngắt và gửi mail, `alp run` treo), R7 (test e2e thiếu thư mục), C9 harness. Sửa ở PR #105 → `dc2621c`.
- `dc2621c`: Codex không nhớ output của turn bị ngắt; Claude không hỏi khi lệnh cần ra khỏi sandbox
  read-only. Anh yêu cầu sửa cả hai; PR #106 → release SHA `2230aa5`.
- `2230aa5`: Claude không stream vào Paseo (R5 W3). Anh chấp nhận là known issue (T13, #107). C5
  của R1 anh xác nhận pass.
- Lưu ý harness: W1 dùng lại alpd đang chạy cho `~/.alp` dù là bản build khác (cùng version
  string); dừng alpd trước mỗi lượt R5.

**P5 ngày 2026-10-16 (anh quyết định):**
- **Go** cho `0.0.0-beta.1` ở `2230aa5` (§6.4). Tag đã push; GitHub release giữ ở draft tới khi
  `--phase announce` exit 0 (§7.6).
- **T7 hoãn tới sau publish.** Thông điệp deprecate ở §1.1 chỉ người dùng tới `@anhlp/alp@beta` và
  `@anhlp/alp-paseo@beta`. Hai tag đó chỉ có sau §7.4, nên deprecate trước thì cảnh báo chỉ tới
  một bản cài chưa có. Spec đã kiểm với npm 11.19.1 (`includePrerelease: true`):
  `>=0.3.0 <=0.10.0` chỉ khớp 15 bản `0.3.0` … `0.10.0` của `@anhlp/alp`.
- Release notes bỏ câu "evidence chỉ từ e2e cũ trên mã nguồn". R1, R2, R5, R7 đã chạy provider thật
  trên chính bộ tarball này (macOS).

**Phần D ngày 2026-10-16 (anh quyết định, Claude Code chạy):**
- Q3 tìm ra lỗi: `paseo plugin add npm:@anhlp/alp-paseo@beta` không cài được (§6.4, #111). Anh
  quyết định vẫn phát hành beta.1, ghi lỗi thành known issue có cách tạm, sửa ở beta.2 (T14).
  Không rollback theo §7.8.
- Bài học cho gate: W1 của R5 thêm plugin bằng đường dẫn trong consumer, nơi npm đã cài peer, nên
  không thử đúng đường Paseo cài nguồn `npm:`. T14 thêm kiểm này vào CI trước beta.2.
- Q4, T7 và bỏ draft chạy sau khi anh go từng bước. T7 thêm `@anhlp/alp-paseo@0.0.0-stage` và đổi
  thông điệp của `alp-paseo-plugin` sang cách cài theo đường dẫn (§1.1).
- Ghi nhận nhỏ: `alp --version` in usage thay vì version.

Không còn quyết định nào mở trong scope này.

## 11. Beta.2 (`0.0.0-beta.2`)

Soạn ngày 2026-10-17 (task t-4393.2), trên nhánh `release/beta.2` từ `origin/main` `99a8d15`.
**Đã publish ngày 2026-10-18** (task t-4393.3) từ release SHA `1b16b14` (`main`, sau PR #124–#127);
`latest` chuyển sang `0.0.0-beta.2` và release đã công khai cùng ngày (task t-4393.5). Kết quả ở
§11.6.

### 11.1 Phạm vi

- Cùng 8 package, cùng dist-tag `beta`, cùng nền tảng và mức hỗ trợ như §2–§4. Mọi manifest (8
  package phát hành và 3 workspace private) ở `0.0.0-beta.2`; dependency nội bộ pin đúng version
  (`npm run version:package` cho 7 workspace phát hành, root và 3 workspace private sửa tay như
  T1, rồi `npm install --package-lock-only`). `scripts/beta-acceptance-lib.mjs` `VERSION` đổi theo.
- Thay đổi so với beta.1: PR #113, #123, #124 (danh sách: `beta-release-notes.md`, mục "What
  changed since 0.0.0-beta.1"). Phần vào package phát hành: plugin cài được từ `npm:` (#111,
  T14), bridge Paseo không stream lại cả message, chi tiết tool có kiểu trong Paseo, các RPC
  additive của alpd (tên session, `session.list` phân trang và tìm, `question.watch`, theo dõi
  turn end, `daemon.hello` có hostname, ảnh inline trong `session.prompt`, usage, `files.read`,
  tool details), sửa preview team, team custom trong `alp acp`, git của workspace. `apps/web` và
  `@anhlp/alp-gateway` có nhiều thay đổi nhưng vẫn deferred, không phát hành.
- State schema không đổi (`STATE_SCHEMA` = 2 như beta.1): từ beta.1 lên beta.2 không có migrate.
- Known issues: như beta.1, bỏ #111 (đã sửa, Q3 xác nhận trên registry), giữ #107 (T13). F3 (T11)
  đã sửa trong beta.2 (patch 0020, PR #126; D9), chuyển từ known issue sang Fixes.

### 11.2 Pre-publish gate

Như §6.1, §6.4 và §7.1–§7.3, với `0.0.0-beta.2` thay cho `0.0.0-beta.1`. Mọi dòng chạy trên
**release SHA mới** và **bộ 8 tarball mới** pack một lần ở SHA đó; không dòng nào của beta.1
được tính lại.

| # | Ở beta.2 | Chặn |
|---|---|---|
| H1–H4 | CI ở release SHA (job `core`, `paseo`, `core-paseo-macos`, `packages-and-web`, `windows-daemon`). `packages-and-web` có thêm `paseo-source-check` (#111): cài plugin như Paseo cài nguồn `npm:` và chạy compiler plugin của Paseo | Có |
| H5 | CI `alp-web` | Không |
| L1 | `release:check-version`; manifest và license | Có |
| S1 | `npm audit --omit=dev` trên repo và `npm audit` trên consumer cài 8 tarball, bật kiểm TLS. Lockfile đổi so với beta.1, nên phải chạy lại | Có |
| A5 | `release:pack` + `release:verify --sha` trên bộ tarball mới | Có |
| R1, R2 | macOS, Codex và Claude, CLI C1–C9 trên tarball mới | Có |
| R5 | macOS, plugin và `alp web`, W1–W6, như beta.1. W1 thêm plugin bằng đường dẫn trong consumer (đã có peer), nên không thử đường `npm:` của Paseo; đường đó do H3 (`paseo-source-check`) kiểm trên tarball và Q3 kiểm trên registry | Có |
| R3, R4, R6 | Linux, khi có thể (D7) | Không |
| R7 | `beta-acceptance-r7.mjs` ở release SHA, Codex và Claude, macOS | Có (phần macOS) |
| T11/F3 | sửa xong, hoặc anh ghi D9 chấp nhận lại (§11.5) — đã sửa (PR #126, D9) | Có, theo §8 |

Lệnh gate local đã chạy trên nhánh release (chưa phải release SHA; chỉ để định hướng): §11.6.

### 11.3 Kế hoạch publish

1. **P0.** PR `chore(release): 0.0.0-beta.2` xanh CI và merge vào `main` theo branch protection.
   `RELEASE_SHA` = commit đó trên `main`; `git status` sạch.
2. **P1–P3 (D6).** Chạy workflow `release-acceptance` ở `sha=$RELEASE_SHA`: job `pack` tạo tag
   `v0.0.0-beta.2` chỉ trên runner, `npm ci`, `build:web`, `build:packages`, `release:pack`,
   `release:verify --sha`, upload artifact `alp-release`. Tải về đúng artifact này:
   `gh run download <run> -n alp-release -D /tmp/alp-release` (artifact đã chứa thư mục
   `v0.0.0-beta.2/`), rồi `OUT=/tmp/alp-release/v0.0.0-beta.2`; trong `$OUT` kiểm
   `shasum -a 256 -c SHA256SUMS`, `release-manifest.json` có `version` `0.0.0-beta.2`,
   `git.sha` = `RELEASE_SHA`, `git.dirty` false, `pack.rehearsal` false; khóa thư mục
   (`chmod -R a-w`) và lưu một bản sao.
3. **P4.** `npm run release:gate -- "$OUT" --init release-evidence-beta2.json` (file **ngoài**
   `$OUT`); A5 (`release:verify -- "$OUT" --sha "$RELEASE_SHA" --record …`), `release:consumer`,
   R1, R2, R5, R7 (harness §6.3, `PACKS=$OUT`), H1–H5 (link CI), L1, S1 vào evidence;
   `npm run release:gate -- "$OUT" release-evidence-beta2.json --phase publish` exit 0.
   Kiểm registry: `npm whoami` = `anhlp`; cả 8 package E404 ở `0.0.0-beta.2`.
4. **P5.** Anh go/no-go. `git tag -a v0.0.0-beta.2 "$RELEASE_SHA" -m "ALP 0.0.0-beta.2"`,
   `git push origin v0.0.0-beta.2`; draft prerelease (§7.6, đổi version), notes từ
   `beta-release-notes.md` phần beta.2 với checksum đã điền.
5. **Publish (§7.4)**, đúng thứ tự protocol → core → runtime → client → daemon → cli → paseo →
   root, `--dry-run` trước, rồi từng package một:
   `npm publish ./anhlp-alp-<pkg>-0.0.0-beta.2.tgz --tag beta --access public`, ngay sau mỗi
   package `npm view @anhlp/alp-<pkg>@0.0.0-beta.2 dist.integrity` phải bằng manifest. Publish dở
   dang: §7.7 (sửa mã thì lên `0.0.0-beta.3`).

### 11.4 Post-publish acceptance và dọn npm

Như §7.5 với `0.0.0-beta.2`:

| # | Ở beta.2 |
|---|---|
| Q1 | `beta` = `0.0.0-beta.2` cả 8; integrity khớp manifest. Ghi `latest` trước Q4: dự kiến vẫn `0.0.0-beta.1` cả 8 (tên đã có `latest`, §1.2) |
| Q2 | Cài sạch `@anhlp/alp@beta @anhlp/alp-paseo@beta` ở HOME và prefix mới: mọi `@anhlp/*` là `0.0.0-beta.2`; lockfile consumer khớp manifest |
| Q3 | C1, C2, C4 với một provider; **`paseo plugin add npm:@anhlp/alp-paseo@beta` phải thành công** (dòng hỏng ở beta.1, #111), W2, W6. Pass thì đóng #111 |
| Q4 | Sau Q1–Q3 và `release:gate … --phase latest` exit 0: `npm dist-tag add @anhlp/<pkg>@0.0.0-beta.2 latest` cho cả 8 |
| Q5 | Cài không tag: mọi `@anhlp/*` là `0.0.0-beta.2` |

Dọn npm sau Q3 (anh go): chạy lại `npm deprecate` cho tên plugin cũ với thông điệp đã chuẩn bị
ở §1.1, vì cách cài `npm:` giờ đã chạy:

```sh
npm deprecate alp-paseo-plugin 'Đổi tên thành @anhlp/alp-paseo. Cài: paseo plugin remove alp-provider; paseo plugin add npm:@anhlp/alp-paseo@beta'
npm view alp-paseo-plugin@0.10.0 deprecated   # thông điệp mới; có thể chậm khoảng 30 giây (cache)
```

Không deprecate `0.0.0-beta.1` (bản tốt, chỉ có known issue #111 đã có cách tạm). Không đổi các
deprecate khác của T7. Cuối cùng `release:gate … --phase announce` exit 0 rồi bỏ draft.

### 11.5 Quyết định còn mở

- **D9 (anh) — đã chốt: sửa.** F3/T11 ghi "chặn beta.2", hạn "trước beta.2 hoặc 2026-11-15"
  (D5), và chưa sửa ở `99a8d15`. Anh chọn (a) sửa trước beta.2, không chấp nhận lại. Đã sửa bằng
  patch ALP `paseo-web/patches/0020-ALP-bound-linkify-on-long-messages.patch` (PR #126, merge
  `7469721`): trong `createMarkdownParser`, linkify không quét đoạn text liền quá 2048 ký tự hay
  nguồn quá 32 KB; inline code tự thành link chỉ tới 256 ký tự. Đánh đổi UX: URL/email trần trong
  đoạn rất dài hiện dạng text thường; link markdown tường minh không đổi. Notes beta.2 ghi F3 trong
  Fixes, bỏ khỏi Known issues. Lịch sử beta.1 (D5, §5, §7.6) giữ nguyên.

### 11.6 Kết quả

| # | SHA | Tarball | Máy, OS, Node | Kết quả | Bằng chứng |
|---|---|---|---|---|---|
| Gate local, nhánh release | `99a8d15` + diff release (trước merge) | rehearsal, không phải evidence | macOS arm64, Node 26.3.0 (experimental), npm 11.16.0 | pass | `release:check-version`; `release:check` (999 test: 994 pass, 0 fail, 5 skip; pack-check 8 package); `validate:core` 467/471 (4 skip); `validate:paseo` 144/144 và 197/198 (1 skip); `validate:packages` (A5, `release-consumer`, `paseo-source-check` với compiler Paseo); `validate:web` 186/186 unit, 40/40 e2e; `release:pack --rehearsal` + `release:verify` + `release:gate --init`/`--phase publish` (11 dòng chặn còn mở, đúng dự kiến). Lần chạy `release:check` đầu có 1 fail `test/integration/service.test.js:55` (alpd.log rỗng ngay sau ready); chạy lại riêng 3/3 pass và pass trong `validate:paseo` |
| H1–H4 | `1b16b14` | — | CI: Ubuntu Node 22/24 (H1, H3), macOS Node 24 (H2, `core-paseo-macos`), Windows Node 22/24 (H4) | pass, không cần chạy lại job nào | [CI 39081421077](https://github.com/phucanh08/alp/actions/runs/39081421077); H3 gồm `paseo-source-check` với compiler của Paseo (server 2358497 B, client 167496 B) |
| H5 | `1b16b14` | — | CI: Ubuntu, macOS | pass (không chặn) | [CI 39081421077](https://github.com/phucanh08/alp/actions/runs/39081421077) |
| L1 | `1b16b14` | — | macOS arm64, Node 24.22.0, worktree ở release SHA | pass | `release:check-version` pass (8 package `0.0.0-beta.2`, dependency nội bộ pin, lockfile khớp); 8 manifest `Apache-2.0`, `repository`/`homepage` trỏ `phucanh08/alp`; LICENSE/NOTICE không đổi từ `2230aa5`; LICENSE/NOTICE trong tarball do A5 kiểm |
| S1 | `1b16b14` | khớp (audit consumer trên 8 tarball) | macOS arm64, Node 24.22.0, npm 11.19.1, bật kiểm TLS | pass | `npm audit --omit=dev` trên repo: 0 (554 dependency); consumer cài 8 tarball: 0/0 có peer (146 package) và `--legacy-peer-deps` (131); F3 đã sửa (patch 0020). High trong `npm audit` đầy đủ chỉ thuộc dev (jest, metro, react-native của `apps/*`), không vào 8 package |
| A5 | `1b16b14` | `SHA256SUMS` = `916f49a9…0364` | pack: [release-acceptance 39081508130](https://github.com/phucanh08/alp/actions/runs/39081508130), Ubuntu Node 22.23.3, npm 10.9.9; verify lại: macOS Node 24.22.0 | pass | job `pack` (`release:pack` + `release:verify --sha`); trên Mac: `shasum -c` 8/8, manifest `0.0.0-beta.2`, `git.sha` = `1b16b14…`, `dirty` false, `rehearsal` false; `release:verify --record` và `release:consumer` pass (Paseo compiler bỏ qua trên Mac vì không có checkout Paseo; H3 chạy nó). Job `acceptance` (fake, macOS/Ubuntu/Windows) cũng xanh |
| R1 | `1b16b14` | khớp | macOS 27 arm64, Node 24.22.0, Codex CLI 0.162.1, `gpt-6.1-sol` | pass; C5 do lead đọc | `--unattended`: 9 pass, C5 `check`: turn bị hủy 5 giây sau khi bắt đầu, trước khi có output; `alp ps` không còn session chạy; câu trả lời "Mình chưa đếm ra số nào trước khi bị ngắt." đúng (cùng trường hợp anh xác nhận ở beta.1) |
| R2 | `1b16b14` | khớp | như R1, Claude Code 2.1.300, `claude-opus-5-5` | pass 10/10 | `--unattended` |
| R5 | `1b16b14` | khớp | như R1, Paseo 0.11.4 chạy **daemon riêng** (xem dưới) | pass: W1–W6 (Codex, Claude); W3 Claude không stream (#107) | W1/W2 harness; W3/W4 qua `paseo` CLI (`run`, `stop`, `send`, `permit allow --input`); W5/W6 qua Chromium headless (Playwright) trên `alp web`, có ảnh chụp; W3–W6 do lead chấm từ log và ảnh |
| R7 | `1b16b14` | — (mã nguồn) | như R1 | pass (Codex `gpt-6.1-sol`, Claude `claude-opus-5-5`) | `beta-acceptance-r7.mjs --live --sha`, sau `npm ci && npm run build` trong worktree ở release SHA |
| P4 | `1b16b14` | `SHA256SUMS` = `916f49a9…0364` (`shasum -c` OK) | macOS arm64, Node 24.22.0, npm 11.19.1 | pass | `release:gate --phase publish` exit 0; `npm whoami` = `anhlp`, owner của các tên; cả 8 package E404 ở `0.0.0-beta.2`; trước publish `beta` = `latest` = `0.0.0-beta.1` cả 8 |
| P5 | `1b16b14` | asset tải lại: `shasum -c` OK, giống từng byte (10/10) | như P4 | go (anh đồng ý publish 2026-10-17) | tag `v0.0.0-beta.2` (annotated `eb2e1bf`) đã push, trỏ `1b16b14`; GitHub prerelease draft, 8 tarball + `SHA256SUMS` + `release-manifest.json` |
| Publish (§7.4) | `1b16b14` | `shasum -c` OK trước khi publish; dry-run: tên, version, tag `beta`, số file (44, 144, 97, 69, 36, 47, 119, 175) khớp manifest, không có bước build | như P4, không cần OTP | pass 8/8, 2026-10-18 | `npm publish ./<file>.tgz --tag beta --access public`, từng package; `dist.integrity` trên registry khớp manifest cả 8 (bảng dưới) |
| Q1 | `1b16b14` | `dist.integrity` khớp manifest 8/8 | macOS arm64, Node 24.22.0, npm 11.19.1 | pass, 00:49:45Z | `beta` = `0.0.0-beta.2` cả 8; `latest` trước Q4 = `0.0.0-beta.1` cả 8 (đúng dự kiến §11.4; lần này không có tên mới nên registry không tự gán `latest`) |
| Q2 | `1b16b14` | lockfile consumer: `integrity` khớp manifest 8/8, `resolved` là `registry.npmjs.org` | như Q1; HOME mới (cache rỗng), prefix riêng; Linux không chạy (D7) | pass (macOS) | `npm install -g --prefix … @anhlp/alp@beta @anhlp/alp-paseo@beta`: mọi `@anhlp/*` trong cây là `0.0.0-beta.2` |
| Q3 | `1b16b14` | bản cài của Q2 | như Q1, Codex CLI 0.162.1, Paseo 0.11.4 (daemon riêng) | pass; [#111](https://github.com/phucanh08/alp/issues/111) đã đóng | C1, C2, C4 (Codex, `ALP_HOME` tạm 0700) pass. **`paseo plugin add npm:@anhlp/alp-paseo@beta` exit 0**, revision `0.0.0-beta.2`; W2 có Phở và Cafe; W6: `alp-web-integration --register` (bản cài global của Q2), không token / sai token bị từ chối, đúng token được nhận; web thấy project, session của C4 và Tasks. `release:gate --phase latest` exit 0 |
| Q4 | `1b16b14` | `916f49a9…0364` | như Q1 | pass, 01:10:18Z (anh xác nhận các bước do lead chấm ngày 2026-10-18, gate g1 của t-4393.5) | `release:gate --phase latest` exit 0; `npm dist-tag add @anhlp/<pkg>@0.0.0-beta.2 latest` exit 0 cả 8 (01:10:10Z–01:10:18Z); `npm view … dist-tags`: `latest` = `beta` = `0.0.0-beta.2` cả 8 |
| Q5 | `1b16b14` | `916f49a9…0364` | như Q1; HOME mới, prefix `/tmp/alp-b2/q5` | pass, 01:10:54Z | `npm install -g @anhlp/alp @anhlp/alp-paseo` không tag (232 package): mọi `@anhlp/*` trong cây là `0.0.0-beta.2` |
| Dọn npm (§11.4) | — | — | như Q1 | xong, 01:11:39Z | `npm deprecate alp-paseo-plugin` với thông điệp `npm:` (§1.1) exit 0; `npm view alp-paseo-plugin@0.10.0 deprecated` ra thông điệp mới ngay; packument: 15/15 version mang thông điệp mới; `@anhlp/alp` và `@anhlp/alp-paseo` `0.0.0-beta.1`/`0.0.0-beta.2` không có `deprecated` |
| Announce | `1b16b14` | asset không đổi (10 file) | — | xong, 01:12:28Z | `release:gate --phase announce` exit 0 (Q4, Q5 pass); `gh release edit v0.0.0-beta.2 --notes-file … --draft=false`: [prerelease v0.0.0-beta.2](https://github.com/phucanh08/alp/releases/tag/v0.0.0-beta.2), notes ghi `latest` = `beta` = `0.0.0-beta.2` |

Publish `0.0.0-beta.2` ngày 2026-10-18 (giờ UTC). "Registry" là `time["0.0.0-beta.2"]` trong
packument. Dist-tags đọc lúc 00:49:45Z, sau package cuối. Sau Q4 (01:10:18Z), `latest` =
`beta` = `0.0.0-beta.2` cả 8.

| # | Package | Lệnh publish xong | Registry | `dist.integrity` | `beta` | `latest` (trước Q4) |
|---|---|---|---|---|---|---|
| 1 | `@anhlp/alp-protocol` | 00:34:33Z | 00:35:48Z | khớp | `0.0.0-beta.2` | `0.0.0-beta.1` |
| 2 | `@anhlp/alp-core` | 00:35:58Z | 00:37:14Z | khớp | `0.0.0-beta.2` | `0.0.0-beta.1` |
| 3 | `@anhlp/alp-runtime` | 00:37:34Z | 00:39:11Z | khớp | `0.0.0-beta.2` | `0.0.0-beta.1` |
| 4 | `@anhlp/alp-client` | 00:39:31Z | 00:40:27Z | khớp | `0.0.0-beta.2` | `0.0.0-beta.1` |
| 5 | `@anhlp/alp-daemon` | 00:40:48Z | 00:42:03Z | khớp | `0.0.0-beta.2` | `0.0.0-beta.1` |
| 6 | `@anhlp/alp-cli` | 00:42:24Z | 00:43:20Z | khớp | `0.0.0-beta.2` | `0.0.0-beta.1` |
| 7 | `@anhlp/alp-paseo` | 00:43:42Z | 00:46:53Z | khớp | `0.0.0-beta.2` | `0.0.0-beta.1` |
| 8 | `@anhlp/alp` | 00:47:13Z | 00:49:20Z | khớp | `0.0.0-beta.2` | `0.0.0-beta.1` |

Khác với beta.1 khi chạy:
- **Paseo riêng cho R5 và Q3.** Phiên ALP chạy việc publish (main, lead, supervisor) là con của
  alpd `~/.alp` mà Paseo của anh khởi động (beta.1, plugin từ `~/.npm-global`). Dừng alpd đó, hay
  `paseo plugin add` vào `~/.paseo`, sẽ dừng chính phiên đang publish và thay plugin anh đang dùng.
  Vì vậy R5 và Q3 chạy trên một daemon Paseo 0.11.4 khác (cùng binary, `PASEO_HOME` riêng dưới
  `/tmp`, cổng 6797–6799, tắt relay) với `ALP_HOME` mới; main duyệt cách này. Không có alpd cũ để
  "dừng trước mỗi lượt R5" (§10): alpd của mỗi lượt là bản `0.0.0-beta.2` vừa cài. `~/.paseo`,
  `~/.alp`, bản cài global và alpd của anh không bị đụng; nâng plugin của anh lên beta.2 là việc
  của anh.
- **Bước cần người đọc** (C5 của R1; W3–W6 của R5; nửa trình duyệt của W6 ở Q3) do lead (agent)
  chấm từ log và ảnh chụp, ghi rõ trong trường `runner` của evidence. Anh xem lại và xác nhận
  ngày 2026-10-18 (gate g1 của t-4393.5) trước Q4.
- Máy này đã lên Node 26.3.0 (experimental, §3). Gate và Q dùng Node 24.22.0 tải từ nodejs.org
  (kiểm `SHASUMS256.txt`), như beta.1.
- Quan sát, chưa sửa: chạy thẳng `server/dist/main.js --register` trong bản plugin Paseo cài từ
  `npm:` báo `ERR_MODULE_NOT_FOUND` `@getpaseo/plugin` (peer do Paseo cung cấp khi nạp plugin).
  Đường có trong docs (`npm install -g @anhlp/alp-paseo@beta`, rồi `alp-web-integration
  --register`) chạy được.

Evidence (output lệnh, lockfile, ảnh chụp) nằm ngoài repo, trên máy anh: `~/alp-release/evidence/beta2/`,
`~/alp-release/evidence/q-1b16b14/`, `~/alp-release/runs/{1b16b14-cli-*,r5-1b16b14,r7-1b16b14}/`;
các dòng đã ghi vào `~/alp-release/release-evidence-1b16b14.json`.

## 12. Beta.3 (`0.0.1-beta.3`)

Soạn ngày 2026-10-20 (task t-3627), trên nhánh `release/0.0.1-beta.3` từ `origin/main` `23e22ee`
(sau PR #166). **Đã publish 2026-10-20** từ `18aa65f`, tag `v0.0.1-beta.3`; kết quả ở §12.5.

### 12.1 Phạm vi

- **Version (D10, anh chọn):** `0.0.1-beta.3`, không phải `0.0.0-beta.3` như §1 dự kiến. Theo semver
  nó đứng trên mọi `0.0.0-beta.*` và vẫn dưới `0.10.0` cũ, nên docs vẫn ghi `@beta` và
  `npm install`, không `npm update`. Cùng 8 package, cùng dist-tag `beta`, cùng nền tảng và mức hỗ
  trợ như §2–§4, trừ Paseo. Mọi manifest (8 package phát hành và 3 workspace private) ở
  `0.0.1-beta.3`, dependency nội bộ pin đúng version (`npm run version:package` cho 7 workspace phát
  hành, root và 3 workspace private sửa tay, rồi `npm install --package-lock-only`; lockfile chỉ đổi
  chuỗi version). `scripts/beta-acceptance-lib.mjs` `VERSION` đổi theo.
- **Lý do chính: Paseo 0.12.** Plugin `0.0.0-beta.2` (và cũ hơn) khai `requirements.paseo`
  `>=0.11.1 <0.12.0`; host Paseo 0.12.0 từ chối nạp (`assertPluginCompatibility`). PR #166 (t-e5dc)
  mở thành `>=0.11.1 <0.13.0` ở manifest và peer `@getpaseo/*`. Hỗ trợ: **Paseo 0.11.x và 0.12.x**.
  Bản beta.2 trở về trước giữ nguyên trên npm, chỉ chạy với Paseo `<0.12.0`; notes ghi rõ.
- Thay đổi khác so với beta.2: PR #130–#163 (danh sách: `beta-release-notes.md`, mục "What changed
  since 0.0.0-beta.2"), trong đó #133 sửa #107 (Claude stream vào Paseo/`alp web`) và #158 sửa
  `alp --version`. State schema không đổi (`STATE_SCHEMA` = 2): không có migrate.
- Known issues: như beta.2, bỏ #107 (đã sửa; R5 W3 với Claude phải stream) và `alp --version`
  (đã sửa); thêm "beta.2 trở về trước không chạy với Paseo 0.12".

### 12.2 Pre-publish gate

Như §11.2, với `0.0.1-beta.3`, release SHA mới và bộ 8 tarball mới pack một lần ở SHA đó. Khác
§11.2:

| # | Ở beta.3 | Chặn |
|---|---|---|
| H1–H4 | CI ở release SHA; thêm job `paseo-sdk-floor` (Paseo SDK 0.11.1) của #166 | Có |
| H6 | `paseo-compat` (`check-paseo-compat.mjs --latest`, Paseo mới nhất = 0.12.0) chạy `workflow_dispatch` ở release SHA | Có |
| R5 | macOS, W1–W6 (Codex, Claude) trên **Paseo 0.11.4** như beta.2, W3 với Claude phải stream (#107) | Có |
| R5b | macOS, W1–W3 với một provider trên **Paseo 0.12.0**, daemon Paseo riêng (`PASEO_HOME`, `ALP_HOME`, cổng riêng, §6.3); plugin nạp được, không có lỗi `requires Paseo` | Có |

Các dòng khác (H5, L1, S1, A5, R1, R2, R3/R4/R6, R7) như §11.2. Người chạy như §6.1; bước cần
người đọc do agent chấm thì ghi trong `runner` và anh xác nhận trước Q4, như beta.2 (§11.6).

### 12.3 Kế hoạch publish

Như §11.3, thay `0.0.0-beta.2` bằng `0.0.1-beta.3` (tag `v0.0.1-beta.3`, evidence
`release-evidence-<sha>.json` ngoài `$OUT`). Publish dở dang: §7.7 (sửa mã thì lên version mới).

### 12.4 Post-publish acceptance

Như §11.4 với `0.0.1-beta.3`. Q1: ghi `latest` trước Q4 (dự kiến `0.0.0-beta.2` cả 8). Q3 chạy
`paseo plugin add npm:@anhlp/alp-paseo@beta` trên **Paseo 0.12.0** (daemon riêng như R5b) và trên
Paseo 0.11.4. Không deprecate `0.0.0-beta.2` (bản tốt với Paseo 0.11.x); không có bước dọn npm.

### 12.5 Kết quả

| # | SHA | Tarball | Máy, OS, Node | Kết quả | Bằng chứng |
|---|---|---|---|---|---|
| Gate local, nhánh release | `23e22ee` + diff release (trước merge) | rehearsal, không phải evidence | macOS arm64, Node 24.22.0 | không ghi kết quả riêng | thay bằng CI và các dòng chạy ở release SHA bên dưới |
| H1–H4 | `18aa65f` | — | CI: Ubuntu Node 22/24, macOS Node 24, Windows Node 22/24; có `paseo-sdk-floor` (Paseo SDK 0.11.1) | pass | [CI 39363062222](https://github.com/phucanh08/alp/actions/runs/39363062222) |
| H5 | `18aa65f` | — | CI: Ubuntu, macOS | pass (không chặn) | [CI 39363062222](https://github.com/phucanh08/alp/actions/runs/39363062222) |
| H6 | `18aa65f` | — | CI `paseo-compat`, `workflow_dispatch` | pass | [paseo-compat 39363075273](https://github.com/phucanh08/alp/actions/runs/39363075273) (Paseo mới nhất = 0.12.0) |
| L1 | `18aa65f` | — | macOS 27 arm64, Node 24.22.0, worktree ở release SHA | pass | `release:check-version` pass; 8 manifest `Apache-2.0`, `repository` trỏ `phucanh08/alp`; LICENSE/NOTICE trong tarball do A5 kiểm |
| S1 | `18aa65f` | khớp (consumer trên 8 tarball) | như L1, bật kiểm TLS | pass | `npm audit --omit=dev` trên repo: 0 (553 dependency); consumer cài 8 tarball: 0/0 (146 package) |
| A5 | `18aa65f` | `SHA256SUMS` = `c6fa00c2…8eee` | pack: [release-acceptance 39363072207](https://github.com/phucanh08/alp/actions/runs/39363072207), Ubuntu Node 22.23.3, npm 10.9.9; verify lại trên macOS Node 24.22.0 | pass | `shasum -c` 8/8; manifest `0.0.1-beta.3`, `git.sha` = `18aa65f…`, `dirty` false, `rehearsal` false; `release:verify --record` pass |
| R1 | `18aa65f` | — | macOS | **bỏ qua (waived)**, anh quyết định 2026-10-20 03:11Z | Codex CLI hết hạn mức tới 04:46Z; anh bỏ mọi dòng Codex của beta.3 (R1, nửa Codex của R5 và R7), chỉ test Claude. Vì vậy `release:gate` các phase `publish`, `latest`, `announce` đều exit 1 chỉ vì R1 (`waived` vẫn tính là mở); anh chấp nhận. Release notes ghi rõ |
| R2 | `18aa65f` | khớp | macOS 27 arm64, Node 24.22.0, Claude Code 2.1.304, `claude-opus-5-5` | pass; C5 lead chạy lại, anh xác nhận | `--unattended` 9/10: C5 fail do race (đếm tới 200 xong trước SIGINT). Chạy lại Ctrl-C trên cùng bản cài với đếm tới 3000: `turn.ended` canceled lúc SIGINT, `alp ps` không còn session chạy, `alp send` được trả lời |
| R5 | `18aa65f` | khớp | như R2, Paseo 0.11.4 daemon riêng, `ALP_HOME` mới; chỉ Claude (nửa Codex bỏ qua) | pass; W3–W6 lead chấm, anh xác nhận | harness 7/7; W3 Claude **stream** (#107 đã sửa): dòng log 107→375→643→911, Stop ở 932, prompt sau chạy; W4 once chạy / deny bị từ chối; W5 thêm/đóng/mở lại task trong `alp web`; W6 cổng token và hỏi đáp trên web |
| R5b | `18aa65f` | khớp | như R2, **Paseo 0.12.0** (`@getpaseo/cli` trong prefix riêng), daemon riêng 127.0.0.1:61857, tắt relay, `ALP_HOME` mới | pass; W3 lead chấm, anh xác nhận | W1 `paseo plugin add` (consumer) exit 0, `alp-provider` running, 0 dòng `requires Paseo`; W2 Phở và Cafe; W3 Claude stream (dòng 205→419→675→939→1199→1369), Stop ở 1178, prompt sau trả lời đúng |
| R7 | `18aa65f` | — (mã nguồn) | như R2, sau `npm ci && npm run build` ở release SHA; chỉ Claude (nửa Codex bỏ qua) | pass | `beta-acceptance-r7.mjs --live --sha`: R7-source pass, R7-claude `worktree-e2e` exit 0 |
| P4 | `18aa65f` | `c6fa00c2…8eee` (`shasum -c` OK) | macOS 27 arm64, Node 24.22.0, npm 11.19.1 | pass, trừ R1 (waived) | `release:gate --phase publish`: mọi dòng chặn pass trừ R1; `npm whoami` = `anhlp`; cả 8 E404 ở `0.0.1-beta.3`; trước publish `beta` = `latest` = `0.0.0-beta.2` cả 8 |
| P5 | `18aa65f` | asset tải lại: `shasum -c` 8/8 OK, manifest giống từng byte | như P4 | **go**, anh quyết định 2026-10-20 (bỏ qua các dòng Codex) | tag `v0.0.1-beta.3` (annotated `cbb7317`) đã push, trỏ `18aa65f`; GitHub prerelease draft, 8 tarball + `SHA256SUMS` + `release-manifest.json` |
| Publish (§7.4) | `18aa65f` | `shasum -c` OK trước khi publish; dry-run: tên, version, tag `beta`, số file (44, 144, 97, 69, 36, 47, 120, 175) và integrity khớp manifest, không có bước build | như P4; token granular bypass 2FA (không OTP) | pass 8/8, 2026-10-20 | `npm publish ./<file>.tgz --tag beta --access public`, từng package; `dist.integrity` trên registry khớp manifest cả 8 (bảng dưới). Lần thử đầu 04:04Z dừng ở protocol với `E403 E_STAGE_REQUIRED` (token đầu chỉ được staged publish); không có gì lên registry; anh cấp token khác, chạy lại cùng script từ đầu |
| Q1 | `18aa65f` | `dist.integrity` khớp manifest 8/8 | như P4 | pass, 04:37:38Z | `beta` = `0.0.1-beta.3` cả 8; `latest` trước Q4 = `0.0.0-beta.2` cả 8 (đúng dự kiến §12.4) |
| Q2 | `18aa65f` | lockfile consumer: `integrity` khớp manifest 8/8, `resolved` là `registry.npmjs.org` | như P4; HOME mới (cache rỗng, không `.npmrc`), prefix riêng; Linux không chạy (D7) | pass (macOS) | `npm install -g --prefix … @anhlp/alp@beta @anhlp/alp-paseo@beta` exit 0: mọi `@anhlp/*` trong cây là `0.0.1-beta.3`; `alp --version` = `0.0.1-beta.3` |
| Q3 | `18aa65f` | bản cài của Q2 | như P4, Claude Code 2.1.304; Paseo 0.12.0 và 0.11.4, mỗi bản một daemon riêng (`PASEO_HOME` dưới `/tmp`, cổng 61950 / 61960, tắt relay), chạy lần lượt; `ALP_HOME` tạm 0700 | pass; C4 và W6 lead chấm, anh xác nhận | C1 `alp doctor` 0 failed; C2 alpd `0.0.1-beta.3` live/ready; C4 (Claude, team pho) trả lời đúng 3 file, `alp ps --all` có session. **`paseo plugin add npm:@anhlp/alp-paseo@beta` exit 0 trên cả Paseo 0.12.0 và 0.11.4**: `alp-provider` running, revision `0.0.1-beta.3`, 0 dòng `requires Paseo`; W2 Phở và Cafe trên cả hai. W6: `alp-web-integration --register` (bản cài Q2), không token / sai token bị từ chối, đúng token được nhận; web thấy project. `release:gate --phase latest`: Q1–Q3 pass, exit 1 chỉ vì R1 |
| Q4 | `18aa65f` | `c6fa00c2…8eee` | như P4 | pass, 04:44:16Z (anh xác nhận các bước do lead chấm và cho go lúc 04:44Z) | `npm dist-tag add @anhlp/<pkg>@0.0.1-beta.3 latest` cả 8; `npm view … dist-tags`: `latest` = `beta` = `0.0.1-beta.3` cả 8 (packument của `alp-paseo` trễ vài giây so với endpoint dist-tags) |
| Q5 | `18aa65f` | `c6fa00c2…8eee` | như P4; HOME mới, prefix `/tmp/alp-b3q/q5` | pass, 04:44:50Z | `npm install -g @anhlp/alp @anhlp/alp-paseo` không tag (232 package) exit 0: mọi `@anhlp/*` trong cây là `0.0.1-beta.3` |
| Announce | `18aa65f` | asset không đổi (10 file) | — | xong, 04:45:23Z | `release:gate --phase announce`: Q1–Q5 pass, exit 1 chỉ vì R1 (waived); `gh release edit v0.0.1-beta.3 --notes-file … --draft=false`: [prerelease v0.0.1-beta.3](https://github.com/phucanh08/alp/releases/tag/v0.0.1-beta.3) |

Publish `0.0.1-beta.3` ngày 2026-10-20 (giờ UTC). "Registry" là `time["0.0.1-beta.3"]` trong
packument. Dist-tags đọc lúc 04:37:38Z, sau package cuối. Sau Q4 (04:44:16Z), `latest` =
`beta` = `0.0.1-beta.3` cả 8.

| # | Package | Lệnh publish xong | Registry | `dist.integrity` | `beta` | `latest` (trước Q4) |
|---|---|---|---|---|---|---|
| 1 | `@anhlp/alp-protocol` | 04:19:35Z | 04:20:51Z | khớp | `0.0.1-beta.3` | `0.0.0-beta.2` |
| 2 | `@anhlp/alp-core` | 04:21:12Z | 04:23:23Z | khớp | `0.0.1-beta.3` | `0.0.0-beta.2` |
| 3 | `@anhlp/alp-runtime` | 04:23:41Z | 04:24:36Z | khớp | `0.0.1-beta.3` | `0.0.0-beta.2` |
| 4 | `@anhlp/alp-client` | 04:24:48Z | 04:25:43Z | khớp | `0.0.1-beta.3` | `0.0.0-beta.2` |
| 5 | `@anhlp/alp-daemon` | 04:26:05Z | 04:28:11Z | khớp | `0.0.1-beta.3` | `0.0.0-beta.2` |
| 6 | `@anhlp/alp-cli` | 04:28:34Z | 04:31:13Z | khớp | `0.0.1-beta.3` | `0.0.0-beta.2` |
| 7 | `@anhlp/alp-paseo` | 04:31:38Z | 04:35:51Z | khớp | `0.0.1-beta.3` | `0.0.0-beta.2` |
| 8 | `@anhlp/alp` | 04:36:03Z | 04:37:00Z | khớp | `0.0.1-beta.3` | `0.0.0-beta.2` |

Khác với beta.2 khi chạy:
- **Bỏ qua Codex.** Anh quyết định ngày 2026-10-20 03:11Z bỏ qua mọi dòng Codex của beta.3 (R1,
  nửa Codex của R5 và R7) vì Codex CLI hết hạn mức; chỉ test Claude Code thật. `release:gate`
  không có trạng thái cho dòng được bỏ qua nên cả ba phase exit 1 chỉ vì R1; anh chấp nhận điều đó
  cho từng bước (P5, Q4, announce). Release notes ghi rằng beta này không chạy Codex thật.
- **Paseo 0.12.0 và 0.11.4.** R5 trên 0.11.4, R5b trên 0.12.0; Q3 chạy `paseo plugin add npm:` trên
  cả hai, mỗi bản một daemon Paseo riêng, như cách làm của beta.2 (§11.6): `~/.paseo`, `~/.alp`,
  bản cài global và alpd của anh không bị đụng.
- **Token npm.** Không `npm login`: anh cấp token granular bypass 2FA. Token đầu bị registry trả
  `E_STAGE_REQUIRED` (chỉ được `npm stage publish`); dừng ngay, không có gì lên registry; token thứ
  hai publish thẳng được. Không cần OTP.
- **Bước cần người đọc** (C5 chạy lại của R2; W3–W6 của R5; W3 của R5b; C4 và nửa trình duyệt W6
  của Q3) do lead chấm từ log và ảnh chụp, ghi trong trường `runner` của evidence; anh xác nhận
  trước Q4.
- Gate và Q dùng Node 24.22.0 tải từ nodejs.org, như beta.1 và beta.2.

Evidence (output lệnh, lockfile, ảnh chụp) nằm ngoài repo, trên máy anh: `~/alp-release/evidence/beta3/`,
`~/alp-release/evidence/q-18aa65f/`, `~/alp-release/runs/{18aa65f-cli-claude,r5-18aa65f,r5b-18aa65f}/`;
các dòng đã ghi vào `~/alp-release/release-evidence-18aa65f.json`.


## 13. Beta.4 (`0.0.1-beta.4`)

Chuẩn bị ngày 2026-10-27 (task t-23bf), nhánh `release/0.0.1-beta.4` từ `origin/main`
`353b3edc062504cf7aa18a4910a98d7aa810bd1c`. Chưa publish; chưa có dòng gate nào được
coi là pass trên release SHA. Kết quả sẽ lưu ngoài checkout, gắn SHA và checksum tarball.

### 13.1 Phạm vi

- Cùng tám package public của §2, version `0.0.1-beta.4`, dependency nội bộ pin đúng version.
  Ba workspace private vẫn không publish riêng; mọi manifest và acceptance VERSION đồng bộ.
- Remote terminals (mặc định tắt), dependency optional `node-pty`, CLI `alp web` với app ALP
  và gateway nhúng, đổi integration Paseo sang `paseo` và bỏ web Paseo. Chi tiết và giới hạn:
  [beta-release-notes.md](beta-release-notes.md), mục beta.4.
- Paseo `>=0.11.1 <1.0.0` (đã mở range sau beta.3); nền tảng như §12; Windows alp-web chưa được test.
  Không sửa backlog trong release này.

### 13.2 Gate và phát hành

Dùng lại §12.2–§12.4 và §7 với version/tag mới `0.0.1-beta.4` / `v0.0.1-beta.4`:

- Review độc lập đúng SHA cuối; CI đầy đủ trên SHA đó, gồm H1–H4, SDK floor và H6
  `paseo-compat`; kiểm `git diff --check`, build/pack/consumer, license và audit.
- Merge vào main chỉ sau review pass và toàn bộ CI xanh. Workflow `release-acceptance`
  pack một lần trên release SHA ở main; dùng đúng tám tarball đó cho A5 và acceptance.
- R1, R2, R5, R5b và R7 vẫn chặn như §12.2. Việc bỏ Codex của beta.3 chỉ áp dụng beta.3;
  không mang waiver đó sang beta.4. Mọi thiếu sót phải báo người điều phối trước publication.
- Publish tay đúng thứ tự §7.4, từ saved tarball, `--tag beta --access public`.
  Q1–Q3 kiểm registry/integrity, install sạch và plugin Paseo trước khi chuyển `latest` ở Q4;
  Q5 kiểm install không tag. Không unpublish, ghi đè version hay deprecate bản cũ.
- GitHub prerelease giữ draft tới khi phase `announce` của release gate qua.

### 13.3 Kết quả

Pending: release SHA, review, CI, artifact checks, real-provider acceptance, publication và Q1–Q5.
