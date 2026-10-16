# L1/T4 — Rà license và metadata (trước khi anh chốt)

Ngày 2026-10-16, working tree chưa commit (HEAD 5c474f8). Chưa sửa file nào của repo.
Nhãn: **[Local]** đọc repo, **[Pack]** `npm pack --dry-run --json` (Node 26.8.1, npm 11.19.0),
**[Docs]** nguồn chính thức, **[Suy luận]** chưa kiểm chứng. Bằng chứng thô: `.cache/l1-evidence/`.

## Hiện trạng

- [Local] Không có LICENSE ở gốc; không manifest nào có trường `license` (8 package phát hành + gateway/web/tui).
- [Local] `repository`/`homepage`/`bugs` trỏ `phucanh08/alp-paseo` (root, 6 core, plugin, gateway). Core không có
  `homepage`/`bugs`; root không có `bugs`. Origin là `https://github.com/phucanh08/alp`; API GitHub trả
  "Moved Permanently" cho `alp-paseo` (đã đổi tên).
- [Local] Ngoài manifest còn trỏ `alp-paseo`: `packages/runtime/src/github.ts:5` (`ALP_REPO`, code chạy thật),
  test `packages/runtime/tests/supervisor.test.js:257-288`, patch web 0005/0007/0009, `integrations/paseo/README.md:106,118`,
  `docs/alp/team-workflow.md:971`.
- [Pack] Có file license trong tarball: chỉ plugin, ở `server/dist/web-app/LICENSE.paseo.txt` và `NOTICE.txt`
  (do `scripts/build-paseo-web.mjs` chép vào khi build web). 7 tarball còn lại: không có.
- [Local] `paseo-web/LICENSE` giống hệt LICENSE upstream tại commit pin `b63a325` (chỉ khác EOL): Apache-2.0,
  "Copyright (c) 2025-present Mohamed Boudra", thành phần bên thứ ba giữ license riêng. Upstream không có file NOTICE;
  `paseo-web/NOTICE` là ALP tự viết (mô tả patch).
- [Local] Code chép từ Paseo nằm cả trong **server của plugin**, không chỉ web: `integrations/paseo/server/paseo/`
  `chat-search.ts`, `checkout.ts` (diff parser), `relay-transport.ts`, `timeline-projection.ts`, `timeline-store.ts`,
  mỗi file có ghi attribution. Chúng được bundle vào `server/dist/*.js`; esbuild bỏ comment nên attribution không còn
  trong bundle. `NOTICE.txt` hiện chỉ nói về web app.
- [Local] Bundle còn inline code bên thứ ba (`.cache/l1-evidence/bundled*.txt`): root/cli/daemon/plugin chứa
  `@modelcontextprotocol/sdk`, `zod`, `ajv`, `cross-spawn`, `smol-toml`… (MIT, ISC, BSD-3-Clause, Apache-2.0 với
  `@agentclientprotocol/sdk`, Unlicense với `tweetnacl`); plugin thêm `@getpaseo/protocol`, `@getpaseo/relay` (không có
  trường license, thuộc repo Paseo). Web app (expo export) cũng chứa React… Không tarball nào kèm license của các gói này.
  protocol/core/runtime/client không bundle bên thứ ba.
- [Local] `templates/skills/*` (có trong tarball root/core) phỏng theo `phucanh08/alp-claude@f5f38dd`; repo đó
  public, GitHub không ghi license [Suy luận: của chính anh].
- [Local] Tác giả commit: `anhlp <phucanhdn08@gmail.com>` 203, `ETC\anhlp <anhlp@etc.vn>` 15, `Lê Phúc Anh
  <anhlp240198@gmail.com>` 2 (merge PR).

## Nguồn chính thức đã đối chiếu

- [Docs] npm package.json docs (v11): `license` dùng SPDX id; `UNLICENSED` nếu không cấp quyền; `SEE LICENSE IN <file>`
  với file ở top level. `LICENSE`/`LICENCE` luôn được đóng gói bất kể `files`. Tarball của workspace đóng gói từ thư
  mục workspace [Suy luận đã khớp Pack: LICENSE gốc không tự vào tarball workspace].
- [Docs] Apache-2.0 §4 (văn bản trong `paseo-web/LICENSE:99-138`): (a) kèm bản License; (b) file sửa phải ghi rõ đã sửa;
  (c) giữ notice bản quyền/attribution trong Source; (d) nếu Work có NOTICE thì kèm attribution trong NOTICE; được thêm
  copyright và điều khoản riêng cho phần sửa đổi.
- Không phải tư vấn pháp lý; các điểm trên chỉ là đọc văn bản license/docs.

## Quyết định của anh (2026-10-16 13:45)

License **Apache-2.0**. Copyright **"Copyright 2026 Lê Phúc Anh"** (dự án cá nhân). THIRD-PARTY-NOTICES cho bundle
(phương án a, riêng web app hoãn). Cho phép sửa link `alp-paseo` trong code, test, docs và patch web.

## Đã triển khai

- `LICENSE` gốc là văn bản tải từ https://www.apache.org/licenses/LICENSE-2.0.txt, sha256 `cfc7749b…3d30`
  (bản thô: `.cache/l1-evidence/apache-2.0-official.txt`). Bản giống hệt nằm trong `packages/*`, `integrations/paseo`, `apps/gateway`.
- `NOTICE` gốc gồm tên ALP, copyright, và trỏ tới THIRD-PARTY-NOTICES; bản giống hệt nằm trong 6 core + gateway.
  `integrations/paseo/NOTICE` = NOTICE gốc + attribution Paseo: web app, 5 file server chép từ Paseo (`b63a325`), và
  `@getpaseo/protocol`/`relay` được bundle.
- `scripts/third-party-notices.mjs`: đọc metafile của esbuild để tìm các gói trong node_modules, rồi ghi tên, version,
  license và văn bản LICENSE (kèm NOTICE nếu có). `@getpaseo/*` không có file license nên dùng `paseo-web/LICENSE`.
  Gói nào thiếu license thì build fail. Script được gọi từ `build-workspace.mjs` (cli, daemon), `build-core.mjs`
  (root `dist/`) và `build-paseo.mjs` (`server/dist/`).
- Manifest (8 package + gateway):
  - `license: Apache-2.0`.
  - `repository`: `git+https://github.com/phucanh08/alp.git` (+`directory`).
  - `homepage`: root `…/alp#readme`; package `…/alp/tree/main/<dir>#readme`.
  - `bugs`: `…/alp/issues`.
  - `files` thêm `NOTICE`; root dùng `/NOTICE` để neo về gốc và thêm `dist/THIRD-PARTY-NOTICES.txt`.
  - Lockfile chỉ thêm 9 dòng `"license"` (`npm install --package-lock-only`, diff so với `.cache/l1-evidence/package-lock.before.json`).
- Link: `packages/runtime/src/github.ts` đổi thành `ALP_REPO = 'phucanh08/alp'`; cùng `supervisor.test.js`,
  `docs/alp/team-workflow.md`, `integrations/paseo/README.md`, patch web 0005/0007/0009.
- `scripts/pack-check.mjs` kiểm mỗi tarball không private:
  - `license` là Apache-2.0 và `repository` đúng.
  - LICENSE giống bản gốc.
  - NOTICE giống bản gốc; riêng plugin thì phải bắt đầu bằng NOTICE gốc và có phần Paseo.
  - Mọi gói esbuild inline (đọc từ comment `// <path>` trong .js đã pack) đều có trong THIRD-PARTY-NOTICES.
  - Nếu có web app thì phải có LICENSE.paseo.txt và NOTICE.txt.

Không đổi version, engines, cờ private. Không publish, không commit, không tag.

## Bằng chứng (`.cache/l1-evidence/`, Node 26.8.1, npm 11.19.0, Windows)

- `npm run build:packages` OK. `npm run build:web` exit 0 (19 patch, Paseo 0.11.2), log ở `build-web.log`.
- 19 patch apply được trên `b63a325` (thử trong worktree tạm, đã xóa). `git apply --check` gộp nhiều patch báo lỗi ngay cả
  với bản HEAD, vì check không xếp chồng các patch; apply thật thì OK.
- web-app trong plugin có 14 link `phucanh08/alp`, 0 link `alp-paseo`.
- `node scripts/pack-check.mjs --ignore-scripts`: cả 9 package báo "public exports and licences verified" (`pack-check.txt`).
- Mutation (`mutation-check.sh`, kết quả ở `mutation-check.txt`): xóa NOTICE của core, bỏ zod khỏi notices của daemon,
  sửa LICENSE của plugin. Lần nào cũng fail đúng; file đã khôi phục, hash khớp.
- File license trong từng tarball và shasum: `pack-summary.txt`. Danh sách gói trong notices: `notice-headings.txt`
  (khớp với lần quét độc lập lúc rà).
- `node --test packages/runtime/tests/supervisor.test.js`: 8/8 pass. `npm run check:boundaries` OK.

## Bổ sung 14:00–14:20: license web app (anh yêu cầu không hoãn), T1–T3

### T4: license bên thứ ba của web app
- `build-paseo-web.mjs`: chạy `expo export --source-maps`. Bước 4 đọc mọi `.map` (đường dẫn trong `sources` tính từ gốc
  checkout Paseo) và các asset `assets/__node_modules/<pkg>/`, rồi tìm package đã cài. Package nào không tìm thấy thì build
  fail. Sau đó build ghi `web-app/THIRD-PARTY-NOTICES.txt`, **xóa map** và bỏ dòng `sourceMappingURL` trước khi nén.
  Code của chính Paseo (`/packages/*`, không qua node_modules) nằm dưới LICENSE.paseo.txt.
- `third-party-notices.mjs`: thêm `writeNoticesFor`, regex package scoped chặt hơn, xử lý `@getpaseo/*` khai MIT.
  Package khai MIT mà không có file license thì kèm văn bản MIT chuẩn của SPDX, cùng author và repository trong
  package.json; license khác mà thiếu file thì build fail.
- `paseo-web/NOTICE` (= web-app/NOTICE.txt) và `integrations/paseo/NOTICE` trỏ tới file này; pack-check bắt buộc file có mặt.
- Kết quả: 213 package (MIT 196, ISC 6, BSD-2 5, BSD-3 3, Apache-2.0 1, Beerware 1, Unlicense 1). 29 package MIT
  (Expo, @react-native/*, @radix-ui/*…) không có file license nên dùng văn bản SPDX. Ship 0 map; 0 JS còn `sourceMappingURL`
  (`web-notices.txt`, `build-web-3.log`). Xóa file → pack-check fail (`mutation-web.txt`).

### T1: version 0.0.0-beta.1
- 11 manifest (8 phát hành + gateway, tui, web): `version` và mọi pin `@anhlp/*` đổi thành `0.0.0-beta.1` (script
  `set-release-manifest.cjs`; bản trước khi sửa: `manifest-before-*.json`).
- Lockfile đã được cập nhật lúc 14:00 (lệnh `npm install --package-lock-only` của em bị từ chối; không rõ ai chạy).
  Kiểm read-only `lock-consistency.cjs`: mọi workspace khớp manifest (version, license, engines, pin), 0 chuỗi `"0.0.0-beta"`.
- Ngoài plans/beta-scope, repo không còn `0.0.0-beta` thiếu `.1`. Build lại: bundle ghi `0.0.0-beta.1`.

### T2: gateway private
- `apps/gateway/package.json` có `"private": true` (đặt sau `version`). `npm pack --workspace=@anhlp/alp-gateway --dry-run`
  vẫn chạy được (38 file), tức `gateway-smoke` vẫn pack được. pack-check giờ chỉ kiểm đúng 8 package.

### T3: engines
- `engines.node` `>=22.12` cho 8 package phát hành; gateway giữ `>=20`, web giữ `^20.19.0 || >=22.12.0` (private).
- Phần docs (codex-only.md:14, adapter-boundary.md:13, remote-gateway.md:517) đã gửi agent docs 605c5380.
- Root package.json: thêm 5 script `release:*` theo đề nghị của agent release-gate 19f2ed3a; các file script do bạn ấy tạo.

### Kiểm sau cùng (Node 26.8.1)
- `npm run build:packages`, `npm run build:web` OK. `npm --script-shell=cmd.exe run check` exit 0 (`check.log`).
- `npm test`: 778 test, 735 pass, 0 fail, 43 skip (`test.log`).
- `pack-check --ignore-scripts`: 8/8 "public exports and licences verified" (`pack-check-2.txt`). Danh sách file
  license và shasum từng tarball: `pack-summary.txt`.

## Còn mở

- Chưa chạy full release gate, A5 trên macOS (pack thật từ release SHA), CI.
- 29 package MIT không có file license: văn bản là bản SPDX chuẩn, không có dòng copyright gốc của tác giả (chỉ có
  author/repository từ package.json). Muốn chặt hơn thì phải lấy LICENSE từ repo upstream của từng package.

## Đề xuất của audit ec05d561 (S1), 14:25

- **F1 đã làm:** `@anhlp/alp-paseo` thêm `peerDependenciesMeta` cho react và react-native (optional). Theo audit, npm mặc
  định tự cài peer react-native 0.81, kéo theo metro/jest (braces high, sprintf-js moderate). Server không import react;
  client lấy react từ app Paseo. Lockfile: chỉ thêm đúng object này vào entry `integrations/paseo`, chỉnh JSON tay,
  không chạy npm (bản trước: `package-lock.before-f1.json`). `npm ls --workspace=@anhlp/alp-paseo` exit 0;
  141/141 test plugin pass; pack-check plugin pass. Audit consumer chạy lại do ec05d561 làm.
- **F2 chưa làm, chờ anh:** đổi devDependency `ajv` 8.17.1 → 8.20.0 (moderate, code không gọi tới). Việc này cần npm
  install và đổi code được bundle.
- Ghi nhận: `@anthropic-ai/claude-agent-sdk` plugin pin `0.3.292`, các package khác `^0.3.292`, nên consumer có hai bản.
  Chưa đổi.
- **F2 đã làm (anh duyệt 14:18):** ajv `8.17.1` → `8.20.0` ở devDependencies của root, `packages/protocol`,
  `packages/runtime` (để cây chỉ có một bản ajv). `npm install --ignore-scripts`: lock đổi đúng 4 chỗ ajv
  (`lockfile-f2.diff`); entry F1 vẫn được npm giữ. Môi trường có `NODE_TLS_REJECT_UNAUTHORIZED=0`, nên em đối chiếu
  integrity ajv 8.20.0 trong lock với registry qua curl có kiểm TLS: khớp (`ajv-integrity.txt`). Test contract 10/10;
  build lại xong, notices ghi `ajv@8.20.0` ở cả 4 file; pack-check 8/8; `npm test` 778 test, 735 pass, 0 fail, 43 skip
  (`test-f2.log`).
