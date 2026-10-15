# @anhlp/alp-gateway

Authenticated WebSocket access to one OS user's alpd, for remote clients such as Paseo on
another machine, a browser or a phone. Clients speak ALP protocol v1; the gateway reaches alpd
only through the client SDK over the daemon's private IPC socket, which it never exposes.

```sh
alp-gateway credential create --label phone --workspace /home/me/project   # prints a token once
alp-gateway serve                                                           # 127.0.0.1:7434
```

- `POST /v1/tickets` with `Authorization: Bearer <token>` returns a one-time ticket; open
  `/v1/ws` with the subprotocols `alp.v1` and `alp.ticket.<ticket>`. No secret goes in a URL.
- Default deny: only the methods in `src/policy.js` marked `exposed` are forwarded, each after a
  permission check and a workspace/session scope check; results and events are filtered too.
  Daemon shutdown, extension registration and host administration are never remote. Library
  entry content (MCP servers, hooks, providers) never leaves: list rows carry names only.
- `credential create --mode read-only` limits a credential to driving (prompt, message, answer)
  trees that run in the given modes, checked up to the root on every request.
- Loopback by default. Put a TLS reverse proxy in front for remote clients (`deploy/Caddyfile`,
  `deploy/nginx.conf`), or give `--tls-cert`/`--tls-key`.
- The gateway never starts alpd, never reads ALP state and never resends a request.

See [docs/alp/remote-gateway.md](../../docs/alp/remote-gateway.md) for the authentication flow,
the method exposure matrix, recovery, deployment and client integration.
