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
- Permissions: `session.read`/`session.write`, `project.read`/`project.write` (the default), and
  `files.read`, which lists a workspace's directories and reads its text files (at most 1 MiB;
  `.git`, `.env*`, `.alp`, key and credential files always refused, links never followed). It is
  never a default: `credential create --permission session.read,session.write,project.read,files.read`.
- Git, read only (capability `workspace.git`): `workspace.git.status` (branch and changed files,
  no content) with `project.read`; `workspace.git.diff` (hunks, which are file content) with
  `project.read` **and** `files.read`. No commit, push, pull, merge or branch switch is remote.
- Attachments (capability `attachments`): uploading files into alpd's attachment store
  (`attachment.begin/chunk/commit/abort/delete`) needs `attachments.write` **and** `session.write`;
  `attachment.get` (metadata only) `attachments.write` and `session.read`. Never a default, implies
  nothing: `--permission session.read,session.write,attachments.write`. Each upload is bound by alpd
  to the credential, its grant epoch, the project and the session; no path or URL ever crosses.
- Live configure (capability `session.configure.live`): `session.configure` with `model` or
  `thinking` needs `session.write` within the grant's modes (the mode the change would run with too);
  with `team` also `session.team.write`, never a default and implying nothing:
  `--permission session.read,session.write,session.team.write`. The root's native process restarts on
  the same conversation at the idle barrier; never another runtime, never more permissions.
  `session.configure.preview` (read only) needs `session.read`.
- Conversation fork and rewind (capabilities `session.fork`, `session.rewind`): `session.rewind`
  needs `session.write`, `session.fork` `session.write` **and** `session.read` (it reads the source).
  Only a root in the grant; a fork's destination `workspaceId` must be a granted workspace. Only the
  conversation changes, **never a file**; a rewind keeps the later turns as a branch that
  `session.fork { branchId }` recovers. A summary's `forkedFrom` is dropped when its source session
  is outside the credential's grant.
- `credential create --mode read-only` limits a credential to driving (prompt, message, answer)
  trees that run in the given modes, checked up to the root on every request.
- Loopback by default. Put a TLS reverse proxy in front for remote clients (`deploy/Caddyfile`,
  `deploy/nginx.conf`), or give `--tls-cert`/`--tls-key`.
- The gateway never starts alpd, never reads ALP state and never resends a request.

See [docs/alp/remote-gateway.md](../../docs/alp/remote-gateway.md) for the authentication flow,
the method exposure matrix, recovery, deployment and client integration.


`credential reissue <id>` (alias `edit`) retains device identity and replaces only supplied grant
fields, rotating the secret. Supplied permission/workspace/mode lists replace whole lists; omitted
fields persist. Old tokens, tickets and connections stop on the gateway's next credential reload.

Opt-in `library.write` (implies `project.read`, absent from defaults) permits project-only agent/skill
instruction CRUD. The daemon must advertise `library.project.write` and enforces `project-data`:
no host/built-in collisions, executable references/configuration, sidecars or links. Host skill
assignment (`library.skills.set`), teams, MCP, hooks and providers remain denied. See the policy
and prompt-authority boundary in the linked remote gateway documentation.

The hello publishes effective `promptImageLimits` when image capability is available. The web
client honors these limits, including gateways configured with a smaller `limits.maxFrame`.
Workspace search applies the same hardened Git ignore checks as listing and reading.

### Managed user worktrees

`workspace.manage` is opt-in and implies no other permission. On macOS/Linux hosts with
`/usr/bin/git`, the owner can create a private (`0600`) `<ALP_HOME>/worktree-destinations.json`:

```json
{"version":1,"mappings":[{"id":"personal","source":"/canonical/repo","commonDir":"/canonical/repo/.git","parent":"/canonical/private-user-worktrees"}]}
```

All paths must already exist and be canonical. The destination parent must belong to the
owner, be private (`0700`), and be separate from source, Git storage, and ALP assignment/copy
cleanup directories. For a linked source worktree, use its actual Git common directory.
The file is host configuration; no remote RPC can create or change a mapping.

Issue a credential with the exact source `--workspace`, `--permission workspace.manage`,
`--worktree-mapping personal`, and the read/session permissions it needs. In the web sidebar,
register the source project, then choose **Create worktree** and an approved destination.
Creation checks out committed HEAD with a generated directory and branch; it does not copy
uncommitted changes, execute setup hooks, or accept paths, branch names, revisions or Git arguments.
Only that credential's current scope receives the exact committed generated checkout. A shared
Git common directory never authorizes parents or siblings. Changing credential scope invalidates
its old derived grants; rotating only the token secret preserves scope. Mapping/source revocation
and identity changes suppress derived access on the next request or event and on reconnect.

**Remove worktree → Delete checkout files** removes a managed user checkout from disk and
archives its registry row. Its Git branch remains. Project removal/workspace archive are metadata
operations and do not delete files. Dirty/ignored files, hidden index state, submodules, locks,
active/opening sessions, claims, leases, recoverable assignments and retained results refuse deletion.
Saved session placement also refuses deletion: retain the checkout while that placement exists.
This feature has no history-deletion RPC. Deletion never clears history automatically. Shared
writer result ownership is retained conservatively; older workspaces without authoritative birth
tracking need an audited migration before deletion. Assignment worktrees are never adopted.

Mutations carry `requestId` and `ifRevision`. Keep both unchanged after a timeout and retry the
same operation: the existing registry persists a prepared intent before Git, then publishes workspace,
creator/scope-bound grant provenance and receipt atomically. A failed save is an error, never success.
Restart/retry reconciles the original generated identity. Ambiguous or edited partial checkouts remain
quarantined for owner reconciliation; no reset/force/recursive cleanup occurs during recovery.
This provides the daemon's existing process-crash persistence, not a power-loss durability guarantee.
Windows does not advertise this capability. A cwd/grant is not an OS sandbox against another process
running as the same host user.
