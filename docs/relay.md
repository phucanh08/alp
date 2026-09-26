# Relay (maintainer-owned)

The relay bridges a daemon to remote clients with end-to-end encryption. In this fork the
**relay library stays in the repo** but the **relay deployment lives outside it** and is managed by
the maintainer. Agents never deploy, rotate, or reconfigure the relay.

## What is in the repo

| Piece                                          | Owner      | Notes                                                                                |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `packages/relay/src/*` (e2ee, crypto, channel) | repo       | Imported by `@getpaseo/server` and `@getpaseo/client`. Protocol-level, keep in sync. |
| `packages/relay/src/cloudflare-adapter.ts`     | repo       | Worker entry. Built and tested here; deployed by the maintainer.                     |
| `packages/relay/wrangler.example.toml`         | repo       | Template only. Real `wrangler.toml` is gitignored.                                   |
| Cloudflare account, DNS `relay-alp.anhlp.com`  | maintainer | Not in git. No CI job deploys it (`deploy-relay.yml` was removed).                   |

## Defaults

| Setting             | Value                                                                        | Where                                                                               |
| ------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Relay endpoint      | `relay-alp.anhlp.com:443`                                                    | `packages/protocol/src/daemon-endpoints.ts`, `packages/server/src/server/config.ts` |
| Web app base URL    | `https://app-alp.anhlp.com`                                                  | `packages/server/src/server/config.ts`                                              |
| Override at runtime | `PASEO_RELAY_ENDPOINT`, `PASEO_RELAY_PUBLIC_ENDPOINT`, `PASEO_RELAY_USE_TLS` | env or `daemon.relay.*` in persisted config                                         |

## Deploying (maintainer, outside CI)

```bash
cd packages/relay
cp wrangler.example.toml wrangler.toml      # fill account_id or export CLOUDFLARE_ACCOUNT_ID
npm run typecheck && npm test
npx wrangler deploy
```

`PASEO_RELAY_UPSTREAM` in the worker vars is only for a cutover bridge to another relay; leave it
empty to serve directly.

## Verifying a relay

Run the proof by hand after a relay deploy; do not add it to CI.

```bash
npm run build:server                 # the script drives this checkout's CLI
node scripts/prove-relay-prod.mjs    # exit 0 = proven, prints a JSON summary
```

It starts a throwaway daemon (temp home, free port, relay on), pairs it with `alp daemon pair`,
opens the pairing link in headless Chrome on the web app, and passes once one browser session has
held the relay for the stability window. The daemon and its home are removed on every exit. On
failure it exits 1 with the step that broke and the last relay error from the daemon log.

| Option                           | Use                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--relay-endpoint`, `--base-url` | Prove another relay or web app (defaults above)                                                 |
| `--timeout-ms`, `--stability-ms` | Per-step deadline (120 s; relay connect caps at 30 s) and how long the session must hold (30 s) |
| `--cli <path>`                   | Use an installed `alp` instead of building this checkout                                        |
| `--keep-log <path>`              | Keep the daemon log to diagnose a failure                                                       |
| `--browser-channel`, `--headed`  | Needs Google Chrome; `none` uses Playwright's bundled Chromium                                  |

Run it on an idle machine. The web app is a 20 MB bundle, first render in headless Chrome can take
a minute under load, and the app abandons a connection that has not finished its E2EE handshake
within 15 s. A failure that lists `relay_e2ee_handshake_failed` after the relay routed the browser
means the browser was starved, not that the relay is broken. The app also drops its first relay
session or two before settling, so the proof waits for one that holds instead of failing on the
first close. The browser is blocked from `localhost` so it never reaches a real daemon on your
machine. The pairing link is a credential; the script redacts it from all output.
