# Handoff: sự cố alp 0.0.1-beta.5 + chuyển alp sang Node runtime kèm theo (2026-10-30)

Repo: `/Users/anhlp/StudioProjects/alp` (fork getpaseo/paseo, remote `origin` = phucanh08/alp).
Worktree đang làm: `/Users/anhlp/StudioProjects/alp-fix-claude-sdk`, nhánh `fix/binary-claude-sdk` (từ `origin/main`, đã `npm ci`).
Không đụng vào checkout chính (`/Users/anhlp/StudioProjects/alp`, nhánh `fix/145-...`, có file untracked của anh).

## 1. Sự cố beta5 (đã xử lý xong phần khẩn)

Lỗi: mọi session Claude trên beta5 báo
`Cannot find package '@anthropic-ai/claude-agent-sdk' imported from /$bunfs/root/alp`.

Nguyên nhân: beta5 là executable `bun build --compile` (t-1e02, `scripts/build-binary.mjs`), không có
`node_modules`. `packages/runtime/src/claude-transport.ts` import SDK bằng tên ghép lúc chạy
(`['@anthropic-ai','claude-agent-sdk'].join('/')`, cố ý để Paseo plugin compiler không thấy) nên Bun không
nhúng SDK. Codex/ACP không bị vì chạy CLI ngoài.

Đã làm:
- PR **#274** (OPEN, mergeable) https://github.com/phucanh08/alp/pull/274, commit `014a296`:
  entry của binary đăng ký `modules: {'@anthropic-ai/claude-agent-sdk': () => import('@anthropic-ai/claude-agent-sdk')}`;
  `claude-transport.ts` có `claudeSdk()` lấy từ `packagedInfo()?.modules` khi packaged, ngược lại import cũ;
  typedef `modules` trong `packages/core/src/packaged.js`; 1 câu trong `docs/alp/binary-install.md`.
  Đã kiểm: binary beta5 cài sẵn → lỗi trên; binary build từ nhánh (darwin-arm64), `ALP_HOME` tạm,
  `alp setup --runtime claude` + `alp run "Reply with exactly: PONG"` → `main: PONG`, `supervisor: sound`.
  `tsc -p tsconfig.core.json` sạch; `npm test -w packages/runtime` 313/313.
  Chưa có bước regression trong `scripts/binary-smoke.mjs` (transport đòi `claude` native, fake là script).
- Máy anh: đã `npm install -g @anhlp/alp@0.0.1-beta.4`, `alp daemon restart` → alpd 0.0.1-beta.4.
  Session parked `08f8dbae…` (Codex hết quota) vẫn trong `alp ps --all`.
- npm (đã kiểm trên registry):
  - unpublish 0.0.1-beta.5: `@anhlp/alp`, `alp-cli`, 5 gói `alp-<os>-<arch>` (các gói này giờ chỉ còn `0.0.0-stage`).
  - deprecate 0.0.1-beta.5 (npm không cho unpublish vì có dependents): `alp-daemon`, `alp-runtime`,
    `alp-client`, `alp-core`, `alp-protocol`.
  - dist-tag `latest` + `beta` = `0.0.1-beta.4` cho alp, alp-cli, daemon, runtime, client, core, protocol.
  - ⇒ số version 0.0.1-beta.5 không dùng lại được; bản sau phải là **0.0.1-beta.6**.
  - Token trong `~/.npmrc` là granular bypass-2FA: không unpublish/deprecate được; thao tác đó cần
    `npm login --auth-type=web --userconfig <tmp>` và chạy dưới pseudo-TTY (`script -q log npm …`) để npm chờ web 2FA
    (mỗi thao tác một lần xác thực).

## 2. Việc còn mở

A. **GitHub Release** (chưa làm, chờ anh quyết): `v0.0.1-beta.5` đang là "Latest" (non-prerelease theo
   policy commit a040871), nên `install.sh` (`releases/latest/download`) và `alp update` vẫn lấy beta5.
   beta4 trở về trước là Pre-release và (có lẽ) không có archive binary — kiểm tra trước khi đổi
   "Latest". Lựa chọn: xoá/đánh pre-release beta5, hoặc ra beta6 thật nhanh từ PR #274.

B. **Ra beta6**: merge #274 → quy trình release thường lệ (version policy, tag, workflow
   `release-binaries.yml`, publish npm). Chưa bump version, chưa tag.

C. **Chuyển alp sang chạy trên Node chính thức kèm theo, như daemon của Paseo** (anh đã chốt
   "Kèm Node chính thức"). Plan: `plans/261030-node-runtime-bundle/plan.md` (cùng thư mục, **chưa commit**,
   đang nằm untracked trong worktree của nhánh #274 — chuyển sang nhánh mới, đừng commit vào #274).
   Paseo 0.13.2 (đã soi `/Applications/Paseo.app`): Electron; `bin/paseo` là sh chạy `Paseo Helper` với
   `ELECTRON_RUN_AS_NODE=1` + `@getpaseo/cli/dist/index.js`; `app.asar` có node_modules thật
   (`@anthropic-ai/claude-agent-sdk` 0.3.246 import tĩnh, `@agentclientprotocol/sdk`); native ở
   `app.asar.unpacked`; Claude dùng `claude` trên PATH (`resolveClaudeBinary`), Codex = `codex app-server`,
   ACP = spawn lệnh qua stdio.
   Hai điểm **anh chưa trả lời** (hỏi lại trước khi làm):
   1. Người dùng beta5/6 dạng một file: `alp update` của họ chỉ thay một file → (a) bản chuyển tiếp có
      shim, hay (b) ghi rõ phải chạy lại `install.sh` (đề xuất b).
   2. npm: `@anhlp/alp` phụ thuộc thẳng `@anhlp/alp-cli` và bỏ các gói `@anhlp/alp-<os>-<arch>` (t-cd7f)? (đề xuất có).
   Ghi chú kỹ thuật: `@anhlp/alp-cli` đã là bản JS tự chứa (bin `dist/cli.js`, engines node >=22.12,
   optional `node-pty`); dưới Node thật, các nhánh "không packaged" của `packaged.js`
   (`selfCommand`/`entryCommand`/service) đã chạy đúng → bundle = node + `npm install` alp-cli + launcher.
   Loại `@anthropic-ai/claude-agent-sdk-<platform>` (~250MB, alp luôn truyền `pathToClaudeCodeExecutable`).
   Service (launchd/systemd, `packages/client/src/service.js`) phải trỏ qua đường dẫn ổn định
   (`~/.alp/app/current`), không vào thư mục theo version. Sau khi chuyển, gỡ code chỉ dành cho Bun
   (asset cache, `isScript` guard, `BUN_BE_BUN`, fd writer ConPTY/conpty.dll nhúng, `modules` của #274) và
   ghi `docs/breaking-changes.md`.

## Quy ước repo cần giữ
- Thin rename: giữ scope `@getpaseo/*`, env `PASEO_*`; divergence ghi `docs/breaking-changes.md` (không xoá dòng).
- Không deploy relay/website/app. Commit/push/publish chỉ khi anh yêu cầu.
