# Breaking changes vs upstream Paseo

alp is a fork of [getpaseo/paseo](https://github.com/getpaseo/paseo). Compatibility with upstream
Paseo clients, daemons, and hosted services is **not** a goal. This file is the running list of
every place where alp intentionally diverges so that upstream and alp cannot interoperate. Append a
row whenever a change breaks upstream compatibility; never delete rows.

Format: one row per change, newest last. `Since` is the alp commit or version that introduced it.

## Hosted services and domains

| Since      | Area               | Upstream                                                   | alp                                            | Effect                                                                                                           |
| ---------- | ------------------ | ---------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 2026-09-25 | relay              | `relay.paseo.sh:443`                                       | `relay-alp.anhlp.com:443`                      | alp daemons/clients never reach the Paseo relay; upstream clients cannot pair with alp daemons through the relay |
| 2026-09-25 | web app            | `https://app.paseo.sh`                                     | `https://app-alp.anhlp.com`                    | pairing links and offers point to the alp web app only                                                           |
| 2026-09-25 | hub                | `hub.paseo.sh`                                             | `hub-alp.anhlp.com`                            | CLI `hub` commands and docs default to the alp hub                                                               |
| 2026-09-25 | website/docs       | `paseo.sh`, `www.paseo.sh`                                 | `alp.anhlp.com`                                | in-app links, schema `$id`, update/rosetta callouts, changelog links                                             |
| 2026-09-25 | relay deploy       | `deploy-relay.yml` + `wrangler.toml` with upstream account | removed; `wrangler.example.toml` only          | relay is deployed by the maintainer outside CI; no automatic relay releases                                      |
| 2026-09-25 | website/app deploy | upstream Cloudflare account id + KV id hardcoded           | placeholders / `secrets.CLOUDFLARE_ACCOUNT_ID` | deploy workflows need alp-owned Cloudflare secrets before they work                                              |

## Identity (thin rename)

| Since      | Area                 | Upstream                                           | alp                                             | Effect                                                                                           |
| ---------- | -------------------- | -------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 2026-09-25 | CLI bin              | `paseo` (`packages/cli/bin/paseo`)                 | `alp` (`packages/cli/bin/alp`, `.name("alp")`)  | scripts and docs that call `paseo …` must call `alp …`; no `paseo` alias                         |
| 2026-09-25 | desktop CLI shim     | `Resources/bin/paseo`, `~/.local/bin/paseo`        | `Resources/bin/alp`, `~/.local/bin/alp`         | desktop "install CLI" writes `alp`; old `paseo` symlink is not cleaned up                        |
| 2026-09-25 | home dir             | `~/.paseo`                                         | `~/.alp` (`PASEO_HOME` still overrides)         | existing Paseo state is not read; fresh daemon home                                              |
| 2026-09-25 | URL scheme           | `paseo://` (desktop protocol + agent deep links)   | `alp://`                                        | upstream deep links do not open alp; `parseAgentDeepLink` rejects `paseo:`                       |
| 2026-09-25 | desktop identity     | appId `sh.paseo.desktop`, product/exe `Paseo`      | `com.anhlp.alp.desktop`, product/exe `alp`      | separate app; artifacts `alp-*.dmg/AppImage/exe`; helper `alp Helper.app`                        |
| 2026-09-25 | desktop auto-update  | GitHub releases `getpaseo/paseo`                   | `phucanh08/alp`                                 | updater only sees alp releases                                                                   |
| 2026-09-25 | mobile identity      | `sh.paseo` / `sh.paseo.debug`, name Paseo          | `com.anhlp.alp` / `.debug`, name alp            | fastlane, maestro app ids follow; store listing is a new app                                     |
| 2026-09-25 | repository url       | `github.com/getpaseo/paseo`                        | `github.com/phucanh08/alp`                      | package.json `repository` in root + all workspaces                                               |
| 2026-09-25 | display strings      | `Paseo` in app/CLI/server/desktop UI, README, docs | `alp` (lowercase)                               | UI copy, MCP tool descriptions, generated PR body, docs say alp; identifiers/env/scope unchanged |
| 2026-09-25 | release download URL | `getpaseo/paseo/releases`, `Paseo-<ver>-arm64.dmg` | `phucanh08/alp/releases`, `alp-<ver>-arm64.dmg` | in-app download / CLI hint only work once alp publishes releases                                 |

## Deferred (still upstream values)

| Area                   | Value kept                                         | Why                                                                                                                                     |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| project config file    | `paseo.json`                                       | consumed by the upstream Paseo daemon that drives the SLP workflow on this repo, and by i18n strings in 7 locales; rename later if ever |
| hub project dir        | `.paseo/triggers`                                  | hub scaffolding, untouched until hub is re-hosted                                                                                       |
| nix / docker bin names | `paseo-server`, `paseo`, `paseo-docker-entrypoint` | packaging wrappers, Phase 3                                                                                                             |

## Kept compatible on purpose

- `packages/protocol` wire schemas and RPC names: unchanged. Rename never touches field names.
- npm workspace scope `@getpaseo/*` and `PASEO_*` env vars: unchanged (thin rename) so that
  `git merge upstream/main` stays feasible.
