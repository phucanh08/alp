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

## Identity (planned, Phase 2 — thin rename)

| Since     | Area                 | Upstream                                    | alp        | Effect                                                       |
| --------- | -------------------- | ------------------------------------------- | ---------- | ------------------------------------------------------------ |
| _pending_ | CLI bin              | `paseo`                                     | `alp`      | scripts and docs that call `paseo …` must call `alp …`       |
| _pending_ | home dir             | `~/.paseo`                                  | `~/.alp`   | existing Paseo state is not read; fresh daemon home          |
| _pending_ | config file          | `paseo.json`                                | `alp.json` | per-project worktree/scripts config uses the new filename    |
| _pending_ | desktop / mobile ids | `sh.paseo.*` bundle ids, product name Paseo | alp ids    | separate app identity; no in-place upgrade from Paseo builds |

## Kept compatible on purpose

- `packages/protocol` wire schemas and RPC names: unchanged. Rename never touches field names.
- npm workspace scope `@getpaseo/*` and `PASEO_*` env vars: unchanged (thin rename) so that
  `git merge upstream/main` stays feasible.
