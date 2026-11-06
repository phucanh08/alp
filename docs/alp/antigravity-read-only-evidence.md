# Antigravity read-only: what agy enforces (measured)

Measured by hand on macOS arm64 with **agy 1.5.2**, driving agy exactly as
`antigravityModeArgs` does (`--input-format stream-json --output-format stream-json
--add-dir <cwd> --disable-slash-commands --sandbox --settings <json>`), on
2026-11-06 for t-c8ee and t-ffa1. Figures taken from agy's own
`step_update`/`result` events, not inferred. Anything not listed was not checked:
no Linux, no Windows, no other agy version.

## The floor a read-only session runs in

| Action | Result |
| :-- | :-- |
| Write anywhere in the workspace (`node -e "fs.writeFileSync('x','y')"`) | `EPERM: operation not permitted`; the file is never created |
| Write in `os.tmpdir()`, `mkdtemp` | Succeeds |
| `cat` a file one directory above the workspace | `Operation not permitted` |
| `ls` the user's home | `Operation not permitted` |
| `cat /etc/passwd`, `cat ~/.gitconfig` | **Succeed** |
| `ls ~/.gemini/antigravity-cli/**` (agy's own state, incl. ALP's MCP tool definitions) | **Succeeds** |

The terminal sandbox is `/usr/bin/sandbox-exec` with a deny-default Seatbelt
profile. So the path boundary for a terminal command is that sandbox, not the
permission rule: a command allowlist cannot scope a path, and the sandbox leaves
system paths, the user's VCS config and agy's own state readable. That residual
is why the read-only terminal allowlist stays `pwd` only (ALP.md, t-c8ee), and
why a review that must run commands belongs on another provider.

## agy's own file tools (t-ffa1, premise corrected)

The earlier premise was that `view_file`, `list_dir` and search still read
outside the workspace in read-only, and that the permission check happens only
after the read. On 1.5.2 that is **not** what happens:

- `read_file` **inside** the workspace runs.
- `read_file("~/.gitconfig")` is **refused**: `permission check failed for
  read_file ... user denied permission`, delivered as an `ERROR` step with no
  output, so the check precedes the read - there is no read-then-check gap.
- `list_dir` is advertised in the `init` event but calling it returns
  `Error: Tool 'list_dir' is not available in this environment`.

ALP now pins that behaviour instead of relying on the provider default:
`allowNonWorkspaceAccess: false` plus a `read_file(<root>)` grant per trusted
root, and a root whose path cannot be written as a rule meaning that path alone
is left out rather than sent malformed (agy accepts a malformed rule silently
and it grants nothing).

## Two provider behaviours ALP has to live with

- **A denied tool ends the whole turn.** Headless agy cannot ask, so the first
  tool its mode does not allow ends the turn with an empty response and
  `denied_actions` set - which is how a read-only reviewer returned no handoff at
  all (issue #308). An agent instruction that names a command the allowlist does
  not carry therefore costs the whole assignment.
- **An accepted edit is reported as `edit_file`.** That is the tool name a real
  workspace-write session emitted; read-only refuses it by name along with the
  other edit tools, so an edit can never be reported as a completed change in a
  read-only session.

## Checking a settings key without spending a turn

`agy --settings '{"someKey": ...}'` is validated before any model call and exits
with `--settings: unknown setting "someKey"` or an invalid-value error, so the
accepted schema can be probed at no cost. Accepted keys ALP uses:
`toolPermission`, `enableTerminalSandbox`, `trustedWorkspaces`, `permissions`
(`allow`/`deny`/`ask`) and `allowNonWorkspaceAccess` (a boolean). Rule *strings*
inside `permissions.allow` are **not** validated: a malformed rule is accepted
and grants nothing.
