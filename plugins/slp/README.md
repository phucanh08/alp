# slp

Bundled alp plugin for the SLP seats: Supervisor, Lead, Peer. The daemon loads it when
`pluginsEnabled` is on. The build copies this directory as-is, so server code imports only
`@getpaseo/plugin`, `zod`, and Node built-ins, which the host provides.

## What it does

| Trigger                                                                                               | Behavior                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before("agent.create")` on provider `claude-lead`, `claude-peer`, `claude-supervisor` (or `codex-*`) | Appends the seat definition, the SLP-RUNTIME block, and the counterpart roster to the system prompt. Lead and Supervisor get `allowedTools: mcp__paseo__*`; the Supervisor also loses `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Agent`, `Task`. |
| `workspace.created` for a workspace created by the app or CLI                                         | Ensures the workspace has a Lead.                                                                                                                                                                                                                    |
| `agent.turn_ended` of a Lead's first turn                                                             | Tells each Supervisor the Lead did not register with, now if it is idle, otherwise when its own turn ends.                                                                                                                                           |
| `agent.permission_requested`                                                                          | Allows `mcp__paseo__*` tool cards for Lead and Supervisor.                                                                                                                                                                                           |
| RPC `slp.lead.ensure { workspaceId }`                                                                 | Returns the workspace's live Lead, creating it when missing.                                                                                                                                                                                         |
| RPC `slp.supervisor.ensure {}`                                                                        | Returns the host's live Supervisor, creating the system workspace and agent when missing.                                                                                                                                                            |

Contracts live in `shared/rpc.ts`. The client entry `index.client.tsx` is discovered by file name.
The manifest schema is strict and has no field for entries.

## Seats

| Seat       | Provider                                   | Title         | Label                 | Mode (Claude / Codex)               |
| ---------- | ------------------------------------------ | ------------- | --------------------- | ----------------------------------- |
| Lead       | `<family>-lead/<default model>`            | `Lead`        | `slp.role=lead`       | `bypassPermissions` / `full-access` |
| Supervisor | `<family>-supervisor/<default model>`      | `Supervisor`  | `slp.role=supervisor` | `bypassPermissions` / `full-access` |
| Peer       | `<family>-peer/<model>` chosen by the Lead | Lead's choice | `slp.role=peer`       | `default` / `auto`                  |

`<family>` is `claude` or `codex`; `seatProfileFor` in `server/seat.ts` picks provider and mode.
The ensure operations take the provider's default model from `listModels`. The Lead picks each
Peer's model and `settings.thinkingOptionId` per task.

A seat is recognized by its `slp.role` label, or by its provider when the label is missing.

## Which workspaces get a Lead

`workspace.created` fires for every workspace, including the worktrees a Lead creates for its Peers
over MCP. Only app and CLI requests pass through `before("workspace.create")`, so the plugin records
those requests and creates a Lead only for workspaces that match one:

- A directory request matches by path.
- A worktree request matches by project. When the request names neither a project nor a known
  checkout, it matches the next created workspace once.
- A request that already brings a `claude-lead` agent gets no second Lead.
- Records expire after 10 minutes.

One Lead per directory: a matching workspace gets no Lead when another active workspace with the same
directory already has a live Lead (not closed or archived). Upstream `paseo run` creates a new
workspace on every run without `--workspace`, so three runs in one directory would otherwise start
three Leads. Directories compare after `~` expansion and `path.resolve`, the way the daemon stores
them, without resolving symlinks. A Paseo worktree has its own directory and gets its own Lead.

Workspaces created by agents over MCP or by schedules get no Lead automatically. Call
`slp.lead.ensure` for them. That RPC skips the directory check and gives the workspace it names its
own Lead.

## The Supervisor workspace

The Supervisor lives in the `SLP Supervisor` workspace at `$PASEO_HOME/supervisor`. The plugin
subprocess inherits the daemon's environment and resolves the home the same way the daemon does:
`PASEO_HOME`, default `~/.alp`. Workspaces have no key=value labels, so the path is the identity.
`isSupervisorWorkspace` in `server/paths.ts` is the only place that decides it. That workspace never
gets a Lead. There is one Supervisor per host: `slp.supervisor.ensure` reuses any live Supervisor
before creating one.

## Seat definitions

`agents/<seat>.md` is the source, written for alp: seats talk through Paseo tools, tagged
`<paseo-agent-message>` envelopes, and finish notifications. `.claude/agents/` at the repo root is
Claude Code's own subagent directory, holding the Agent Teams versions for Claude Code sessions; the
two sets diverge on purpose and this plugin never reads that directory. `server/runtime-block.ts` adds
the runtime facts that depend on the family and on the plugin: message sources, steer, notification
limits, the Peer spawn call. It names no workflow skill; those live in the seat files.

The plugin compiler bundles `server/` into one evaluated string: at runtime the plugin has no path to
its own directory, and esbuild has no loader for `.md`. `server/definitions.gen.ts` embeds the files
instead, and the frontmatter is stripped when the prompt is built. After editing a seat file, run:

```bash
cd plugins/slp && npm run generate
```

`server/definitions.test.ts` fails when the generated module is stale.

A repository overrides a seat with `.slp/agents/<seat>.md` in the agent's cwd; the plugin never falls
back to `.claude/agents/<seat>.md`. The alp checkout has no `.slp/agents/` override, so a Lead in an
alp workspace gets the bundled definition.

## Checks

```bash
npx vitest run plugins/slp --bail=1
(cd plugins/slp && npx tsc --noEmit -p .)
```
