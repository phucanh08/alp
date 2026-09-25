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

`scripts/prove-relay-prod.mjs` pairs a throwaway daemon through the relay and the web app. Run it by
hand after a relay change; do not add it to CI.
