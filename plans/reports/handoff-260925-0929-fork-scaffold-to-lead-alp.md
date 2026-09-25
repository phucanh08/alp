# Handoff: fork paseo → alp, Phase 0–2 → lead-alp

**Từ:** session alp-ae (bootstrap) · **Tới:** lead-alp · **Ngày:** 2026-09-25 · **Runtime:** Claude Code Agent Teams (SLP beta cài trong repo)

## Candidate
- Repo: `/Users/anhlp/StudioProjects/alp`, branch `main`, HEAD `c5d246e01`, đã push `origin` (https://github.com/phucanh08/alp.git)
- Base upstream: `84304b553` (getpaseo/paseo v0.9.2), remote `upstream`
- Commit stack: `34e60c356` scaffold SLP + plan → `f5c64b35f` domain + relay tách → `c5d246e01` thin rename

## Scope đã làm
1. **SLP beta** cài từ `/Users/anhlp/StudioProjects/alp-claude` (agents lead/peer/supervisor, 7 skill, settings, manifest). `CLAUDE.md` có mục "SLP team policy (alp fork)" + contract boundaries + verification + external side effects.
2. **Domain** (149 file): `relay.paseo.sh`→`relay-alp.anhlp.com`, `app.paseo.sh`→`app-alp.anhlp.com`, `hub.paseo.sh`→`hub-alp.anhlp.com`, `paseo.sh`→`alp.anhlp.com`. Chừa CHANGELOG, LICENSE, lockfile.
3. **Relay tách**: lib e2ee giữ ở `packages/relay` (server+client import). `wrangler.toml`→`wrangler.example.toml` (bản thật gitignore), xoá `.github/workflows/deploy-relay.yml`, scrub Cloudflare account/KV id upstream ở website wrangler + deploy-app. Docs: `docs/relay.md`.
4. **Thin rename**: CLI bin `alp` (`packages/cli/bin/alp`, `.name("alp")`); desktop shim `packages/desktop/bin/alp(.cmd)`; home mặc định `~/.alp` (`PASEO_HOME` vẫn override); scheme `alp://` (desktop `APP_SCHEME`, `packages/protocol/src/agent-deep-link.ts`); desktop appId `com.anhlp.alp.desktop`, product/exe `alp`, artifact `alp-*`, updater repo `phucanh08/alp`; mobile `com.anhlp.alp(.debug)`, tên `alp`, fastlane/maestro id theo; repository url mọi package.json; nix/CI `alp.app`.
5. **`docs/breaking-changes.md`**: bảng divergence theo ngày (không xoá dòng) + mục Deferred + mục Kept compatible.

## Quyết định Human đã chốt (không hỏi lại)
- Mức đổi tên **A thin**: giữ scope `@getpaseo/*`, env `PASEO_*`, `paseo.json`, wire protocol → còn merge upstream.
- Domain `anhlp.com` (Cloudflare của Human). Hub = `hub-alp.anhlp.com`.
- **Không cần tương thích** với Paseo; mọi divergence ghi vào `docs/breaking-changes.md`.
- Relay deploy, website deploy, app deploy: **Human tự làm ngoài CI**. Agent không deploy, không sửa account/route.

## Verification (đã chạy, output thật)
- `npm run lint` → 0 warnings 0 errors (4290 files)
- `npm run typecheck:server` → exit 0; `packages/desktop` typecheck → exit 0
- vitest chỉ file đã sửa: cli 15 files/103 tests pass; desktop 9 files/45 pass; server `config-relay`, `pairing-qr`, `persisted-config` 71 pass, `daemon-session` 11 pass; app `host-runtime` 71, `test-daemon-connection` 9, `app-diagnostic-report` 3 pass; protocol `daemon-endpoints`+`connection-offer` 27, `agent-deep-link` 2 pass; `node --test scripts/sync-fdroid-changelogs.test.mjs` pass.
- Cần `npm run build:client` rồi `npm run build:server` trước khi chạy test server/app/cli (dist declarations). Đã build sẵn trong checkout này.

## Unknown / risk
- `packages/website/src/canonical-url.test.ts` fail lúc startup: "environment options are incompatible with the Cloudflare Vite plugin" — nghi lỗi môi trường có sẵn, **chưa xác minh trên upstream**.
- Native module Kotlin package `sh.paseo.diffprototype` (`packages/app/modules/paseo-diff-prototype`) giữ nguyên — namespace module, không phải app id.
- Desktop "install CLI" ghi `~/.local/bin/alp`; symlink `paseo` cũ không được dọn.
- Chưa build electron/expo thật; identity chỉ verify bằng test packaging.

## Việc còn lại (Phase 3+, ở `plans/260925-0905-fork-paseo-to-alp/plan.md`)
1. **Display string "Paseo" → "alp"**: app UI, i18n 7 locale (`packages/app/src/i18n/resources/*`), website, README ×4, `public-docs/`, `docs/`. Chạm snapshot/test string → chia theo package, mỗi package một writer.
2. Deferred: `paseo.json` (đang được daemon Paseo upstream chạy SLP đọc — chỉ đổi khi Human quyết), `.paseo/triggers` hub, tên bin nix/docker `paseo-server`/`paseo-docker-entrypoint`, CHANGELOG thêm mục "alp fork".
3. Phase 5: chạy SLP runtime trên chính alp (provider `claude-lead/peer/supervisor`, plugin `slp-paseo`).

## Ownership
- Lead-alp nhận topology + acceptance từ đây. Session alp-ae không còn ghi vào repo.
- Push: Human đã cho phép push `main` trong phase bootstrap; từ giờ theo `CLAUDE.md` External side effects (Lead xin authority trước khi push).
