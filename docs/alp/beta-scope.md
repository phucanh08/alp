# Phạm vi beta đầu tiên (`0.0.0-beta.1`)

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

Phương án deprecate cho các bản cũ không xóa được (anh tự chạy; `latest` chuyển sang beta theo D2,
§1.2):

```sh
# [Docs npm] Range có gồm cả prerelease (1.x gồm 1.0.0-beta.0), nên KHÔNG dùng range kiểu "<=0.10.0"
# vì nó có thể gồm 0.0.0-beta.1. Liệt kê rõ các bản cũ:
npm deprecate "@anhlp/alp@>=0.3.0 <=0.10.0" "Bản cũ. Cài bản beta: npm install -g @anhlp/alp@beta"
npm deprecate "@anhlp/alp@0.0.0-stage"      "Bản cũ. Cài bản beta: npm install -g @anhlp/alp@beta"
# 6 package core: lấy danh sách bằng `npm view <pkg> versions --json`, rồi deprecate từng version cụ thể.
# Tên plugin cũ không có bản beta nào, nên deprecate cả package (bị bỏ khỏi kết quả tìm kiếm):
npm deprecate alp-paseo-plugin "Đổi tên: paseo plugin remove alp-provider && paseo plugin add npm:@anhlp/alp-paseo@beta"
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
- **Chưa rõ** (docs không nói): khi một tên chưa có `latest` (tên mới như `@anhlp/alp-paseo`, hoặc
  tên vừa unpublish hết) mà publish lần đầu chỉ với `--tag beta`, registry có tự gán `latest` hay
  không. Xác nhận ở Q1 (§7.5) và ghi kết quả vào đây.

### 1.3 Nguồn

- <https://docs.npmjs.com/policies/unpublish>
- <https://docs.npmjs.com/cli/v11/commands/npm-dist-tag>
- <https://docs.npmjs.com/cli/v11/commands/npm-publish>
- <https://docs.npmjs.com/cli/v11/commands/npm-deprecate>

## 2. Package phát hành

| Package | Beta | Ghi chú |
|---|---|---|
| `@anhlp/alp` | Phát hành | `alp`, `alpd`; không chứa Paseo |
| `@anhlp/alp-protocol`, `-core`, `-runtime`, `-client`, `-daemon`, `-cli` | Phát hành (bắt buộc) | root và plugin pin đúng version |
| `@anhlp/alp-paseo` | Phát hành | plugin Paseo, `alp web` (bản fork web Paseo, Apache-2.0), `alp-web-integration` |
| `@anhlp/alp-gateway` | **Không phát hành** (deferred) | chờ nghiệm thu web; [Local] chưa có `private: true` (T2) |
| `@anhlp/alp-web` (`apps/web`) | Không phát hành (deferred) | private; chưa nghiệm thu |
| `@anhlp/alp-tui` | Không phát hành | private, rỗng |

Thứ tự publish: protocol → core → runtime → client → daemon → cli → plugin → root (§7.4).

## 3. Nền tảng

| | Supported | Experimental | Không hỗ trợ |
|---|---|---|---|
| OS | macOS (nền tảng test chính, D7), Linux (CI hermetic và fake; provider thật khi có thể) | Windows: CLI và alpd cục bộ; không có `alp daemon install`; CI chỉ chạy subset daemon/IPC và fake; test thật khi có thể | — |
| Node | 22.12+, 24 | 26 (chỉ có bằng chứng local) | 20 (EOL 2026-04-30) |
| Provider | Codex CLI, Claude Code | ACP (OpenCode, Gemini CLI), Antigravity (full-access; read-only chỉ là lời dặn trong prompt) | — |
| Host Paseo | `>=0.11.1 <0.12.0` | — | 0.12 trở lên |

[Local] `engines` hiện vẫn ghi `>=20` ở mọi package; nâng lên `>=22.12` là T3, chưa làm.

## 4. Tính năng

**Included** (nằm trong acceptance gate; coverage ở §6.2):
- CLI và alpd: `init`, `upgrade`, `setup`, `doctor`, `daemon start|stop|restart|status`, `run`,
  `ps`, `top`, `attach`, `send`, `questions`, `answer`, `log`, `interrupt`, `board`, `tasks`/`task`,
  `formula`, `verify`, `recall`, `pause`/`resume`, `backup`/`restore`.
- Teams Phở và Cafe, team tự định nghĩa, permission profiles và duyệt quyền (Allow once / Always
  allow / Deny), worktree và `alp_merge`, tạm dừng khi hết usage, phục hồi sau khi alpd restart
  hoặc crash.
- Plugin Paseo: provider `alp`, Tasks panel, Settings → ALP, ALP project panel, giám sát alpd.
- `alp web` cục bộ, chỉ loopback (port 7433, có token), qua `alp-web-integration`.

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

Mọi dòng chạy trên **cùng release SHA** và, với các dòng cài đặt, trên **đúng 8 tarball đã lưu**
(§7.2). Ghi SHA, link CI, SHA-256 tarball đã dùng và kết quả vào bảng §6.4.

### 6.1 Pre-publish gate

**CI và hermetic** (gate cho mã nguồn ở release SHA, không cho tarball):

| # | Kiểm tra | Môi trường | Người chạy | Chặn |
|---|---|---|---|---|
| H1 | CI `core` và `paseo` (`validate:core`, `validate:paseo`) | Ubuntu, Node 22 và 24 | CI | Có |
| H2 | `npm run validate:core` và `npm run validate:paseo` tại release SHA | macOS, Node 24 (CI `core-paseo-macos`, D8) | CI | Có; evidence là link run CI ở release SHA |
| H3 | CI `packages-and-web` (`validate:packages`, `web-app-smoke`) | Ubuntu, Node 22 | CI | Có |
| H4 | CI `windows-daemon` | Windows, Node 22 và 24 | CI | Có (giữ lane xanh) |
| H5 | CI `alp-web` | Ubuntu, macOS | CI | Không (app chưa phát hành) |
| L1 | License, trường `license`, metadata repo trỏ `phucanh08/alp` | — | task T4 | Có |
| S1 | Phân loại `npm audit` mức high/critical trong dependency runtime của 8 package | — | task T6 | Có |

**Artifact** (trên 8 tarball đã lưu):

| # | Kiểm tra | Môi trường | Người chạy | Chặn |
|---|---|---|---|---|
| A5 | `npm run release:verify -- "$OUT" --sha "$RELEASE_SHA" --record release-evidence.json` (`release:pack` cũng tự chạy A5). Kiểm: checksum khớp `SHA256SUMS`; đúng 8 tarball, không có tgz thừa (gateway); version `0.0.0-beta.1`; `entryCount` khớp số file trong tgz; dependency nội bộ trong `package.json` **đã pack** pin đúng version và chỉ trỏ tới 8 package; LICENSE mọi tarball giống tarball root; NOTICE; THIRD-PARTY-NOTICES liệt kê mọi module esbuild đã inline; plugin có `web-app/LICENSE.paseo.txt`, `NOTICE.txt`, và NOTICE = NOTICE root + Paseo; core không có đường dẫn hay dependency Paseo | máy build | người build (§7.2) | Có |

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
| **Duyệt quyền** (permission profile hỏi user: Allow once / Always allow / Deny, qua `alp answer` hoặc Paseo) | `test/integration/permissions.test.js`: `:102` Codex hỏi ALP trước khi ra khỏi sandbox; `:191` Claude hỏi cho rule `ask` và cho việc mode read-only từ chối; `:213` user trả lời, Always allow ghi rule và thôi hỏi; `:320` Always allow ghi vào đúng file định nghĩa profile; `:285` câu hỏi và câu trả lời tiếng Việt. Paseo (T10, chưa commit): `integrations/paseo/tests/permissions.test.js:58` câu hỏi quyền là question card, Allow once / Always allow / Deny (Codex `requestApproval`, Claude `canUseTool`) về đúng request, Always allow ghi `Bash(npm install *)`, rule `ask` chỉ có hai lựa chọn; `:116` đóng card, trả lời rỗng, trả lời câu đã xử lý, Stop khi card đang chờ đều để request bị từ chối; `:154` Always allow còn hiệu lực với provider/runtime mới; `integrations/paseo/tests/paseo-web.test.js:267` cùng luồng qua `alp web`. Lane: `validate:paseo` (H1, H2) | Chưa có. `test/e2e/human-e2e.mjs` chỉ trả lời câu hỏi `alp_ask`, không phải câu hỏi quyền | C6 (CLI), W4 (Paseo) | (1) Test Paseo đã có (T10). [Local] Pass 17/17 trên Windows, Node 26.8.1, checkout bẩn; chưa pass trên release SHA. (2) Chưa có E2E thật; C6 và W4 là bằng chứng tối thiểu |
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
- Dùng user OS riêng, hoặc chép `~/.alp` ra chỗ khác khi alpd đã dừng, vì Paseo đọc `ALP_HOME`
  mặc định.
- Chép nguyên thư mục `$OUT` của §7.2 (8 tarball, `SHA256SUMS`, `release-manifest.json`) sang
  `/tmp/alp-beta/packs`, rồi kiểm: `shasum -a 256 -c SHA256SUMS` (macOS) hoặc `sha256sum -c SHA256SUMS`
  (Linux).
- Kiểm hermetic, không gọi provider, trong một checkout ở `RELEASE_SHA`:
  `npm run release:consumer -- /tmp/alp-beta/packs`. Script cài đúng 8 tarball đã lưu, so
  `integrity`/`resolved` (`file:`) trong lockfile với manifest, chạy `tarball-consumer` và
  `package-smoke` với `--packs`, rồi kiểm lại SHA-256 sau khi chạy. Bước này không thay các dòng R.

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
  - gỡ plugin sau khi chạy: `paseo plugin remove alp-provider`.
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
| W6 | `alp-web-integration --register`; `alp web --print`; mở địa chỉ trên máy đó (Linux headless: `ssh -L 7433:127.0.0.1:7433 <host>`, mở trên máy mình) | thấy project và session của W3; hỏi đáp và Tasks hoạt động; truy cập không có token bị từ chối |

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
| Ghi chú | `6765826`, `dc2621c` | — | — | bị thay | live trên hai SHA này tìm ra lỗi, sửa ở PR #105, #106; bộ tarball cũ không dùng |

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
  - Chạy A5, rồi R1–R6 trên các tarball của §7.2; R7 và H2 trên `RELEASE_SHA`.
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

Thứ tự theo dependency: protocol → core → runtime → client → daemon → cli → plugin → root.

```sh
cd /tmp/alp-release/v0.0.0-beta.1
shasum -a 256 -c SHA256SUMS
for f in anhlp-alp-protocol anhlp-alp-core anhlp-alp-runtime anhlp-alp-client \
         anhlp-alp-daemon anhlp-alp-cli anhlp-alp-paseo anhlp-alp; do
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
# … lặp lại cho core, runtime, client, daemon, cli, alp-paseo, rồi alp (root)
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
    - plugin cũ: `paseo plugin remove alp-provider`, rồi `paseo plugin add npm:@anhlp/alp-paseo@beta`;
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
| T7 | Dọn npm: unpublish nếu đủ điều kiện, không thì deprecate (§1.1), gồm cả tên plugin cũ `alp-paseo-plugin` | anh làm | hoãn tới sau publish (§10, P5) |
| T8 | Chạy §6 và §7, ghi kết quả vào §6.4 | anh (macOS, D7; H2 trên CI theo D8) | gate `publish` pass ở `2230aa5` (2026-10-16); còn P5, publish, Q1–Q5 (anh) |
| T9 | Đưa client SDK smoke vào CI; workflow publish; ~~thêm macOS vào lane `core`/`paseo`~~ (đã làm theo D8) | Không (sau beta) | deferred; phần acceptance Linux kéo lên trước theo D6 (T12) |
| T12 | Workflow `release-acceptance` (D6, D7): pack một lần trên CI + `release:consumer` + rehearsal fake (Codex, Claude, W6) trên macOS, Ubuntu, Windows | Có (pack là bộ tarball của release) | xong (PR #102); bộ tarball release: [release-acceptance 38901108957](https://github.com/phucanh08/alp/actions/runs/38901108957) |
| T10 | Test fake-provider cho câu hỏi quyền trong Paseo (§6.2, hàng duyệt quyền, ý 1) | Có | xong: test đã merge, pass trong `validate:paseo` ở release SHA (H1, H2) |
| T11 | Sửa F3 (`linkify-it@2.2.0` trong `alp web`); owner anh | Không chặn beta.1; chặn beta.2, hạn 2026-11-15 | chưa làm |
| T13 | Claude stream text vào Paseo/`alp web` (`includePartialMessages`, map `stream_event`) | Không chặn beta.1 (known issue, anh chấp nhận 2026-10-16) | chưa làm; [#107](https://github.com/phucanh08/alp/issues/107) |

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

Không còn quyết định nào mở trong scope này.
