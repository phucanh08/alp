> Handoff update (2026-10-16): This is the original local audit snapshot, not release-SHA evidence. F1/F2 were fixed and re-audited. The owner subsequently accepted F3 for beta.1 in `../beta-scope.md` decision D5, until beta.2 or 2026-11-15 (whichever comes first). Statements below asking for that decision are historical. Raw JSON, tarballs and hash files remain in the Windows `.cache/audit-beta/` and are not included here; regenerate them on the release SHA with TLS verification enabled. The accompanying `tools/` scripts are preserved for that rerun. Run the section 6 examples from this directory, using an absolute repository root. Signature searches are supporting evidence, not proof of absence on their own.

# T6 / S1: phân loại `npm audit` cho 8 package beta `0.0.0-beta.1`

Đây là bằng chứng chạy trên checkout local, không phải gate trên release SHA. S1 phải chạy lại trên
`RELEASE_SHA` (P0) bằng cùng các lệnh và script trong `tools/`.

## 0. Môi trường và đầu vào

| | |
|---|---|
| Thời điểm | 2026-10-16T14:00:51+07:00 (audit gốc); kiểm thêm tới khoảng 14:25 |
| Node / npm | v26.8.1 / 11.19.0 (`C:\Users\anhlp\tools\node24`; PATH mặc định của agent này là Node 20.13.1 + npm 12.0.2, npm báo không hỗ trợ, nên **không** dùng) |
| OS | Windows 10 Pro 19044, Git Bash (MINGW64) |
| HEAD | `5c474f8ad85130f39fdc48f86f2a95d2124d4d56` cộng **77 file chưa commit** (manifest/lockfile đang được bạn license sửa) |
| Lockfile gốc | sha256 trong `input-hashes.txt` |
| Paseo web | `.cache/paseo-web` @ `b63a325` (Paseo 0.11.2) + 19 patch; `node scripts/check-web-app.mjs` OK; sha256 lockfile trong `paseo-web-lock.sha256` |
| Registry | `https://registry.npmjs.org/` |
| Lưu ý | Môi trường đang đặt `NODE_TLS_REJECT_UNAUTHORIZED=0` (cấu hình cá nhân, không đụng tới). Vì vậy npm lấy dữ liệu advisory qua TLS **không kiểm cert**. Mọi advisory dùng để kết luận đều đã được đối chiếu lại với GitHub Advisory API bằng `curl` (có kiểm TLS): `advisories/*.json` |

Network: audit chạy được, không cần escalation.

## 1. Kết luận

- **Không có lỗ hổng critical nào** trong code chạy của 8 package.
- **Không có lỗ hổng high nào bị gọi tới** trong code chạy của CLI, alpd, ACP, plugin server
  hay loopback `alp web`, trừ **F3**: high, chỉ gây DoS phía client cho tab trình duyệt của
  `alp web`. F3 cần anh quyết định chấp nhận rủi ro.
- **Thứ đang tạo ra 16 high** khi người dùng `npm install` plugin bằng lệnh mặc định:
  peer `react-native` của `@anhlp/alp-paseo` (**F1**). Code không bao giờ được chạy, nhưng
  `npm audit` phía người dùng sẽ gắn cờ **chính `@anhlp/alp-paseo` là high**. Đã sửa
  (peer optional); audit consumer sau khi sửa còn 0 (§4 F1).
- Con số "21 lỗ hổng" ở scope §5 là tổng của cả **cây dev** gốc (react-native 0.81.5 là
  devDependency gốc, dùng cho client SDK smoke, cộng `ajv`). Không nên lấy con số đó làm rủi ro
  production.

## 2. Số liệu thô

| Audit | high | crit | mod | Ghi chú |
|---|---|---|---|---|
| `npm audit` gốc (mọi workspace, gồm dev) | 15 | 0 | 6 | `audit-all.json` |
| `npm audit --omit=dev` gốc | 0 | 0 | 1 (ajv) | `audit-omit-dev.json`; gồm cả gateway/web/tui (deferred) |
| Consumer cài 8 tarball, **npm mặc định** (tự cài peer) | 16 | 0 | 5 | `audit-consumer-peers.json`, 419 package |
| Consumer cài 8 tarball, `--legacy-peer-deps` (cách `paseo plugin add` cài) | 0 | 0 | 0 | `audit-consumer-nopeers.json`, 131 package |
| Như dòng 3, nhưng thêm `react`/`react-native` vào `peerDependenciesMeta.optional` (thử nghiệm F1) | 0 | 0 | 0 | `audit-consumer-peers-optional.json`, 146 package |
| **Sau F1** (tarball `packs-f1/`), npm mặc định / `--legacy-peer-deps` | 0 / 0 | 0 / 0 | 0 / 0 | `audit-consumer-f1-*.json`, 146 / 131 package |
| **Sau F1+F2**: `--omit=dev` gốc / consumer mặc định / consumer `--legacy-peer-deps` (`packs-f2/`) | 0 / 0 / 0 | 0 | 0 | `audit-omit-dev-f2.json`, `audit-consumer-f2-*.json` |
| Lockfile Paseo 0.11.2 (nguồn của `alp web`) | 84 | 15 | 46 | `audit-paseo-web.json`; cả monorepo Paseo (server, desktop, website, eas-cli…) |

Tarball dùng cho consumer: `packs/` (`npm pack --ignore-scripts` từ checkout hiện tại, không
build lại, không ghi gì vào checkout). Checksum ở `packs/SHA256SUMS`. Đây **không** phải 8
tarball của P2.

## 3. Third-party bundled (npm audit không nhìn thấy theo manifest)

`tools/bundle-inputs.mjs` dựng lại cấu hình esbuild của repo trong bộ nhớ (`write:false`) và lấy
metafile. Kết quả ở `bundle-inputs.json`.

- `alpd.js` (root, cli, daemon, và bản trong plugin): `@modelcontextprotocol/sdk@1.32.1`,
  **`ajv@8.17.1`**, ajv-formats, fast-uri@3.1.8, cross-spawn, smol-toml@1.9.0, zod@4.4.3,
  zod-to-json-schema, pkce-challenge, eventsource-parser, … (18 package). External:
  `@anthropic-ai/claude-agent-sdk`.
- `acp.js`: `@agentclientprotocol/sdk@1.7.0`, zod.
- Plugin server (`index`, `main`, …): như alpd, cộng `@getpaseo/protocol@0.11.2`,
  `@getpaseo/relay@0.11.1`, `ws@8.22.0`, tweetnacl, base64-js.
- Plugin client: không inline third-party nào; `react`, `react-native`, `@getpaseo/plugin/*`
  là external do app Paseo cung cấp.
- Các file per-module trong `packages/*/dist` dùng `packages:'external'`, nên không inline gì.
- `alp web` = bản Expo web export của Paseo (`server/dist/web-app`, 22 MB JS) trong tarball
  plugin. Nguồn là lockfile Paseo; audit gốc không phủ phần này (xem F3, F4).

Đối chiếu với advisory: chỉ `ajv@8.17.1` có advisory (F2). `fast-uri@3.1.8` (sửa ≥3.1.7),
`ws@8.22.0` (sửa ≥8.21.0), `smol-toml@1.9.0` (sửa >1.7.0): không bị ảnh hưởng.

Phần còn lại chưa audit được: code third-party nằm sẵn bên trong tarball của
`@anthropic-ai/claude-agent-sdk` (vendor tự bundle). npm audit không thấy được và repo không có
SBOM. Đây không phải finding, chỉ là giới hạn đã biết.

## 4. Findings

### F1. Chuỗi `react-native` 0.81.x qua peer của plugin (16 high, 5 moderate). Trạng thái: **ĐÃ SỬA trong working tree** (fb17b279, 2026-10-16; đã kiểm lại, xem cuối mục)

- Advisory gốc: **GHSA-vfj7-8cjw-p6xm** (`braces` ≤3.0.3, high, CVSS 7.5, stack exhaustion; **chưa
  có bản sửa**, latest = 3.0.3) và **GHSA-hp3w-g68c-fv3c** (`sprintf-js` ≤1.1.3, moderate, chưa có bản
  sửa). Các high còn lại (metro*, jest*, babel-jest, micromatch, @react-native/community-cli-plugin,
  react-native) chỉ là cờ lan truyền từ `braces`.
- Đường đi: `@anhlp/alp-paseo` peer `react-native >=0.81 <0.82` → `react-native` →
  `@react-native/community-cli-plugin` → `metro` → … → `micromatch` → `braces`; và
  `babel-jest` → `@istanbuljs/load-nyc-config` → `js-yaml@3` → `argparse` → `sprintf-js`.
- Code có được gọi không: **không**. Plugin server không import `react`/`react-native`
  (external của mọi server bundle, `bundle-inputs.json`). Plugin client lấy `react-native` từ app
  Paseo khi chạy. metro và jest là công cụ build/test, không chạy khi ALP chạy. DoS của `braces`
  cần attacker đưa vào pattern glob.
- Khi nào bị cài:
  - `paseo plugin add npm:@anhlp/alp-paseo@beta`: **không**. Paseo cài plugin bằng
    `npm install --ignore-scripts --legacy-peer-deps --omit=dev`
    (`.cache/paseo-web/packages/server/src/server/plugins/managed-source/npm.ts:55-71`).
  - `npm install -g @anhlp/alp-paseo@beta` (docs `docs/alp/beta-install.md:118`, Q2) và
    `npm install --save-exact *.tgz` (scope §6.3): **có**. npm ≥7 tự cài peer, kéo theo khoảng
    270 package dev của react-native, và `npm audit` của người dùng gắn cờ chính
    `@anhlp/alp-paseo` là high.
- Có bản sửa không: npm audit gợi ý `react-native@0.88.0` (lên major, ra ngoài range Paseo 0.11
  cần). Không áp dụng được.
- **Đề xuất (gửi bạn license, chủ của manifest):** thêm vào `integrations/paseo/package.json`

  ```json
  "peerDependenciesMeta": { "react": { "optional": true }, "react-native": { "optional": true } }
  ```

  Bằng chứng: thử trên bản sao tarball (`exp/`), consumer cài mặc định còn 0 lỗ hổng, 146
  package. `@getpaseo/*` vẫn được cài, nên `alp-web-integration`/`alp web` vẫn có SDK host.
  `scripts/tarball-consumer.mjs:151-152` vốn đã lọc optional peer và có comment "Optional peers
  (react-native, client-side only) are left out". `scripts/package-smoke.mjs:52` đang bỏ qua
  react/react-native. Paseo không đọc `peerDependencies` của plugin (grep `packages/*/src`).
  Nếu peer có mặt nhưng sai range, npm vẫn báo conflict.
- Ảnh hưởng phụ: câu "Normal npm installs bring the plugin's Paseo **and React** peers" ở
  `docs/alp/beta-install.md:124` cần sửa thành chỉ còn Paseo peers (bạn docs).
- Nếu không sửa: cần anh chấp nhận rủi ro. Rủi ro này là về uy tín và trải nghiệm (cờ high trên
  package), không phải lỗ hổng bị khai thác được.
- **Kiểm lại sau khi sửa** (2026-10-16T14:17+07:00, Node 26.8.1/npm 11.19.0): fb17b279 thêm `peerDependenciesMeta`
  vào `integrations/paseo/package.json` và vào entry `integrations/paseo` của lockfile. Em pack lại 8
  tarball bằng `--ignore-scripts` (`packs-f1/`, `SHA256SUMS`); `package.json` trong tarball có meta đó.
  Kết quả consumer: npm mặc định **0 lỗ hổng, 146 package**, không còn `react-native`/`braces`
  (`react@19.1.10` vẫn được cài qua peer của `@getpaseo/plugin@0.11.4`, không có advisory);
  `--legacy-peer-deps` 0 lỗ hổng, 131 package. File: `audit-consumer-f1-peers.json`,
  `audit-consumer-f1-nopeers.json`. Phía fb17b279 báo đã kiểm: `npm ls` OK, 141/141 test plugin pass,
  pack-check pass.

### F2. `ajv@8.17.1` inline trong alpd/plugin (moderate, GHSA-2g4f-4pwh-qvx6 / CVE-2025-69873). Trạng thái: **ĐÃ SỬA** (fb17b279, theo duyệt của anh; đã kiểm lại, xem cuối mục). Trước khi sửa cũng không bị ảnh hưởng

- Advisory: ReDoS **chỉ khi bật option `$data`**. Bản sửa 8.18.0, latest 8.20.0.
- Code có được gọi không: MCP SDK tạo Ajv với
  `{strict:false, validateFormats:true, validateSchema:false, allErrors:true}`, không có `$data`
  (`@modelcontextprotocol/sdk@1.32.1 dist/esm/validation/ajv-provider.js:7-12`). Code ALP không
  tạo Ajv (chỉ test `packages/*/tests/*contract*.test.js` làm, với `strict:false`). Không có
  `$data` nào trong `packages|integrations/**/*.ts`.
- Vì sao 8.17.1 còn nằm trong bundle: root `devDependencies.ajv` đang pin đúng `"8.17.1"`, nên bản
  hoisted mà MCP SDK (`ajv: ^8.17.1`) dùng khi build cũng là 8.17.1. Consumer cài mới thì nhận
  8.20.0 (`consumer-peers/package-lock.json`), nhưng bản đã inline trong `alpd.js` vẫn là 8.17.1.
- **Đề xuất (bạn license):** đổi root `devDependencies.ajv` `"8.17.1"` → `"8.20.0"`, rồi cập
  nhật lockfile. Không bắt buộc cho beta; làm sau khi T1/T3 xong lượt sửa lockfile của bạn ấy.
  Sửa xong thì chạy `node --test packages/protocol/tests/contract.test.js
  packages/runtime/tests/events-contract.test.js` và build lại.
- **Kiểm lại sau khi sửa** (2026-10-16T14:21+07:00): fb17b279 đổi ajv thành 8.20.0 ở root, `packages/protocol` và
  `packages/runtime` (cả ba từng pin 8.17.1), rồi build lại; bạn ấy báo contract test 10/10, `npm test` 0 fail,
  pack-check 8/8. Em kiểm: `npm audit --omit=dev` gốc còn **0** (`audit-omit-dev-f2.json`). `npm audit` gốc
  còn 20 (15 high, 5 mod), toàn bộ là chuỗi dev react-native (F5) (`audit-all-f2.json`).
  `bundle-inputs-f2.json`: các bundle inline `ajv@8.20.0`. `THIRD-PARTY-NOTICES.txt` trong tarball
  `alp`/`cli`/`daemon`/`paseo` (`packs-f2/`) chỉ ghi `ajv@8.20.0`. Consumer: 0/0 lỗ hổng
  (`audit-consumer-f2-*.json`, 146/131 package).

### F3. `linkify-it@2.2.0` trong browser bundle của `alp web` (high ×2). Trạng thái: **cần anh quyết định chấp nhận rủi ro**

- Advisory: **GHSA-22p9-wv53-3rq4** (CVE-2026-48801, O(N²) trong `match`, sửa 5.0.1) và
  **GHSA-v245-v573-v5vm** (CVE-2026-59887, O(N²) qua validator `mailto:`, sửa 5.0.2).
  npm audit: `fixAvailable:false`.
- Có trong bundle: chữ ký `fuzzyLink`/`fuzzyEmail`/`mailto:` có trong
  `web-app/_expo/static/js/web/index-08105c30….js` (`web-bundle-signatures.json`).
- Đường gọi: `markdown-it@10.0.0` (do `react-native-markdown-display@7.0.2` cần `^10`) với
  `linkify: true` cho **tin nhắn của assistant**
  (`.cache/paseo-web/packages/app/src/utils/assistant-markdown-parser.ts:6`) và preview file
  markdown (`components/markdown/renderer.tsx:75`).
- Kịch bản: nội dung agent bị prompt injection (ví dụ file trong repo) khiến agent in ra khoảng
  64–128 KB `a@b.com`/`mailto:` lặp lại. Tab `alp web` treo vài giây tới vài chục giây mỗi lần
  render. Chỉ ảnh hưởng tính sẵn sàng của UI trên máy người dùng. Không lộ dữ liệu, không ảnh
  hưởng alpd. `alp web` chỉ nghe loopback và cần token.
- Bản sửa: phải lên markdown-it 14 (linkify-it ^5.0.2), mà `react-native-markdown-display`
  mới nhất (7.0.2) vẫn cần `^10`. Paseo upstream mới nhất (`.cache/paseo-latest`, e0de0fd,
  0.11.2) vẫn dùng linkify-it 2.2.0. App Paseo người dùng đang chạy có cùng lỗi.
- Phương án:
  - (a) Chấp nhận cho beta.1, ghi known issue, theo dõi upstream.
  - (b) Patch ALP trong `paseo-web/patches`: tắt linkify khi tin nhắn dài hơn N KB. Phải build
    lại web app (expo export) và chạy lại A5/R5/R6.
  - (c) Override `linkify-it@5.0.2` trong lockfile Paseo. API khác markdown-it 10, rủi ro hỏng
    render. Không khuyến nghị.
- **Khuyến nghị:** (a), owner **anh**, thời hạn **trước `0.0.0-beta.2` hoặc 2026-11-15**, tùy
  cái nào tới trước. Ghi vào known issues của release notes (scope §7.6). Em không tự chấp nhận.

### F4. Các advisory còn lại trong cây Paseo (99 high+critical). Trạng thái: **không bị ảnh hưởng** (không nằm trong bundle hoặc không gọi được)

| Nhóm | Package | Bằng chứng |
|---|---|---|
| Critical, ngoài closure của `packages/app` | `@tanstack/react-start`, `seroval` (website), `@vitest/browser`, `tinypool` (test), `proxy-addr` (server express) | Không có trong closure prod của `packages/app` (`web-app-closure.json`); chữ ký `seroval`/`react-start`/`tinypool` = 0 |
| Critical/high, chỉ dùng lúc build | `tar`, `undici`, `node-forge`, `compression`, `@xmldom/xmldom`, `postcss`, `source-map-js`, `browserslist`, `image-size`, `picomatch`, `minimatch`, `brace-expansion`, `braces`, `js-yaml@3`, `shell-quote` (react-devtools-core), `ws@6/7` (metro, dev-middleware) | Đường đi qua `expo`→`@expo/cli`/`@expo/metro*`/`react-native` (jest, codegen, devtools); chữ ký trong bundle = 0 (`tar`, `UND_ERR_`, `forge.pki`, `xmldom`, `picomatch`, `postcss`, `browserslist`, `shell-quote`). Các lần "khớp" chữ `braces`/`sharp`/`vite`/`hono`/`compression` đã kiểm ngữ cảnh: chỉ là tên icon hoặc chữ trong text (`web-bundle-context.mjs`) |
| `ws@8.20.0` qua `@getpaseo/relay` | — | Node-only; trong trình duyệt dùng WebSocket gốc. Plugin server inline `ws@8.22.0`, đã có bản sửa |
| `nanoid@3.3.11` (có trong bundle, qua `@gorhom/portal`) | GHSA-xwg4/28wg/2v37 | Chỉ bị khi `size` do attacker kiểm soát, âm hoặc bằng 0. `@gorhom/portal` gọi `nanoid()` từ `nanoid/non-secure` với size mặc định (`lib/module/components/portal/Portal.js`) |
| `js-yaml@4.1.1` vendored trong `mermaid@11.16.0` (có trong bundle; npm audit chỉ thấy theo version) | GHSA-52cp, GHSA-5p4m, GHSA-2883 (high), GHSA-h67p (mod) | Đều cần type `merge` (`<<`) hoặc `!!omap`, mà hai type này chỉ có trong DEFAULT_SCHEMA. Mermaid gọi `load(…, {schema: JSON_SCHEMA})` ở frontmatter (`extractFrontMatter`) và shape/edge metadata. Đường `@{…}` còn bị ALP/Paseo chặn trước (`fence/mermaid/source-policy.ts`, `UNSAFE_MERMAID_SOURCE`). Mermaid chạy trong `<iframe sandbox="allow-scripts" srcDoc>` có CSP `default-src 'none'` |
| `lodash` (`_.template`, GHSA-r5fr) | — | Bundle chỉ có lõi lodash-es (`__lodash_hash_undefined__`), không có `templateSettings`/`_.template` |

Rủi ro ở máy build (không ship): `scripts/build-paseo-web.mjs` chạy `npm ci --ignore-scripts` và
`expo export` trên cây Paseo, nơi có `tar`/`undici`/… dễ bị tổn thương. Chỉ ảnh hưởng máy build P2
khi xử lý input không tin cậy. Không chặn beta.

### F5. Dev/test của repo ALP. Trạng thái: **không bị ảnh hưởng** (không ship)

`ajv` (dev, contract test) và chuỗi `react-native@0.81.5` (dev gốc, client SDK smoke) không vào
tarball nào: các tarball core có `files` giới hạn, và `scripts/package-smoke.mjs:45-47` chặn
đường dẫn `integrations/`/`web-app/`/`@getpaseo/`. Không tính vào S1.

## 5. Bảng tổng hợp cho S1

| # | Package | Mức | Ship? | Gọi tới được? | Trạng thái | Owner / hạn |
|---|---|---|---|---|---|---|
| F1 | react-native→braces/sprintf-js | high/mod | Được cài khi dùng npm mặc định, không chạy | Không | **Đã sửa** (peer optional); audit consumer còn 0 | fb17b279 sửa; anh duyệt thay đổi |
| F2 | ajv 8.17.1 (inline alpd/plugin) | mod | Có | Không (`$data` tắt) | **Đã sửa**: ajv 8.20.0 inline | fb17b279 sửa; anh đã duyệt |
| F3 | linkify-it 2.2.0 (`alp web`) | high | Có (browser) | Có, chỉ DoS phía client | **Cần anh chấp nhận rủi ro** | anh; trước beta.2 hoặc 2026-11-15 |
| F4 | còn lại trong cây Paseo | high/crit | Không, hoặc không gọi được | Không | Không ảnh hưởng | — |
| F5 | dev ALP | high/mod | Không | — | Không ảnh hưởng | — |

**S1 chặn gate tới khi:** (1) ~~F1~~ đã sửa và kiểm lại; (2) anh quyết định F3;
(3) chạy lại trên `RELEASE_SHA` bằng các lệnh ở §6.

## 6. Tái lập trên release SHA

```sh
export PATH=<Node 22.12+/24>:$PATH   # ghi node -v, npm -v
npm audit --json > audit-all.json; npm audit --omit=dev --json > audit-omit-dev.json
node tools/closure.mjs <root> audit-all.json closure-hits.json
node tools/bundle-inputs.mjs <root> bundle-inputs.json
(cd .cache/paseo-web && npm audit --package-lock-only --json) > audit-paseo-web.json
node tools/web-app-closure.mjs <root> <root>/.cache/paseo-web audit-paseo-web.json web-app-closure.json
node tools/web-bundle-signatures.mjs <root> web-bundle-signatures.json
# consumer: thư mục chứa 8 tarball của P2; npm install --package-lock-only --ignore-scripts [--legacy-peer-deps]; npm audit --json
```

## 7. Chưa giải quyết

- F3: anh chọn (a), (b) hay (c).
- F1, F2 đã xong.
- Code bundle sẵn trong `@anthropic-ai/claude-agent-sdk` không audit được (không có SBOM).
- Phụ, không phải lỗ hổng: consumer resolve ra **hai bản** `@anthropic-ai/claude-agent-sdk`
  (0.3.292 và 0.3.301) vì plugin pin đúng `0.3.292`, còn root/runtime/cli/daemon dùng
  `^0.3.292`. Đã báo bạn license.
