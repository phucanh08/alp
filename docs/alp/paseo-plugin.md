# ALP Paseo provider

The server-only plugin in `integrations/paseo` registers `alp` through the public `ProviderRegistration` API. All Paseo SDK imports are isolated in `server/compat.ts`; core, the runtime, and the daemon never import the SDK. No Paseo fork or ACP shim is used. Sessions run in `alpd`, the per-user ALP daemon (see [alpd](../../plans/reference/ALPD.md)): the plugin starts it when needed (`ALP_HOME`, default `~/.alp`), forwards Paseo inputs to it, and projects its events back to Paseo. Closing an agent in Paseo only stops watching it; running work finishes in alpd, which then closes the session. Use interrupt to stop work. To start alpd, the plugin uses `ALP_DAEMON_ENTRY`, the path recorded when it was built, the path alpd records in `$ALP_HOME/alpd.json` each time it starts, or the ALP CLI (`alp`) on `PATH`; if none is found, the provider reports that the CLI must be installed and started once with `alp daemon start`.

## Install

To install the published beta instead of building it, see [beta-install.md](beta-install.md#paseo-plugin) (`paseo plugin add npm:@anhlp/alp-paseo@beta` from `0.0.0-beta.2`; in beta.1 the `npm:` source fails, [#111](https://github.com/phucanh08/alp/issues/111): there run `npm install -g @anhlp/alp-paseo@beta`, then `paseo plugin add "$(npm root -g)/@anhlp/alp-paseo"`).

Prerequisites: Paseo `>=0.11.1 <1.0.0` (the published `0.0.1-beta.3` declares `<0.13.0`), Node.js 22 (22.12 or later) or 24, and at least one authenticated runtime: Codex or Claude Code. Development dependencies are pinned to Paseo SDK 0.12.0 and Claude Agent SDK 0.3.292; CI also runs the Paseo lane against SDK 0.11.1, the lower bound.

The same range is in `paseo-plugin.json` (`requirements.paseo`, which the Paseo host checks before it loads the plugin) and in the four `@getpaseo/*` peer dependencies. `node scripts/check-paseo-compat.mjs` (in `validate:paseo`) fails when they differ or the installed SDK is outside them; with `--latest` it also checks the latest published Paseo release: npm must install the packed plugin with it as peers under `--strict-peer-deps`, and that release's own plugin check must accept the packed manifest. `.github/workflows/paseo-compat.yml` runs this daily and opens an issue on failure. `ALP_CODEX_BIN` and `ALP_CLAUDE_BIN` may select absolute native executables; shell launchers (`.cmd`, `.bat`, `.ps1`) are rejected.

From this repository:

```sh
npm ci
npm run check
npm run build:paseo
paseo daemon config set pluginsEnabled true
paseo plugin install /absolute/path/to/alp-workspace/integrations/paseo
paseo provider models alp
```

The standalone web process of this package is integration `paseo` (`alp-paseo-integration --register` writes `$ALP_HOME/integrations/paseo.json`; `alp-web-integration` stays an alias for one release). It holds `integrations/paseo.lock`, keeps its address, token and server id in `$ALP_HOME/paseo.json`, and listens on a port the system picks: `web.port`, `web.json` and `integrations/web.lock` belong to the `alp-web` service, so both can run at once. The listener only answers `daemon.get_status` and Paseo sockets that present the token; relay sockets attach to the bridge directly. It keeps registering `web.pairing` with alpd, `settings.web.relay` configures its relay, and `alp web pair` starts it and prints the token from `paseo.json` as the password Paseo's app asks for. `alp web` itself no longer opens this process's web app (Paseo's, `server/dist/web-app`): it runs the CLI's `alp-web` service ([web.md](web.md) §3.1). The first `alp web` after the rename stops a pre-rename integration that still holds `integrations/web.lock` (only a provable same-user, same-boot owner) and copies its token and server id to `paseo.json` once, when `paseo.json` does not exist, so paired devices stay paired. For one release, a home registered only with the old `integrations/web.json` descriptor still starts it, with a hint to re-register, and `ALP_WEB_INTEGRATION` names its entry, checked after `ALP_PASEO_INTEGRATION`.

Select a team under **ALP** in Paseo's model picker: Phở and Cafe, then the teams of your library, then the project's. When a repository lacks `ALP.md` or `.alp/settings.json`, the provider creates them; agents, skills and teams come from ALP's built-ins and your library, so nothing else is copied. Existing files are preserved. A team fixes its members' models; other model names supported by the installed native runtime can be set through `.alp/settings.json`:

```json
{
  "runtime": {
    "provider": "claude",
    "model": "sonnet",
    "reasoning": "high"
  }
}
```

Codex CLI example:

```sh
paseo run --provider alp/gpt-5.6-sol --mode read-only --thinking low --cwd /absolute/project "Your task"
```

To select a custom folder, set `defaultAgent` in `.alp/settings.json` or use the public client:

```js
import { createPaseoClient } from '@getpaseo/client';
const client = createPaseoClient({ url: 'ws://127.0.0.1:6767/ws' });
await client.connect();
try {
  const agent = await client.agents.create({
    cwd: '/absolute/project',
    config: {
      provider: 'alp/gpt-5.6-sol',
      modeId: 'read-only',
      thinkingOptionId: 'low',
      options: { agent: 'your-agent' },
    },
  });
  console.log((await agent.run('Your task')).lastMessage);
} finally {
  await client.close();
}
```

Installation commands above target the selected user's daemon. Implementation verification used isolated homes under `.alp-test/`; it did not install the plugin into the user's existing Desktop daemon or change its configuration.

## ALP settings and the project panel

**Settings → ALP** edits your library in `$ALP_HOME` (default `~/.alp`), which every
project uses. The screen has two columns:
- The aside on the left starts with General (Language), then lists the kinds in three
  groups: Organisation (Teams, Agents), Capabilities (Skills, MCP servers, Hooks) and
  Runtimes (Providers). Each kind shows
  its count and, opened, its entries with a dot for where they come from. It stays
  in place, so you always see where you are and switch with one click.
- The aside folds to icons with its toggle, and folds on its own when the screen is
  narrower than 640 px. On a phone it opens from **Menu** over the screen.
- The working area has a breadcrumb, and a secondary menu on top: the source filters
  (All, Built-in, Library, Project) on a kind's list, or the parts of an entry
  (General, Members, Delegation, Supervisor, House rules for a team) in its editor.
  The editor keeps Save and Remove in a bar at the bottom.
- Each entry shows where it comes from: built-in, or library, possibly overriding a
  built-in. It also shows who uses it.
- Each section has New, and each entry Duplicate.
- Opening an entry edits it:
  - **Agent:** description, provider, model, thinking, context (Auto or 200k to 1M
    tokens before compaction), default mode, instructions
    (`AGENT.md`), and switches for the skills, MCP servers and hooks it uses. The
    skills your library gives an agent by name (`role-skills.json`; main, lead and
    peer start with ALP's six) show on, marked "Default for this agent". Changing
    them in Settings → ALP saves `role-skills.json`, so a built-in agent keeps
    following ALP's instructions. In the ALP project panel they show locked.
  - **Team:** label, main, members and their roles, each member's model and
    thinking, who may delegate to whom (a cycle is shown and refused), the most
    peers at once, the supervisor and its model, and the house rules.
  - **Skill:** `SKILL.md`.
  - **MCP server:** a command with arguments, environment and working directory, or
    a URL with headers. **Test** starts it and lists its tools.
  - **Hook:** its event and command, whether it blocks (only for events before an
    action), its timeout, and an agent or task label it is limited to. **Test** runs it
    once with a sample event.
  - **Provider:** an ACP agent's label, command, arguments, environment and models.
    **Test** starts it and shows what it supports ([ACP providers](agent-library.md#acp-providers)).
    The agent form's Provider list offers the library's providers.
- Built-ins are read-only. **Save as my own** makes the library's entry of that name,
  which overrides the built-in. Removing it brings the built-in back.
- **General → Language** is the language you read (ALPD §54). Main writes its replies,
  questions, approval requests and task titles in it; other agents ask you in it; ALP
  asks for approvals and writes its notices in it. Pick one from the list, or Other to
  type a name. Unset, Vietnamese applies; **Reset** goes back to it. It is `language`
  in `$ALP_HOME/settings.json`, also set with `alp language`.

The **ALP project** workspace panel shows the same lists for the workspace's project,
except Providers, which live only in the library:
- **Override in this project** copies an entry into `.alp/`.
- **Use library** removes the project's copy.
- Opening an entry edits the project's copy.

Both use the `alp.library.*` RPC (ALPD §43), the same functions as `alp agent|team|skill|mcp|hook|provider`.
Each save checks the entry's revision, so two windows cannot overwrite each other.
Changes apply to new sessions; running sessions keep what they started with.

## Tasks: panel, screen and the composer pill

The tasks of the workspace's ALP project (`.alp/tasks`) show in the same board in
two places ([the Tasks panel](team-workflow.md#the-tasks-panel-in-paseo) describes
the board itself):
- **The Tasks panel** (desktop): open it from the workspace's **+** tab, or from the
  command center with "Open ALP tasks". When it is 820 px wide or more, a task's
  detail sits beside the list.
- **The Tasks screen** (`alp-tasks`, any client, phones included): a whole screen with
  the same board. Its header's close button goes back to the chat. Opened on a task, it
  shows that task's detail; the detail's back arrow shows the list.

The phone app cannot reach a workspace's **+** tab, so the screen opens from the chat:
- **The Tasks pill** in the composer of every ALP agent, above the message box. Its
  label counts the open tasks ("Tasks · 3"). Tap it for a menu of the open tasks,
  what waits for you first: Approve, Review, In progress, Ready, Blocked, each with
  the task's title. Epics and closed tasks stay on the board, and the menu lists at
  most eight. Tap a task to open the screen on its detail, or **All tasks** for the
  whole board.
  - Once the agent's session has worked on tasks, those come first in the menu, done
    ones too, and the label counts them: "Tasks · 1/2" is one of two done. They are
    the tasks ALP reports at the end of a turn; Paseo would otherwise show them as a
    second pill of its own ("0/1 tasks") that opens nothing, so the provider keeps
    them for this pill instead (ALPD §55).
  - The pill is hidden when the workspace's directory is not in an ALP project.
  - It shows only on agents whose provider is ALP. The provider always runs them in
    an ALP project, so the plugin needs no extra check to find one.
- **`/alp-tasks`** in any agent's composer opens the screen, and `/alp-tasks t-0003` opens
  that task.
- The command center's **"Open ALP tasks full screen"** opens the screen for the
  current workspace.

How the pills stay current:
- A composer pill belongs to one agent. The plugin therefore follows the host's agents
  through `paseo.agents.list` with a subscription, and adds or removes pills as ALP
  agents come and go.
- It reads each workspace's directory once and polls `alp.tasks.list` every 20
  seconds, once per project however many agents show it.
- A pill changes only when its tasks do, so a menu you have open stays open.
- The screen's params are strings in its URL: `workspaceId`, `directory` and
  optionally `taskId`. Screens get no workspace state from the host, so the opener
  passes the directory.

## Mapping and supported behavior

| Input | Behavior |
|---|---|
| `cwd` | Must be an existing absolute directory; used as ALP root and process/thread cwd. An empty repository is initialized from the bundled starter on first open |
| Agent | `providerOptions.agent` → restored agent identity → configured `defaultAgent` → `main` |
| Runtime | Persisted runtime → a `codex:`/`claude:` prefix on the model → `runtime.provider` → `codex`. Main with neither `runtime.provider` nor `runtime.model` runs on Claude (its profile model) |
| Instructions | `ALP.md`, selected `AGENT.md`, lazy skill path index, then host system instructions become runtime developer instructions |
| Skills | Paths only until runtime needs the skill; bodies are not injected by discovery |
| Environment | Session env overrides plugin process env; parent thread and Paseo control environment entries are removed; each session gets a separate process |
| MCP | Agent-local and host servers are combined; collisions fail. stdio and HTTP supported; SSE rejected. Headers map to Codex `http_headers` |
| Model | The picker lists two profiles, `pho` (Phở) and `cafe` (Cafe); the selection picks the profile, not a model (`providerOptions.workflow` and `settings.workflow` are still accepted, including the old names `smart`/`supervised`). The session model is `runtime.model` → main's profile model `claude:claude-opus-5-5` → runtime default (`gpt-5.6-sol` or `sonnet`). A root's config shows its profile; a child's shows its own model. Changing the profile or model of an open session fails |
| Thinking | Not chosen in Paseo: `runtime.reasoning` → `high` for main's profile model (and oracle) → `medium` |
| Mode | `full-access` by default in Paseo (main's default elsewhere too); `read-only` and `workspace-write` also supported. `full-access` runs Claude with `bypassPermissions` and Codex with the `danger-full-access` sandbox. Permissions can change while idle; oracle, reviewer and supervisor remain read-only and children cannot exceed parent permissions |
| Approval | `never`; interactive approval and per-tool policy are not advertised and are rejected |
| Persistence | Paseo stores a version 2 handle naming the alpd session, its agent and project root; alpd keeps the native thread, workflow snapshot and timeline, and resumes them on reopen. Version 1 handles (native thread in Paseo) are adopted on open. Roots started outside Paseo, for example with `alp run`, appear in Paseo's import list with their children |
| Refresh | Close then resume; reread ALP files and current launch config. Cross-project or cross-agent resume fails |
| Prompt | Text and files uploaded to Paseo; one result per message ID; duplicate IDs in the live session do not re-execute |
| Uploaded files | Each `uploaded_file` part becomes an ALP attachment in its place (`{ type: "attachment", attachmentId }`, [protocol §12.6](../protocol/alp-json-rpc-v1.md)): the provider reads the file Paseo's daemon stored and uploads it into alpd's store for the session under a requestId of the message ID and part index, so the same message sent again (retry, reconnect) reuses one stored object. Only a file exactly at `<paseoHome>/uploads/upload_<uuid>/<name>` is read (`server/uploads.ts`): `<paseoHome>` is resolved as Paseo resolves it (`PASEO_HOME`, else `~/.paseo`), the directories below it must be real directories of this user, the file is opened without following links and must be a regular file of this user with one link and exactly its declared size, within alpd's `attachmentLimits`; anything else is refused naming the file, never its host path. The provider fails closed on what alpd offers: alpd must list capability `attachments` (the connection's handshake capabilities, else its `daemon.hello` answer's) and its `daemon.hello` must name valid `attachmentLimits` (safe non-negative integers, non-zero count, message and chunk bytes); otherwise files are refused, never sent under protocol defaults. Every file of a message is read and checked before the first upload begins, so a refused file leaves no stored object. A runtime that cannot read attachments answers `1005 attachment_unsupported`, shown as the message's failure. The remote entry reads no file on this machine and refuses uploaded files |
| Terminals | The Paseo integration's web facade's Paseo terminal pane runs a real PTY in alpd ([protocol §12.10](../protocol/alp-json-rpc-v1.md)): a shell **as the account that runs alpd**; the workspace only picks where it starts and is **not a sandbox**. Paired Paseo devices act as the owner and hold no gateway `terminal.exec`, so the bridge offers terminals only after **two** host opt-ins in the owner-private `<ALP_HOME>/terminal.json`: `alp terminal allow --paseo --yes` (sets `allowRemoteTerminal` and `allowPaseoTerminal`), checked again at least every 5 s (turning it off closes in alpd every terminal the bridge holds); otherwise it makes no `terminal.*` call and create answers how to turn them on. The cwd must be exactly a live registry workspace's directory; commands, arguments, profiles and agents are refused (ALP picks the shell). One alpd attachment per terminal fans out to every Paseo client (binary Output/Restore frames; reconnects get a Restore of the 1 MiB replay, no server-side screen snapshot); opening a terminal another local ALP client has attached takes it over (`replaced`). Not supported: `capture_terminal`, rename, terminal profiles, agent hooks; Windows |
| Steering/cancel | Codex `turn/steer` and `turn/interrupt`; terminal events are deduplicated |
| Close | Graceful stdin shutdown, bounded forced shutdown fallback for the owned process |

After first-session initialization, ALP configuration files are read-only to the plugin. A model operating in `workspace-write` may edit project files as requested; the no-corruption lifecycle check runs against a fake native runtime, so no model edits files.

## Prototype limits

- Hooks, interactive permissions, images (`prompt.image`), structured commands, output schemas, live model/thinking changes, session listing, and revert are not supported or advertised.
- These limits are the provider's (a Paseo daemon running this plugin). The Paseo integration's web facade (`server/paseo/`) speaks to alpd itself and offers the issue #121 operations there: history paging, conversation rewind, live team/model/thinking changes, Reload agent, read-only Git, terminals, shared workspace pins and managed worktree creation (removal is in apps/web; archiving a worktree workspace in the facade keeps its checkout) ([issue-121-acceptance.md](issue-121-acceptance.md)). Neither offers Paseo's fork (a text summary of the context, not a faithful fork) or Copy resume command (Paseo builds it from a native provider template; ALP's own command is `alp attach <id>`).
- The ALP web app's Paseo facade (`server/paseo/`) accepts `file.upload.request` followed by Paseo binary Begin/Chunk/End frames. Files stay in bounded memory on the authenticated **connection**, with opaque `alp-upload:` tokens; the hello's client ID never grants access and no token is a host path. Existing-agent messages (including legacy `send_agent_message`), new agents and new workspace agents resolve every file on that same connection before sending its bytes through alpd's session-bound attachment store. Text and valid inline images stay intact. Unsupported issues, change requests, review comments and text context refuse the whole message. A failed prompt is reported as not accepted; a failed new agent's first delivery says the agent was created.
- Facade staging limits: 20 MiB per file, eight files / 40 MiB per connection, 64 files / 128 MiB across the bridge, a 1 MiB binary chunk (plus its protocol header), and ten minutes from upload request to expiry. Declared bytes are reserved in one buffer before receiving chunks, including incomplete and completed uploads. Expiry/disconnect removes future grants; an in-flight conversion retains its reservation until it finishes. Reconnect requires uploading again. Names must be a basename without controls (at most 240 UTF-8 bytes); MIME must be a bare type/subtype, request IDs at most 255 UTF-8 bytes. Begin metadata must match the request and End must match its exact byte count. Malformed or oversized frames fail pending uploads; errors/disconnect release staging. Daemon `attachmentLimits` can lower the file/count/message limits further. Failed daemon uploads are aborted; committed objects whose prompt failed remain subject to alpd's normal unreferenced retention. Same-session/message attachment conversions are serialized (at most eight in flight per connection, 64 bridge-wide), and same-socket retries reuse daemon upload IDs and the chosen delivery mode (last 128 messages).

Facade creation retries use a versioned journal at `<ALP_HOME>/state/paseo-create/receipts.json`. Agent and directory-workspace operations each bind `idempotencyKey ?? requestId` to a hash of their full received intent, with generated session/message IDs and progress recorded before side effects. All sockets authenticated by the shared host token are one owner; `hello.clientId` grants no separate identity. Equal sequential/concurrent requests replay or join one attempt, including text-only reconnects and integration restarts with the same retained home. Different content conflicts, even after restart. Response correlation uses each retry's own `requestId`. Completed replay reads the retained agent/workspace; missing resources are reported instead of recreated. Native managed-worktree creation keeps its existing daemon-owned receipts and safety checks.

A known pre-open `session.create` parameter refusal (`-32602`) can continue with the same reserved session ID, including an initial agent whose workspace already committed. Unanswered create, rename, workspace mutation, attachment conversion or first-prompt dispatch is fenced as unknown; it is never automatically repeated or treated as success. A received failed first-prompt outcome remains failed, with its existing agent named for inspection. Old workspace metadata without the corresponding facade receipt cannot prove the initial-agent intent and is refused. File-bearing creation always revalidates the current socket's upload grants before joining/replaying; neither another socket with the same hello ID nor a restarted integration can resurrect them. Reuploading changes the intent and cannot silently replace the original operation.

The journal requires private directories and one exclusive `writer.lock` for its full lifetime. Normal shutdown drains admitted operations and releases that lock. After a crash, stop **all** facade processes using that home before removing **only** `state/paseo-create/writer.lock`; retain `receipts.json` and restart. Locks are never reclaimed by PID/age, and corrupt/unsupported journals fail closed without replacing their contents. Atomic replacement protects against process interruption, but writes are not fsynced: host power loss, disk failure, restoring an older backup, deleting receipts, or manually removing a live writer's lock is outside this guarantee. No receipt is automatically expired or evicted; at 4096 records or 8 MiB the journal refuses new identities while retaining existing ones. Capacity requires an explicit archival/retry-horizon policy before clearing any history.
- Legacy `create_paseo_worktree_request` uses the existing host-authorized generated-HEAD worktree operation. Nonempty `FirstAgentContext` (including attachments), `nameContext` and legacy worktree attachments are explicitly refused with `create_paseo_worktree_response`: upstream uses that context for naming/setup, which this facade does not run. It never discards context or creates an unsolicited agent. Protocol reference: installed client 0.11.1's `uploadFile`, protocol 0.11.1/0.11.2 [binary codec](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/protocol/src/binary-frames/file-transfer.ts), and [worktree context normalization/use](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/server/src/server/worktree-session.ts#L190).
- Delegated child sessions are supported through `alp_delegate` and the public `session.subsession` contract. See [team workflow](team-workflow.md) for routing, migration, lifecycle, and limits. Start a new main session after enabling delegation in an older project: old native threads may have no registered delegation tool.
- Live timeline mapping covers assistant text, shell commands, dynamic delegation calls and compactions (Paseo's compaction row; a failed one is a warning); other native tool item types are not yet rendered. This is not a complete Codex UI replacement.
- Replay uses the history returned by `thread/resume`; exhaustive pagination of very large native histories is not implemented.
- Runtime may load the user's normal Codex or Claude Code authentication. ALP does not replace global authentication or write credentials into project files.
- Claude Code runs through the Claude Agent SDK. ALP disables Claude's native multi-agent tools and exposes the ALP tools (`alp_delegate`, `alp_wait`, `alp_send`, `alp_ask`, `alp_handoff`) as in-process MCP tools so the same configured delegation graph and Paseo child-session lifecycle apply to both runtimes.
- SDK 0.11.1 does not provide the newer documented `connect.launch` environment field or process helper exports; the compatibility wrapper targets the actual installed contracts. Runtime process code uses native executables with argument arrays and no shell.
- There is no custom client UI. Provider selection/catalog/session behavior was verified through the real daemon and public client/CLI, not by a Desktop screenshot.

## Repeat verification

`npm test` uses fixture transports and real public SDK schemas. It makes no model calls. `node test/e2e/runtime-e2e.mjs` is an opt-in real Codex lifecycle check; set `ALP_CODEX_BIN` if necessary. `npm run test:e2e:paseo` invokes the real model through an already running isolated Paseo daemon with the plugin installed. It creates a new fixture project, runs main/custom/reload, archives test agents, and compares every fixture file byte-for-byte.

E2E variables:

- `ALP_TEST_PASEO_URL`: default `ws://127.0.0.1:16767/ws`.
- `ALP_TEST_PASEO_CLI`: path to the selected CLI's JS executable for reload. Use a CLI matching the daemon.

Use `paseo daemon run --home /isolated/home` with a loopback `daemon.listen` setting. Enable plugins in that isolated home. Disable relay, voice and dictation for the test daemon. Stop that daemon after testing. The E2E scripts never provision or modify the default user daemon.

Sources checked during implementation: [Paseo provider guide](https://paseo.sh/docs/plugins/providers), installed public SDK declarations for 0.9.2, 0.10.3 and 0.11.1 (the plugin requires 0.11.1 since the Tasks panel), [Codex app-server](https://learn.chatgpt.com/docs/app-server), and protocol types generated by the local Codex 0.160.1 binary. The requested model ID follows [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
