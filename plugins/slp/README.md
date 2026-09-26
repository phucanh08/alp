# slp

Bundled alp plugin for the SLP seats: Supervisor, Lead, Peer. The daemon loads it when
`pluginsEnabled` is on. The build copies this directory as-is, so server code imports only
`@getpaseo/plugin`, `zod`, and Node built-ins, which the host provides.

## What it does

| Trigger                                                                        | Behavior                                                                                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before("agent.create")` on provider `claude` or `codex` with label `slp.role` | Appends the seat definition, the SLP-RUNTIME block, and the counterpart roster to the system prompt, and cuts the seat's tools (see [Seat tools](#seat-tools)). |
| `workspace.created` for a workspace created by the app or CLI                  | Ensures the workspace has a Lead.                                                                                                                               |
| `agent.turn_ended` of a Lead's first turn                                      | Tells each Supervisor the Lead did not register with, now if it is idle, otherwise when its own turn ends.                                                      |
| `agent.permission_requested`                                                   | Allows `mcp__paseo__*` tool cards for Lead and Supervisor.                                                                                                      |
| RPC `slp.lead.ensure { workspaceId }`                                          | Returns the workspace's live Lead, creating it when missing.                                                                                                    |
| RPC `slp.supervisor.ensure {}`                                                 | Returns the host's live Supervisor, creating the system workspace and agent when missing.                                                                       |

Contracts live in `shared/rpc.ts`. The client entry `index.client.tsx` is discovered by file name.
The manifest schema is strict and has no field for entries.

## Settings

The plugin registers one host-scoped settings definition (`shared/settings.ts`, id `slp`, version
1), stored at `$PASEO_HOME/plugin-settings/slp/slp.json`. `enabled` (default `true`) is the SLP
switch: `false` turns off every row in the table above — `before("agent.create")` returns
`undefined` for every request, including one that already names a valid seat; `workspace.created`
ensures no Lead; and the `slp.lead.ensure` / `slp.supervisor.ensure` RPCs reject with an error whose
message contains "SLP disabled". A corrupt or unreadable stored value counts as the default,
enabled. `supervisorModel` (default `null`) picks the model a freshly created Supervisor runs on:
`slp.supervisor.ensure` uses it in place of the provider's default model when it names a selectable
model of the Supervisor's provider (`claude`), and falls back to the default model otherwise —
`null`, an id that does not exist, or one marked not selectable. A live or resumed Supervisor keeps
its own model; the setting only ever applies to a Supervisor created from nothing.

## Seats

| Seat       | Provider                              | Title         | Label                 | Mode (Claude / Codex)               |
| ---------- | ------------------------------------- | ------------- | --------------------- | ----------------------------------- |
| Lead       | `claude/<default model>`              | `Lead`        | `slp.role=lead`       | `bypassPermissions` / `full-access` |
| Supervisor | `claude/<default model>`              | `Supervisor`  | `slp.role=supervisor` | `bypassPermissions` / `full-access` |
| Peer       | `<family>/<model>` chosen by the Lead | Lead's choice | `slp.role=peer`       | `default` / `auto`                  |

The seat is the `slp.role` label and nothing else. `<family>` is the base provider, `claude` or
`codex`; an agent with the label on any other provider is not an SLP seat, and the plugin leaves it
alone. The plugin creates Lead and Supervisor on `claude` with that provider's default model from
`listModels`. The Lead picks each Peer's model and `settings.thinkingOptionId` per task.

A `claude`/`codex` agent with no `slp.role` label at all — created directly by a Human, in the app
or over the CLI, or by a schedule run — defaults to Peer, so it gets the same tool cuts and
definition as any other Peer. It is tagged `slp.origin=schedule` when the request carries
`paseo.schedule-id` (the label a schedule run sets on the agent it creates) and `slp.origin=human`
otherwise. The hook tells either of those from "another agent made this" by `paseo.parent-agent-id`:
the daemon sets that label only when `create_agent` names a real calling agent, so its absence is
the signal. An agent that already carries `slp.role` — valid or not — is never touched or tagged;
only a request that names no seat at all gets the default.

This defaulted Peer is a special Peer: no Lead briefed it, so its SLP-RUNTIME block gets one more
paragraph a Lead-spawned Peer's does not. It says the Peer is independent — answer a bare Human
message as ordinary chat, without waiting for a brief or a Lead — and only step into the ordinary
Peer contract (wait for the 13-field brief, answer in the six-box handoff) once a Lead's brief
actually arrives over `send_agent_prompt`.

## Seat tools

`before("agent.create")` cuts tools per seat. Paseo tools go out through the hook's `paseoTools`,
which the daemon merges with the provider policy (cuts only add up) and freezes into the agent
record; the provider's own tools go out through `providerOptions`.

| Seat       | Paseo tools (`paseoTools.disabledTools`)                                                                               | Claude (`providerOptions`)                                                                          | Codex (`providerOptions`)                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Lead       | none                                                                                                                   | `allowedTools: mcp__paseo__*`                                                                       | unchanged                                                      |
| Peer       | `PEER_DISABLED_PASEO_TOOLS`: spawn, steer, stop, archive, schedule, reconfigure another agent, resolve its permissions | `disallowedTools: Agent, Task`                                                                      | `features.multi_agent: false`, `sandbox_mode: workspace-write` |
| Supervisor | `SUPERVISOR_DISABLED_PASEO_TOOLS`: every mutating tool except `send_agent_prompt`                                      | `allowedTools: mcp__paseo__*`, `disallowedTools: Write, Edit, MultiEdit, NotebookEdit, Agent, Task` | `sandbox_mode: workspace-write`                                |

The lists live in `server/seat.ts`. A cut is only as strong as the label: a Lead that spawns a Peer
without `slp.role=peer` gets an agent with no seat and no cuts. It is also only as strong as the
provider's own enforcement: `callerAgentId` on the MCP endpoint is advisory, so an agent with shell
access can call another agent's endpoint directly and skip the cut (see
[docs/plugins.md](../../docs/plugins.md#lifecycle-hooks)).

## Which workspaces get a Lead

`workspace.created` fires for every workspace, including the worktrees a Lead creates for its Peers
over MCP. Only app and CLI requests pass through `before("workspace.create")`, so the plugin records
those requests and creates a Lead only for workspaces that match one:

- A directory request matches by path.
- A worktree request matches by project. When the request names neither a project nor a known
  checkout, it matches the next created workspace once.
- A request that already brings an agent labeled `slp.role=lead` gets no second Lead.
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
