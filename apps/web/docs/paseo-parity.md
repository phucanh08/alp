# apps/web compared with paseo-web

> **Historical.** paseo-web was removed from this repository on 2026-10-27 (task t-55ce.3, PR
> #233): its patches, `paseo-web/upstream.json`, `scripts/build-paseo-web.mjs`, `dist/web-app`
> and the screenshot script `apps/web/scripts/compare-paseo.mjs` are gone, and `alp web` serves
> apps/web. The paths and commands below describe the repository before that; the comparison is
> kept as the record of the parity work.

This document compares the screens and features of **paseo-web** with those of **apps/web**,
lists what apps/web is missing, and ranks the gaps. Tasks t-7679.1 (chat/timeline), t-7679.2
(sidebar/workspace), t-7679.3 (settings persistence and the New session flow), t-7679.5 (the workspace's
P1 items that need no backend), t-7679.9 (split panes, the command center's missing entries) and
t-7679.6 (History paging and search on the host, question events for every session) and
t-7679.10 (finished/error attention, the command center's Files scope and Workspaces section) and
t-7679.17 (the tasks board's List/Board/Epics views, filters and search) and t-7679.18 (reading
workspace files: file tabs, the Files panel, file links; §3.1), part of epic t-7679.

- **paseo-web** is Paseo 0.11.2 (getpaseo/paseo @ `b63a325`, `paseo-web/upstream.json`) with the 19
  ALP patches in `paseo-web/patches`, built into `dist/web-app`.
- The app (`packages/app/src`) was read at that commit. The behaviour on ALP was also observed by
  running both apps on one host (§5).

Order of work, decided by the user:

1. chat/timeline (with the composer);
2. sidebar/workspace;
3. settings;
4. everything else.

The goal is the same layout, flows and behaviour. Visual details should come close, not match pixel
for pixel.

**Status** of apps/web for each feature:

- **Có**: has it.
- **Một phần**: has part of it.
- **Thiếu**: missing.
- **Đã làm**: done in t-7679.1 (chat), t-7679.2 (sidebar/workspace), t-7679.3 (settings, New session), t-7679.5 (workspace P1) or t-7679.9 (split panes, command center).

**Backend** says whether the gateway exposes what the feature needs (`apps/gateway/src/policy.js`,
`docs/protocol/alp-json-rpc-v1.md` §12, §14):

- *yes*: it does;
- *no*: it needs protocol, gateway or daemon work.

**Priority**:

- **P0**: the main daily flow looks different, and apps/web can fix it now.
- **P1**: important but secondary, or partly blocked.
- **P2**: niche, or fully blocked by the backend.

Abbreviations: P: = `packages/app/src/` of Paseo; W: = `apps/web/src/`.

## 1. Top gaps by area

| Area | Main gaps |
|---|---|
| Chat/timeline | Done in this slice: the mode control (menu and Shift+Tab), the Tasks pill, the question card in the stream with Paseo's select-then-Submit flow, scroll-to-bottom, Cmd/Ctrl+L and Escape, and a race in sending fixed. Per-tool detail views: done in t-7679.13 (see the tool call row below). Still missing: virtualization and paging of long histories, chat find (Cmd+F), chat outline, the text reveal, slash commands, dictation and voice (the context meter: done in t-7679.12; rewind and fork: done in t-15b0.4). |
| Sidebar/workspace | Done in t-7679.2: Paseo's workspace keyboard shortcuts and their Shortcuts dialog, History with the archived sessions and Unarchive, attention on every session (`question.list`), the session title on its tab. Done in t-7679.6: History's Load more and host-side search (`session.list` pages), attention from `question.watch` events in place of the 5 s `question.list` poll. Done in t-7679.5: the tab context menu, drag order and tabs kept across reload, resizable sidebar and dock, the command center (⌘K), favicon and title status, browser notifications when a session waits. Done in t-7679.9: split panes, the command center's ALP commands (Open ALP tasks, its full-screen board) and pane commands. Done in t-7679.18: read-only file tabs, the Files panel and file links in agents' replies, with the files.read permission (§3.1). |
| Settings | Done in t-7679.3: settings kept across reload (localStorage, never the token), Appearance › Theme (System/Light/Dark with Paseo's light palette), Reset, the New session screen (Paseo's new agent tab: first message, team/model/thinking/permissions controls, `session.preview`, remembered choices). Still missing: fonts and sizes, Paseo's other themes, chat display settings, editing executable/inherited library content (project-only agent/skill instruction CRUD done in #118 with opt-in library.write), providers (blocked: §14), client diagnostics. |
| Rest | i18n (Vietnamese/English). Stacking toasts. Error boundary. (Browser notifications when a session waits: done in t-7679.5.) |

## 2. Chat/timeline and composer

| Feature | paseo-web | apps/web before | Backend | Priority | Now |
|---|---|---|---|---|---|
| Stream layout: 820px column, user bubble on the right, plain-markdown assistant, item spacing | P:agent-stream/view.tsx, spacing.ts, components/message.tsx | Có (W:app/Timeline.tsx) | yes | none | Có |
| Turn footer: copy turn, "Worked for", end time on hover | P:agent-stream/turn-footer.tsx, message.tsx AssistantTurnFooter | Có (W:Timeline.tsx TurnFooter) | yes | none | Có |
| Working row: 2x3 loader and elapsed time | P:turn-footer.tsx RunningTurnFooter, components/synced-loader.tsx | Có (W:chat/parts.tsx Loader, Elapsed) | yes | none | Có |
| Fork icon in the turn footer | P:components/assistant-fork-menu.tsx | Có (W:app/Conversation.tsx ForkAction/ForkDialog, lib/conversation.js) | yes: `session.fork` (§12.7, capability `session.fork`, gateway §5.15) | none | **Đã làm** (t-15b0.4): "Fork from here…" in the footer of a finished turn of the main conversation, shown only when the host lists the capability and the root's summary says `conversation.fork` (else hidden; the summary's reason is kept for the tooltip). A dialog: "In a new tab" (`boundary { throughTurnId }`, same workspace) or "In a new worktree" (when `workspace.worktree` and the token's `workspace.manage` allow it: the worktree is made first through `workspace.worktree.create`, then the fork runs there with its `workspaceId`), with "Files are not copied: the fork works on the current files of where it runs." The fork opens at once (the app shows one session's tabs at a time, so it replaces the source's tab; the source stays in the list and is linked from the fork's marker). A fork shows its provenance (`forkedFrom`) on its `fork:` marker, with a link to the source when it is listed. Refusals in words (lib/conversation.js). Browser proof: e2e/conversation.spec.js |
| Tool call badge, expands to detail; per detail type: shell, read, edit, write, search, fetch, sub-agent, plan, plain text, unknown | P:message.tsx ExpandableBadge/ToolCall, tool-call-details.tsx, protocol tool-call-display.ts, utils/tool-call-icon*.ts, tool-call-parsers.ts, diff-viewer.tsx | Có (W:Timeline.tsx ToolCall, chat/ToolCallDetail.tsx, lib/tool-calls.js) | yes: typed `detail` in `tool_call` items (t-7679.13; Codex fileChange, webSearch, mcpToolCall and collabAgentToolCall mapped) | none | **Đã làm** (t-7679.13): Paseo's rows: Shell/command, Read·Edit·Write/path relative to the workspace (as granted or its real path), Search/query, Fetch/url, sub-agent type (else Task)/description, Plan, a plain-text tool's name/label, else the humanized name (MCP names as they are) and the first string argument; ALP's tools as before (Delegate to <agent>, Ask …); Paseo's icons (terminal, eye, pencil, search, bot, brain, wrench); an edit's `+N −M` on the row. Views: a read or written file with a line gutter (a read from its offset), an edit as a diff (old and new line numbers from the unified diff's hunks, several files with a header each; from old/new strings a line diff), a search's content, files (relative) and web results as links (http/https only, new tab, `noopener noreferrer`), a fetch's url, status, prompt and result, a sub-agent's task and log, a plan as markdown, plain text, else the input/output; a detail type this build does not know shows as unknown; errors as before. Long bodies show 400 lines, then "Show 400 more lines"; a string edit larger than 1,000,000 old×new lines (after the common head and tail) shows its removals then its additions. **Deviations**: no syntax highlighting and no word-level diff (Paseo has both); a diff from old/new strings has no line numbers, since the strings' place in the file is unknown; a sub-agent log is shown as text (Paseo lists its `[Tool] summary` lines as rows); no file-open from a row (Paseo opens the file); Paseo's own-tool sections (paseo-tool-call-detail) have no ALP counterpart; Read, fetch and plan come only from providers that report them (Claude, ACP), not from Codex |
| Todo in the stream (badge) | P:message.tsx TodoListCard | Có (W:Timeline.tsx Todo) | yes | none | Có |
| Tasks pill above the composer: label `Tasks · n` or `done/worked`; menu lists the session's tasks first, then open ones, then All tasks | ALP plugin: integrations/paseo/client/task-pills.ts, P:composer/tracks.tsx | Thiếu | yes (`task.list`; session work from the todo item) | P0 | **Đã làm** (W:app/chat/tracks.tsx, lib/tracks.js) |
| Question card: question text, radio options, "Other..." field, Dismiss and Submit; it sits at the tail of the stream and scrolls with it | P:components/question-form-card.tsx, view.tsx PermissionRequestCard / renderLiveAuxiliary; ALP mapping in integrations/paseo/server/paseo/agents.ts permissionOf | Một phần: one click answered at once, "Decline", the card sat between stream and composer | yes (`question.answer`) | P0 | **Đã làm**: Paseo's select, then Submit flow; Other replaces the choice; Enter submits; inside the log (W:QuestionCard.tsx, SessionView.tsx) |
| Scroll-to-bottom button (48px round, chevron) when away from the end | P:agent-stream/view.tsx scrollToBottomButton | Thiếu | client only | P0 | **Đã làm** (W:Timeline.tsx) |
| Composer: one rounded surface, text above, controls below; Send / Interrupt / none | P:composer/index.tsx, composer/input/input.tsx | Có (W:Composer.tsx) | yes | none | Có |
| Enter steers while running, Cmd/Ctrl+Enter queues; the Default send setting swaps them; queue with Edit / Send now above the box | P:composer/submit.ts, actions.ts, tracks queue | Có | yes | none | Có |
| "⌘L to focus" hint; Cmd/Ctrl+L focuses the box | P:keyboard/keyboard-shortcuts.ts `message-input-focus-*` | Thiếu | client only | P0 | **Đã làm** (W:Composer.tsx) |
| Escape interrupts the agent (from the box or from no particular element) | P:keyboard-shortcuts.ts `agent-interrupt` | Thiếu | yes (`session.interrupt`) | P0 | **Đã làm** |
| Mode control: a menu of modes with a check on the current one; Shift+Tab cycles | P:composer/agent-controls/mode-control.tsx; bridge set_agent_mode_request → `session.configure` | Một phần: a read-only label | yes (`session.configure`, mode inside the grant; the runtime changes it only between turns with no child running) | P0 | **Đã làm** (W:SessionView.tsx ModeControl, controller.configureMode); locked, with a tooltip, while the agent or its team works |
| Team control "Phở ⌄" (patch 0018 "Select team") | P:components/combined-model-selector.tsx, patches 0018/0019 | Có (W:app/SessionView.tsx LiveAgentControls) | yes: `session.configure { team, requestId, ifGeneration }` with capability `session.configure.live` and the opt-in gateway permission `session.team.write` (§12.9, t-15b0.16) | none | **Đã làm** (t-15b0.16, #121 D): the open session's toolbar has a Team menu (`team.list`'s teams, the current one checked) beside Model and Thinking; choosing one previews it (`session.configure.preview`, so a team whose main is another agent is refused before anything restarts) and then restarts main on the same conversation with that team. The label is the host's (`teamLabel` of the summary, `session.updated`, the answer's `configured.effective`), never the choice before the host took it. Disabled, its tooltip saying why, without `session.team.write`, without session.write or outside the token's modes, while main or an agent works, while the session is closed or loading, or offline; an older host shows the labels read-only. A refusal leaves the labels and shows the gateway's fixed reason; a team with another main agent (agent_mismatch) offers **New session** in the notice. Assignments keep the team they started with (W:lib/configure.js, controller configureLive; e2e/configure.spec.js) |
| Busy as soon as a message leaves: the stop button appears and Cmd/Ctrl+Enter queues before turn.started | P:composer/index.tsx isProcessing / submit loading | Bug: a message sent before turn.started went as `auto` and the host refused it ("Turn already active") | yes | P0 | **Đã làm**: `controller.rootBusy`; a second message waits for the first one's answer, then steers (W:lib/controller.js) |
| Placeholder "Message the agent, tag @files, or use /commands and /skills" | P:composer/input/labels.ts | "Message main…" | @files and /commands: no | P2 | Kept: ALP has neither |
| Attachments (+ menu: image, paste, file, GitHub PR/issue) | P:composer/attachments, index.tsx attachmentMenuItems | Một phần: images and files | yes: inline image parts in `session.prompt` (`prompt.images`, docs/protocol/alp-json-rpc-v1.md §10; gateway limits docs/alp/remote-gateway.md §5.8); files through alpd's attachment store (`attachments`, §12.6; `attachments.write`, remote-gateway §5.14) | P2 | **Đã làm (ảnh)** t-7679.11: the + button opens the image picker, paste and drop add images, a preview each with Remove, the gateway's limits (4 images, 2 MB each, 2.5 MB together; PNG/JPEG/GIF/WebP) checked before sending with the reason; the sent message shows "N images"; the button only for a session whose runtime takes images (`promptImages`: Codex, Claude, ACP agents offering `promptCapabilities.image`) (W:app/Composer.tsx, lib/attachments.js, Timeline.tsx, controller.sendPrompt). **Đã làm (file)** t-15b0.15 (#121 J): with capability `attachments`, a token holding `attachments.write` and a session whose runtime lists `promptAttachments`, the + button ("Attach files"), drop and paste take any file (an image the session takes still goes inline); a chip each (name, size, Remove); hello `attachmentLimits` (files per message, per file, together) checked before sending; the controller uploads each file under the session (`attachment.begin`/`chunk`/`commit` through the SDK's `attachments().upload`) with a requestId derived from the message and the file's place, shows progress on the pending message, then sends `{ type: 'attachment', attachmentId }`; a dropped connection continues the same upload by itself once it is back, Retry never uploads a committed file again (unless the host lost it: a prompt refused `not_found` uploads the files `attachment.get` no longer finds afresh under a new requestId, and `attachment_unavailable` the file alpd names, or through the gateway, which passes only the reason, every committed file of the message); Discard aborts, best effort, an upload begun and not committed (a committed object is left to alpd's collection); a file the browser cannot read is left out with its reason; the sent message shows a chip per file (name, size; never a host path); a refusal (token, runtime, limits, alpd's `attachment_unsupported`…) is shown and the message is never marked sent. The New session screen holds the files until the session exists, then uploads them under its id. Deviations: no menu (no GitHub or plugin attachments); no images in the New session first message (a picked image goes there as a file); a message with images or files is sent or steered, never queued; the sent message keeps the image count, not a thumbnail |
| Slash commands and autocomplete | P:composer index ComposerAutocompleteBinding, client-slash-commands | Thiếu | no | P2 | Thiếu |
| Dictation (mic) and realtime voice | P:dictation/, voice/ | Thiếu | no | P2 | Thiếu |
| Context window meter | P:components/context-window-meter.tsx, context-window-details.tsx | Thiếu | yes: the `usage` event and the snapshot's `usage` (t-7679.12) | P2 | **Đã làm** (t-7679.12): Paseo's ring before the send button (and in an assignment's bar), filled clockwise from twelve with the share of the window used, muted below 70%, amber from 70%, red above 90%, an empty track and "No context data" until the runtime says both numbers; hover, focus or a tap shows Context window, "N% used", "54k / 258k tokens", ALP's "Last reported … input (… cached) · … output" (the latest response's tokens; an ACP agent's latest turn's) and "Session cost $…" when the runtime counts one (Claude, ACP in USD); kept across a reload (replayed from the host). Codex, Claude and ACP report a window; Antigravity does not, so its meter shows no data. **Deviation**: Paseo's hover card also lists the account's plan usage (refreshable); the gateway keeps `daemon.usage` local, so it is not shown (W:app/ContextMeter.tsx, lib/usage.js) |
| Rewind (user message menu) | P:components/rewind | Có (W:app/Conversation.tsx RewindAction/RewindDialog/RewindMarker) | yes: `session.rewind`, `history.reset`, `session.fork { branchId }` (§12.7) | none | **Đã làm** (t-15b0.4): "Rewind to here…" on each user message that started a turn other than the first (a steer starts none), disabled with a reason while the tree works. The dialog says the conversation goes back to before the message under the same session, the N later turns move to a branch that can be restored as a new session, and files in the workspace are not changed or restored. On success the timeline reloads the new history generation (also when another client rewinds: the live `history.reset`) and the message is put back in the composer. The `rewind:` marker is a divider ("Conversation rewound here — N later turns kept in a branch. Files were not changed.") with **Restore as new session**. Request ids: one per action, the same one again only after a lost answer (never after `outcome_unknown`). **Deviation**: Paseo's rewind can also restore files from checkpoints; ALP never changes files (user decision), so nothing is restored |
| User message: timestamp and copy on hover | P:message.tsx UserMessage | Có | yes | none | Có |
| Long histories: virtualized list, paging to older history, reading anchor | P:agent-stream/strategy-web.tsx, history-window.ts, bottom-anchor-controller.ts | Bounded initial tail, Load older messages, stable visible-row anchor; loaded rows remain rendered | `session.history` plus generation-bound `session.attach` | P1 | Backward paging and anchor implemented in t-15b0.2; virtualization remains separate. 650-item browser append/reconnect proof: e2e/history.spec.js. |
| Chat find (Cmd+F in the conversation) | P:agent-stream/chat-find | Thiếu | client only | P1 | Thiếu |
| Chat outline rail (jump between prompts) | P:agent-stream/chat-outline | Thiếu | client only | P1 | Thiếu |
| Text reveal of streamed text | P:agent-stream/text-reveal.ts | Thiếu | client only | P2 | Thiếu |
| Assistant markdown: code blocks with highlighting and copy, links to files | P:message.tsx AssistantMessage, highlighted-code-block.tsx, assistant-file-links | Một phần (W:RichText.tsx, chat/markdown.ts: no highlighting) | yes: `workspace.files.read` (files.read) | P1 | Một phần: **file links done** (t-7679.18): in an agent's reply only (not the user's text or task descriptions), inline code and Markdown links naming a file of the open workspace (`src/a.ts`, `./a.ts`, `src/a.ts:12`, `:12-20`, `#L12`, an absolute path under the workspace root, made relative) are link-styled buttons that open its file tab at that line (W:lib/file-links.js, a subset of P:assistant-file-links/parse.ts; RichText's FileLinkContext, given by Timeline.tsx). URLs, `~/`, `..`, paths outside the root and blocked paths stay text; so does everything where the host lacks the capability or the token lacks files.read. Deviation: a bare name in inline code (`cart.ts`, no slash) is not resolved: Paseo looks it up with a search, ALP does not yet. Code blocks: no highlighting |
| Compaction marker, notices | P:message.tsx CompactionMarker, Notification | Có | yes | none | Có |
| Subagents track pill (team members above the composer) | P:subagents/track.tsx, panels/agent-tracks.tsx | Một phần: the Agents panel and agent tabs (W:panels.tsx) | yes (`session.status`) | P1 | Một phần |
| Tab label: the session's title, with status and attention badges | P:screens/workspace/workspace-tab-presentation | "main" | yes | P1 (workspace slice) | **Đã làm** in t-7679.2 (W:Workspace.tsx useTabPresentation) |

## 3. Sidebar/workspace, settings, other areas

This section comes from a read-only survey of the Paseo source and the ALP patches. The
priorities are its own.

### 3.1 App shell and navigation

The column **apps/web** gives the state before t-7679.2; **Now** gives it after.

| Feature | paseo-web | apps/web | Backend | Priority | Now |
|---|---|---|---|---|---|
| Hosts list, picker and search | P:components/left-sidebar.tsx | Thiếu (one gateway) | no | P2 | Thiếu |
| Project, then workspace (worktree/branch), then agents | P:components/sidebar-workspace-list.tsx | Một phần: project = granted workspace; under it the host registry's workspace rows (title, branch, managed worktrees) and the sessions (W:app/Sidebar.tsx, WorktreeActions.tsx) | yes: `workspace.registry` (protocol §16; `project.read`), `workspace.worktree.*` (`workspace.manage`, macOS/Linux) | P1 | **Đã làm** (#121 E/F, PRs #182, #183, #201): shared registry rows with their branch, worktree create/remove from an approved host mapping (e2e/registry.spec.js, e2e/worktrees.spec.js). Left: Paseo's grouping of several projects' rows by its own project key |
| Add or remove a project | P:sidebar-workspace-list.tsx | Một phần: Add project (a pregranted directory); no remove | add: `project.register` (§16, `workspace.write`); remove: `project.remove` (§16, metadata only) | P2 | Add **đã làm** (#121 E, see Add project below); remove: Thiếu in apps/web (the `alp web` facade has Paseo's remove) |
| Workspace row menu: rename, pin, copy path/branch, archive, labels | P:components/sidebar/sidebar-workspace-menu.tsx | Một phần: Rename, Archive; Pin/Unpin as a row button | pin: yes (`workspace.update { pinned }`, `workspace.write`, §16); labels are owner-only (`registry.owner`) | P1 | Một phần: pin done (#121 E); copy path/branch and labels not in the menu |
| Pinned section; display preferences (grouping, filters, title source) | P:sidebar/pinned-section-header.tsx, display-preferences/menu.tsx | Một phần: pinned workspaces sort first, shared by every client and kept across alpd restarts; no separate Pinned header, no display preferences | pins: yes (§16); preferences: client only | P1 | Pins **đã làm** (#121 E, e2e/registry.spec.js: two clients, restart); section header and display preferences: Thiếu |
| Workspace labels, hover card | P:workspace-labels/, workspace-hover-card.tsx | Thiếu | no / partial | P2 | Thiếu |
| Status dot with attention on every session | P:components/agent-status-dot.tsx | Một phần: needs_input only for the attached tree | yes: `question.watch` (t-7679.6); `question.list` on an older host | P0 | **Đã làm**: since t-7679.6 the host tells of each question asked or resolved in any session of the workspace (`question.watch`, docs/protocol/alp-json-rpc-v1.md §12.2), read once per connection and workspace, after answering, and every 60 s as a repair; a host without it is polled with `question.list` every 5 s as before; the open tree's own questions count at once; needs_input outranks running, as Paseo's buckets (W:lib/controller.js refreshAttention, needsInput; Sidebar.tsx; History.tsx). **t-7679.10**: Paseo's finished/error attention (agent-manager checkAndSetAttention): a root's turn that ends `completed` while the user does not see that session (window hidden or unfocused, or another session in front) gives its row Paseo's green **attention** dot ("Finished"), `failed` the red failed dot, `canceled` nothing; the bucket order is Paseo's deriveAgentStateBucket: needs_input, then failed (status error or an error attention), then running, then attention, then done. History shows a "Finished" / "Needs attention" badge. Source: with the capability `question.watch.turns` the app asks `question.watch { turns: true }` and the host copies every root's `turn.ended` of the workspace (no cursor, never applied to a timeline); without it only the open tree's own live `turn.ended` counts (a replay on attach never does). Cleared, as Paseo's agent-attention clears it, when the user opens or focuses that session (also by coming back to the window on it), sends it a message, or it starts another turn (seen on the open tree); a switch of workspace or a disconnect forgets it. **Issue #120**: with the capability `session.attention` the host keeps it, as Paseo does, and every client shares it: the app asks `question.watch { attention: true }`, takes the answer's `attention` as the whole set (so a turn that ended while the page was closed or disconnected asks on the next read), follows the `attention` events, and acknowledges with `session.attention.clear` when the user opens, focuses or writes to the session or an ending arrives on the one in front, which clears it on every other client. A root not listed yet keeps its entry and shows once its row does (visibleAttention); an archived one never asks. Accepted: the host sets it even while a user looks at that session on one page, which acknowledges it at once; another page that is hidden meanwhile may already have shown its OS notification, which stays (Paseo skips setting it when a client reports that agent in focus). With the capability, a page whose attention watch has not answered yet shows a turn end only from its next watch read (at most 60 s). Deviations before that capability (an older host): ALP keeps it in this page only (a turn that ends while the page is closed or disconnected is not recovered); a turn started elsewhere on a session that is not open is only seen as `running` from `session.list` (running outranks finished as in Paseo, but an error attention stays until it ends again or is opened) (W:lib/controller.js #turnEnded, setPresence, clearAttention, attentionReason; lib/attention.js sessionBucket; app/status.tsx, Sidebar.tsx, History.tsx) |
| Sidebar items: New workspace, History, Search, Schedules, Usage | P:sidebar-nav/model.ts | Một phần: New session, Search | History: yes | P1 | Một phần: New session (⌘N badge on hover), History, Search (an inline filter; since t-7679.5 ⌘K opens the command center, which also has "Search sessions in the sidebar"); Schedules and Usage have no backend |
| History screen (search, load more, archived, restore) | P:screens/sessions-screen.tsx | Thiếu: archived sessions are hidden (W:lib/controller.js session list) | yes: `session.list includeArchived` with `limit`/`cursor`/`query` (`session.list.page`, t-7679.6), `session.archive archived:false` | P0 | **Đã làm**: date sections, search, Archived and Needs input badges, Refresh; an archived session opens with Paseo's "archived" callout and Unarchive in place of the composer (W:app/History.tsx, lib/history.js, controller loadHistory/restoreSession). Since t-7679.6, as Paseo's `useAgentHistory`: pages of 200 newest first with **Load more** (Loading... while it reads) under the list, and the search (200 ms debounce) asked of the host, which matches every word in the title or id; Refresh and a reconnect read the first page again. A host without `session.list.page` lists everything and the screen filters, as before. Paseo's "Too many matches" hint has no counterpart: ALP's search pages like the list (W:controller loadMoreHistory) |
| Workspace header menu (new agent/terminal, copy path/branch, import) | P:screens/workspace/workspace-header-menu.tsx | Một phần: Rename, Copy ID, Archive | partial | P1 | Một phần |
| Tab row and + New tab | P:workspace-desktop-tabs-row.tsx | Có | yes | none | Có; ⌘T opens the + menu |
| Tab context menu, drag order, kept across reload | P:workspace-tab-menu.ts, drag-reorder/, workspace-tabs/model.ts, stores/workspace-layout-store.ts | Thiếu | client only | P1 | **Đã làm** (t-7679.5): right click (or Shift+F10 / the Menu key) on a tab opens Paseo's menu with its labels and order: Copy agent id (with the id's first 7 characters) and Rename (the session's tab: renames the session) on agent tabs, Copy task id on task tabs (ALP), then Close to the left / Close to the right / Close other tabs (disabled at the ends, as Paseo) and Close; closing the session's tab closes the session view as its × does (so the close actions of one of the session's other agent tabs leave the session's tab open), and the draft stays while its session starts; after a close the tab beside the closed active one comes forward, or the tab the menu was opened on. Since t-15b0.17 (#121 G2) an agent tab also has Paseo's Copy resume command (first) and Reload agent (above Close, with a tooltip saying what stays): the command is the host's `alp attach <id>` (session.resumeCommand, built by alpd, copied to the clipboard only, never run; never a native `codex resume`/`claude --resume`, which would continue outside ALP), and Reload agent is session.reload for the open main agent, disabled with a reason for a team member, a closed or busy session, a runtime the host cannot reload, or a token without session.write or outside its modes; each shows a notice (W:app/Workspace.tsx, lib/conversation.js agentControlsGate, lib/controller.js reloadAgent/copyResumeCommand; e2e/reload.spec.js). Tabs drag into another order with the pointer (5 px before a press becomes a drag, as Paseo's activation distance; the row shows the order live). Each workspace's tabs (scoped by gateway and path) are kept in localStorage `alp-web:layout` v1: the open session (reopened after a reconnect once the list shows it is still there), its other agent tabs, task and panel tabs, the order and the active tab; ids only, never the token; at most 20 workspaces Since t-7679.9 a tab picked while the saved session is still opening stays in front once it opens, an agent's tab too (it was task and panel tabs only) (W:app/tabs.tsx, Workspace.tsx, components/ui/menu.tsx ContextMenu, lib/layout.js) |
| Split panes | P:components/split-container.tsx, stores/workspace-layout-actions.ts, utils/split-navigation.ts, components/split-drop-zone.tsx | Thiếu | client only | P1 | **Đã làm** (t-7679.9): Paseo's split tree: groups in a row or a column with a share per child, panes as leaves, each pane with its own tab row and its tab in front; one pane has focus (a press or keyboard focus in it), and the tab actions (new tab, close, next/previous, ⌥⇧1-9, the tab menu's close ranges) act on its row. Split pane right / down from the pane's ⋯ menu (Paseo's `workspace-split-pane-menu`), the command center or ⌘\\ / ⇧⌘\\ open a New tab in a new pane beside the focused one, as Paseo: its launcher (Agent, Terminal, Diff, then ALP's Tasks and Agents, as the + menu) turns into what is picked; New tabs are not kept across a reload (Paseo's ephemeral tabs), and a pane left with nothing kept comes back with a New tab, as Paseo's restoreEmptyPanesInNode. ALP has one New session draft at a time, so Agent brings an open draft forward where it is; same-direction splits halve the target's share, other directions nest, at most Paseo's depth 5. Drag a tab onto another pane's tab row to move it there, onto a pane's body for Paseo's drop zones (edges 15%: split that pane with the tab; center 40%: move it in; a preview shows the half it would take). A pane whose last tab closes goes, and its neighbour (Paseo's nearest sibling) gets the focus; the last pane stays. Close pane (⇧⌘W, command center) closes its tabs. Focus pane left/right/up/down (⇧⌘arrows outside text fields) and Move tab left/right/up/down (⌥⇧⌘arrows) by Paseo's geometry. A 1 px handle between panes resizes them (shown while dragging, kept on release) (no pane under 10% of its group, Paseo's MIN_SPLIT_SIZE), also with the arrow keys (Shift for 10%), Home and End. Maximize / Restore pane while there are several. Kept per workspace in `alp-web:layout` (the tree, each tab's pane, each pane's tab in front, the focused pane; checked when read, at most 16 panes). Below 768 px only the focused pane shows, with one row of every pane's tabs (picking one gives its pane the focus), and the split actions are hidden (Paseo has no splits on compact screens and lists all tabs there). The pane keys are Paseo's Mac-only bindings; ⇧⌘W is usually kept by the browser to close the window. Left out: focus mode (ALP has none). t-7679.17: a reload with the focus on a pane holding only a New tab keeps the focus there; the saved session reopening in another pane used to take it. (W:lib/panes.js, app/tabs.tsx, Workspace.tsx SplitView, pane.tsx, App.tsx) |
| Explorer dock with tabs | P:screens/workspace/explorer-sidebar.tsx | Có | Files: yes (`workspace.files.list`, files.read, t-7679.18); Changes: yes, read only (`workspace.git.status`/`diff`, issue #121 G1, §3.1.1) | none | Có |
| Resizable sidebar and dock | P:sidebar-resize-handle.tsx, resize-handle.tsx, split-container.tsx | Thiếu (fixed 320px) | client only | P1 | **Đã làm** (t-7679.5): a 10 px handle over each inner edge, col-resize cursor, a highlight on hover and while dragging; Paseo's bounds: sidebar 320 (200–600, never past the window width minus 400), explorer 320 (240–720, never past its container, the window less the docked sidebar, minus 400, so the center keeps 400 px); kept in `alp-web:layout` (one explorer width for all workspaces, where Paseo keeps one per workspace). ALP adds the arrow keys (Shift for 48 px), Home and End on the focused handle (a `separator` with its value) (W:app/ResizeHandle.tsx) |
| Keyboard shortcuts (new agent, toggle panels, navigate, archive) and their help dialog | P:keyboard/actions.ts, keyboard-shortcuts-dialog.tsx | Thiếu: only Esc, plus Cmd+L, Escape and Shift+Tab in chat | client only | P0 | **Đã làm**: the web build's bindings, Mod = Cmd on a Mac, Ctrl elsewhere: ⌘N new session, ⌘⇧⌫ archive, ⌥1-9 / ⌥[ ⌥] sessions, ⌘T new tab menu, ⌘⇧A agent, ⌘⇧G Changes, ⌘⇧E Files, ⌘⇧T terminal, ⌥⇧W close tab, ⌥⇧1-9 / ⌥⇧[ ⌥⇧] tabs, ⌘B / ⌘E (or Ctrl+Backquote) / ⌘. sidebars, ⌘, settings, ⌘K the command center (t-7679.5; it was the sidebar's search before), ? the searchable Shortcuts dialog (W:lib/shortcuts.js, app/Shortcuts.tsx, App.tsx). Left out, as ALP has no such feature: open project, pin, browser tabs, focus mode, theme, voice. Since t-7679.10 ⌘P (Ctrl+P elsewhere) **Search files**, in Paseo's General section, opens the command center in its Files scope (Paseo's `command-center.files`); inside the command center it moves to that scope instead of the browser's print. Since t-7679.9 Paseo's pane keys, on a Mac only as Paseo binds them: ⌘\\ / ⇧⌘\\ split right/down, ⇧⌘←→↑↓ focus a pane (outside text fields), ⌥⇧⌘←→↑↓ move the tab, ⇧⌘W close the pane; ⌘L and Escape go to the focused pane's composer. Shortcuts wait while a dialog is open. ⌥1-9 and ⌥[ ⌥] follow the full session list even while the sidebar search filters it. No rebinding |
| Command center (Cmd+K) | P:command-center/ | Thiếu | partial (sessions and tasks: yes; files: no) | P1 | **Đã làm** (t-7679.5): ⌘K (Ctrl+K) toggles it: a 640 px panel near the top, sections Workspace actions, Actions, then Sessions; with no query only the always-shown actions (New session; History, Settings, Keyboard shortcuts) and the first five sessions (waiting, then running, then most recent); a query matches every word with Paseo's tiers (exact, whole word, prefix, word start, substring, letters in order; hidden keywords rank last) and puts the best section first. Actions ALP has: New session, New terminal, Open Changes/Files/Diff/Tasks/Agents, Previous/Next tab, Close current tab, Close to the left/right, Close other tabs, Rename/Copy ID/Archive session, Toggle explorer, Toggle left sidebar, Search sessions in the sidebar; shortcut hints beside them. Arrows move and wrap, Enter runs, Escape/⌘K/a click outside close, focus goes back. No files scope or workspaces section (no backend; one project per token) t-7679.9 adds ALP's own section after Actions, always shown, as ALP's alp-provider plugin adds it to paseo-web's command center (integrations/paseo/index.client.tsx): **Open ALP tasks** (the Tasks tab, in place of the former "Open Tasks") and **Open ALP tasks full screen** (the plugin's Tasks screen: the board in place of the workspace, the sidebar staying as on paseo-web, the whole screen on a phone; a picked task beside the list from 820 px, in its place below with a back arrow; Close or Escape back to the workspace; since t-7679.17 with the plugin's List/Board/Epics views, filters and search); and Paseo's pane commands (Split pane right/down, Focus pane left/right/up/down, Move tab left/right/up/down, Close pane) where the center can split. **Pin to top** is left out: Paseo pins a *workspace* through the host (`workspacePinning`, `pinnedAt` on the workspace descriptor); ALP has no workspace registry or pin field (one workspace per token, `workspace.*` is §14 work), and a pin kept only in this browser would disagree with every other client (W:app/CommandCenter.tsx, lib/command-center.js, App.tsx CommandCenterHost, TasksScreen.tsx). **t-7679.10**: Paseo's **Workspaces** section (between the actions and Sessions, Paseo's band/rank order): one row per workspace the access token grants (`principal.workspaces`), title the folder's name, subtitle the full path, sorted by name as Paseo's compareWorkspacesByTitle (numbers in order, case aside), five with an empty query, ranked by the same matcher on name and path with a query (Paseo's filterAndRankWorkspaces; no change-request numbers, ALP has none); choosing one switches to it (`selectWorkspace`); the open one is listed and marked "Current" (Paseo lists every non-archived workspace). **Files**: where the host has `workspace.files`, a non-empty query adds a Files section after Sessions, and ⌘P opens the Files scope (a "Files" chip with an x, placeholder "Search files...", Backspace in the empty field drops the scope, a spinner labelled "Searching files..." while the host answers, its error under the field); requests are `workspace.files.search { projectRoot: the workspace, query, limit: 100 }` (Paseo's FILE_SEARCH_LIMIT), 100 ms after the last keystroke and at once for an empty query (FILE_SEARCH_DEBOUNCE_MS), an older answer dropped, the last answer kept on screen while the next loads (W:lib/file-search.js). A row is the file's name over its directory (Paseo's describeWorkspaceFilePath); the host ranks them. Since t-7679.18 choosing a file opens it in a read-only file tab, as Paseo, where the host has `workspace.files.read` and the token `files.read`; otherwise (files.read is never a default grant) it copies the relative path to the clipboard with the notice "Copied <path> (this access token cannot read files)" or "(this host does not offer file reading)". A token without `project.read` is told "This access token cannot list files (needs project.read)." (the gateway's 1003); a host without `workspace.files` shows no Files section, and ⌘P's scope says the host does not offer file search. The placeholder is Paseo's "Search commands, files, workspaces, and agents..." where files are searchable, else "Search commands, workspaces, sessions and agents..." |
| Favicon status | P:hooks/use-favicon-status | Thiếu | yes | P1 | **Đã làm** (t-7679.5): the ALP favicon with patch 0004's corner badge, blue while a session of the workspace runs, green while one waits for an answer (running first, as Paseo); the window title is the open session's name, else the workspace's (W:app/attention.tsx, lib/attention.js, public/favicon-*.svg). Since t-7679.10 a turn that finished or failed unseen counts as attention too, as Paseo's requiresAttention (running > attention > none) |
| Browser notifications when a session needs input | P:utils/os-notifications.ts, contexts/session-context.tsx | Thiếu | yes (`question.watch` or `question.list`, the open tree's questions) | P1 | **Đã làm** (t-7679.5): "Agent needs attention" with the session's name and the question (markdown stripped, 220 characters) when a session starts waiting, unless the window is visible, focused and on that session; a click focuses the window and opens the session. Permission is asked only from Settings › General › This browser › Notifications › Enable (a click), where Paseo's web build asks on its first notification; questions already waiting when the workspace opens do not notify. Since t-7679.10 a root's turn that ends unseen notifies as Paseo's agent-attention-notification: "Agent finished" / "<session>: Finished working." and "Agent needs attention" / "<session>: Encountered an error." (the turn's error message, markdown stripped, when the host gives one), tagged per root and reason (`alp-finished-<id>`, `alp-error-<id>`), with the same click-to-open; Paseo's finished body is the last assistant message, which ALP does not have for a session that is not open, so it keeps Paseo's fallback |
| Mobile gestures | P:mobile-panels/gestures.ts | Một phần (drawers, no swipe) | client only | P2 | Một phần |
| Board (ALP pins) | none in Paseo | Thiếu | yes: `board.list` | P1 | Thiếu |

### 3.2 Workspace features

The column **apps/web** gives the state before t-7679.3; **Now** gives it after (— : unchanged).

| Feature | paseo-web | apps/web | Backend | Priority | Now |
|---|---|---|---|---|---|
| New workspace/agent screen with a first prompt, isolation and ref | P:screens/new-workspace-screen.tsx; inside a workspace P:composer/draft/workspace-tab.tsx (the "New Agent" tab) | Một phần: NewSessionDialog: title, team, mode, model (W:Dialogs.tsx) | partial: first prompt and thinking are allowed spec fields; worktree/ref no | P0 | **Đã làm**: Paseo's draft agent tab: a "New session" tab in the tab row (⌘N, sidebar, + › Agent, the empty screen), open area above, composer below with the agent controls; the first message starts the session (`session.create`, then `session.prompt` after attach through the composer's path: receipts, Retry, never resent by itself) and names it when no title is given; the start button also works with an empty box; one start at a time (a second Enter or a double click does nothing; the controller refuses a second `session.create` while one is in flight); Start waits while the preview is still checking the current team/model (the box stays editable); the tab stays in front until the session is ready and cannot be closed meanwhile. A refused create, or one whose answer was lost (timeout, drop: the session may exist and stays selected; the first message is never sent), is shown in the draft with the text restored; if the draft was left meanwhile, the failure comes as a notice and the whole unsent message is put back in the next New session box of the same workspace (kept in memory only, forgotten on disconnect). The choices are remembered as Paseo's form preferences (team, model, mode, thinking per model) (W:app/NewSession.tsx, lib/new-session.js, tabs.tsx, controller.createSession). ALP keeps an optional Title field (Paseo generates titles on the host, alpd does not). No isolation/ref choice here: a worktree is made from the sidebar row (`workspace.worktree.create`, #121 F) and a session then starts in it |
| Team/model picker with effort (patches 0018, 0019) | P:components/model-browser.tsx, combined-model-selector.tsx, agent-controls thinking | Một phần: native selects, no thinking | yes: `team.list`, `library.models` (efforts, effort) | P0 | **Đã làm**: composer toolbar menus Team, Model (main agent's, "Team default" first), Thinking (the effective model's efforts with Paseo's labels, "Default (usual)" first; hidden when the model takes none), Permissions; after a choice the box has focus again, as Paseo's onDropdownClose. paseo-web's patched picker lists teams as "models" (Select team) and shows no thinking for them; apps/web keeps team and model apart. No search field in the menus (lists are short). Since t-15b0.16 (#121 D) the open session's toolbar has the same Team, Model and Thinking menus for the running main agent (`session.configure { model | thinking | team, requestId, ifGeneration }`, capability `session.configure.live`): one change at a time, at the idle barrier, with a fresh request id (the same one again only after a lost answer) and the history generation the view holds; main restarts on the same conversation and the next turn names the new model and effort (e2e/configure.spec.js checks the fake Codex's `thread/resume` and `turn/start`). Models are the session's runtime's only; other runtimes are a disabled row "Other runtimes: start a new session" and never sent (a session keeps its runtime; a runtime_mismatch refusal offers **New session**). Thinking lists the current model's efforts (read-only when it takes none). The labels follow what the host answers, never the menu choice; a refusal (busy tree, stale generation: the view reloads, native_refused, …) changes nothing and shows the gateway's fixed reason. **Deviations**: no "Team default" model row on a live session (the host keeps the model it runs); no preview card before a model or thinking change (the configure answer says what runs) |
| Session preview (which team will run) | P:provider-selection/ | Thiếu | yes: `session.preview` | P1 | **Đã làm**: "This session will run" card: team, agent, runtime, model, thinking, permissions; refreshed 250 ms after a choice changes, older answers dropped, last answer dimmed while checking; errors shown in the card with Retry; without `session.read` it says why. Thinking is checked only against a preview that answered the current team and model. The team is always sent explicitly (see §4: preview and create disagree on the default): the one chosen, else the one the current preview named, else (preview unavailable) the first `team.list` entry; when no team can be told, Start waits instead of creating without one, and the screen says why (no `team` capability, no `project.read`, `team.list` failed, the preview failed or is blocked by a missing `session.read`) and what unblocks it (Retry, which also asks `team.list` again after it failed, or a token with the missing permission). `session.create` goes without a team only when `team.list` answered that the host has none |
| Welcome tiles (add project, import, providers) | P:screens/open-project-screen.tsx | Thiếu (Add project is in the sidebar) | add project: yes (`project.register`); import, providers: no | P2 | — |
| Add project with the host folder browser (patch 0011) | P:components/add-project-flow.tsx | Có, by design different: sidebar **Add project** registers one of the token's already granted directories (a select, no folder browser) | yes: `project.register` (`workspace.write`, only an existing exact pregranted canonical directory, §16); browsing or creating host directories stays proposed (`host.directories.suggest`, §14) | P2 | **Đã làm** (#121 E, PR #182, e2e/registry.spec.js). A remote token never browses the host or widens its own grant: the owner adds the directory to the credential first |
| Files, Changes, Diff panels | P:panels/files-panel.tsx, panels/changes, diff-panel.tsx | Files: Có (t-7679.18); Changes, Diff: placeholder | Files: `workspace.files.list/read` (files.read); Changes/Diff: `workspace.git.status` (project.read) and `workspace.git.diff` (project.read + files.read), protocol §12.5 | P1 | **Files đã làm** (t-7679.18), see §3.1. **Changes và Diff đã làm, chỉ đọc** (issue #121 G1), see §3.1.1 |
| Git actions, branch switcher, PR panel, review comments | P:git/, components/branch-switcher.tsx, review/ | Thiếu | no | P2 | — |
| Terminal | P:panels/terminal-panel.tsx, terminal/ | Có (W:app/TerminalPanel.tsx, lib/terminal.js) | yes: capability `terminal`, `terminal.*` §12.10 (#121 H); gateway permission `terminal.exec`, never a default; the host owner's `alp terminal allow` | P2 | **Đã làm** (t-15b0.5, #121 H): the Terminal tab (center + menu, ⌘⇧T, command center New terminal) runs a real shell on the daemon host, drawn by xterm.js 6.0.0 with addon-fit 0.11.0 (a lazy chunk). It says, in full the first time in a page session and in a header line always, that the shell runs on the daemon host as the account that runs alpd and the workspace is not a sandbox. Opening the tab creates a terminal in the workspace's registry workspace and attaches; keystrokes go batched and in order (one `terminal.input` at a time, at most `maxInputBytes`); the size goes debounced (`terminal.resize`); closing the tab sends `terminal.close`. A reload or a dropped socket attaches again (the page keeps the terminal id in sessionStorage; `after` = last seq seen), lost output shows as `[output lost: …]`, `exit` shows "Process exited (code N / reason)" with input off and a New terminal button, `detached` replaced shows "Opened in another client" with Reattach, slow_consumer reattaches by itself. Refusals: "The host has not allowed remote terminals (its owner runs: alp terminal allow --yes)" and "Your access token cannot open terminals (it needs terminal.exec)". **t-d71b**: each workspace has nested shell tabs with stable page-session identities and selection; adding/closing a shell leaves siblings running, while closing the parent Terminal panel ends the whole group. Font family, size (10–24) and light/dark terminal theme use the existing app preferences. Official search 0.16.0 and web-links 0.12.0 addons provide buffer search (Enter/Shift+Enter or next/previous) and HTTP(S) links opened with opener isolation. **Deviations**: not in the explorer dock (a terminal belongs to the center tab that ends it); no copy-on-select addon; Disconnect ends the page's terminals, a reload or closed tab leaves them to the host's reattach time (60 s) |
| Schedules | P:screens/schedules-screen.tsx | Thiếu | no | P2 | — |
| Project settings, setup panel | P:screens/project-settings-screen.tsx, panels/setup-panel.tsx | Thiếu | no | P2 | — |
| Agents panel (the tree) | P:panels/agent-tracks.tsx | Có | yes | none | — |
| Subagent actions (archive finished, detach) | P:subagents/ | Thiếu | partial | P1 | — |
| Tasks panel and detail (ALP) | ALP plugin | Có | yes | none | — |
| Tasks board views: List / Board / Epics, filters Open / Ready / Closed / All with counts, search (ALP) | ALP plugin: integrations/paseo/client/tasks-panel.tsx (TaskBoard, filterTasks, stateOf), shared/tasks.ts (boardSections) | Thiếu | yes (`task.list`, `task.gate.resolve`) | P3 | **Đã làm** (t-7679.17): the Tasks tab and the full-screen Tasks screen show the plugin's toolbar: Tasks with the open count, the List / Board / Epics switch (labels from 340 px, icons below), Refresh; the filters Open / Ready / Closed / All with their counts (Ready: `ready` and not closed) and the search "Filter by id, title, label, agent" (every word, in id, title, type, assignee or labels). **List**: the plugin's groups in its order (Waiting for your approval, In review, In progress, Ready, Blocked or waiting, Epics, Closed, newest close first), each folding, a row with the plugin's state dot, then id, priority, type, status, @assignee, progress, `after …`, `waits on …`, `in <parent>`, #labels and age; a human gate's Approve under its row (`task.gate.resolve`, as the detail's). **Board**: a 248 px column per state (Needs approval, Blocked, Ready, In progress, In review, Closed; Blocked, Ready and In progress always, "Nothing here" when empty), epics left out, cards with priority badge, id, age, title, @assignee, `after …`, #labels, a coloured left edge for Blocked / Ready / approval; columns scroll sideways in the narrow dock. **Epics**: every shown epic (or task with progress) with its progress bar and done/total (the host's `progress`, else its closed children), its tasks as a folding tree (open epics unfolded), the children from the whole list so a filter does not hide them. On the Tasks screen the board takes the whole width until a task is picked, then two fifths beside the detail from 820 px (the plugin's 2:3 split), in place of it below. **Deviations**: a task shows once in the List, in the first group that applies (the plugin's boardSections can list one twice, e.g. approval and in progress); Closed lists every closed task (the plugin's 20); Board columns are sorted by priority then id (the plugin keeps task.list's order); the new-task form stays open under the filters (apps/web's), where the plugin opens its composer from a + button; the view and filter are not kept across a reload (neither are the plugin's) (W:app/TaskBoard.tsx, lib/task-board.js, TasksScreen.tsx) |
| Run log of a session | none in Paseo | Thiếu | yes: `session.log` | P1 | — |
| Usage | P:usage/ | Thiếu | GW denies `daemon.usage` | P2 | — |

### 3.3 Settings

| Section | paseo-web | apps/web | Backend | Priority | Now |
|---|---|---|---|---|---|
| Layout: the App group, then the Host group | P:screens/settings-screen.tsx | Có (W:Settings.tsx) | yes | none | — |
| Settings kept across reload | Paseo stores them (P:hooks/use-settings, `@paseo:app-settings`; create-agent-preferences) | Thiếu | client only | P0 | **Đã làm**: one versioned localStorage key `alp-web:preferences` (v1): Default send, theme, New session choices; read field by field (garbage or another version gives the defaults and is overwritten); written with known fields only, so the access token never reaches storage (Connections still says memory only); other tabs follow through the storage event; General › This browser › Reset (W:lib/preferences.js, controller setSendBehavior/setTheme/resetPreferences) |
| General: language, Default send | P:screens/settings/general | Một phần: Default send in memory only, language disabled | client only | P1 | Một phần: Default send saved; language still English only (no i18n) |
| Appearance (themes, fonts) | P:screens/settings/appearance | Placeholder | client only | P1 | Một phần: Theme System/Light/Dark (Paseo's light palette as CSS tokens, System follows prefers-color-scheme live); Layout › Content width (Default 820 px, Wide 1100 px, Full width) as `--content-width` on the chat, history, task and file columns (W:lib/theme.ts applyContentWidth); left out: Paseo's variant themes (zinc, midnight…), fonts, text sizes and syntax theme — each needs its own tokens/typography pass across the app |
| Chat settings (detail level, outline, tool detail) | P:screens/settings/chat/chat-section.tsx | Unavailable | client only | P1 | **Một phần**: Tool call details Collapsed/Expanded (`toolCalls` preference; new rows start open, a click still closes one); reasoning and the outline keep Paseo's defaults |
| Terminal display (font, size, colors) | P:screens/settings/terminal | Only in the Terminal panel | client only | P1 | **Đã làm**: App › Terminal sets the same `terminal` preference as the panel (font, 10–24 px, dark/light) and says where the shell runs |
| Diagnostics | P:components/app-diagnostic-sheet.tsx | Unavailable | partial | P1 | **Một phần**: what the browser sees (app, browser, connection, capabilities, the token's grants), with Copy report; built from named fields only, so no token, prompt or file reaches it (W:lib/diagnostics.js). Host details stay `alp doctor` |
| About | P:settings-screen.tsx AboutSection; patch 0007 | Có | yes | none | — |
| Host Overview: name, color, restart, remove | P:screens/settings/host-page.tsx | Một phần | partial | P1 | — |
| Machine name as the host label (patch 0017) | patch 0017 | Thiếu | yes: `hostname` in hello (alpd `os.hostname()`, gateway `hostLabel`) | P2 | **Đã làm** (t-7679.14): the Settings sidebar's host row, About's connected host, Host › Overview's Machine row and the sidebar host title use it; the gateway address when the host sends none |
| Library screens: Templates, Agents, Skills, Hooks, MCP (patches 0015, 0016) | patches 0015/0016 | Một phần: names only | `library.get` read only (project.read, redacted at the gateway, docs/alp/remote-gateway.md §5.7); `library.write` allows project-only instruction CRUD (#118) | P1 | **Một phần** (t-7679.14): a row opens the entry read only (W:app/Settings.tsx `LibraryEntryView`, lib/library.js): source, users, the library's skills, AGENT.md/SKILL.md/HOUSE_RULES.md as text and configuration as JSON, every value that can hold a secret shown as ‹hidden on the host›. Done in #118: project JSON instruction editor for safe agents/skills with save, duplicate, rename and delete behind library.write; inherited/executable entries remain read-only |
| Providers: runtimes, default switch, custom ACP (patches 0012-0014) | P:screens/settings/providers-section.tsx | Một phần: names | no: `provider.*` §14 | P1 | — |
| Projects: register a granted directory | host-page.tsx | Only in the sidebar (Add project) | yes: `project.register` (workspace.write) | P1 | **Đã làm**: Host › Projects shows which granted directories are registered and registers one; granting stays `alp-gateway credential create --workspace` |
| Workspaces: shared names and pins | host-page.tsx | Unavailable | yes: `workspace.list`, `workspace.update` title/pinned (workspace.write) | P1 | **Đã làm**: Host › Workspaces lists the registry (pins first, worktree badge, branch), renames (blank goes back to the directory name), pins and opens; read only without workspace.write. Archive, labels and placement stay owner-only |
| Terminals | host-page.tsx | Unavailable (names `alp terminal allow --yes` / `deny` / `status` and `terminal.exec`) | read only: capability `terminal`, the token's `terminal.exec` (the switch is host-only by design, §12.10) | P2 | **Đã làm** (status): Host › Terminals shows whether the host allows terminals, whether the token may open one, and whether this workspace can; the switch itself stays on the host |
| Plugins, Usage, Pair device, Metadata | host-page.tsx and others | Unavailable | no | P2 | — |

### 3.4 Other areas

| Feature | paseo-web | apps/web | Backend | Priority | Now |
|---|---|---|---|---|---|
| Connect: alp web's token (patch 0001); add host; SSH | P:components/add-host-modal.tsx | Có, by design different: gateway URL and a pasted token | yes | none | — |
| Pairing, saved hosts | P:components/pair-link-modal.tsx | Thiếu (by design) | no | P2 | — |
| Toasts: variants, stacking, in-development once (patch 0006) | P:components/toast-host.tsx | Một phần: one notice at a time | client only | P1 | — |
| i18n (9 locales) | P:i18n/ | Thiếu (English only) | client only | P1 | — |
| Light theme | P:appearance/ | Thiếu | client only | P1 | **Đã làm** (see §3.3 Appearance; W:styles.css `:root[data-theme="light"]`, lib/theme.ts) |
| Browser notifications when an agent needs input | P:push-notifications/ | Thiếu | partial (`question.list`) | P1 | — |
| Error boundary | P:components/root-error-boundary.tsx | Thiếu | client only | P1 | — |
| PWA manifest, help menu, splash | patches 0002/0004, sidebar-help-menu.tsx | Thiếu / Một phần | client only | P2 | — |

## 3.1 Reading workspace files (t-7679.18)

User decision (2026-10-17): files are read remotely through the gateway with the `files.read`
permission, never granted by default (`alp-gateway credential create --permission files.read`);
text files only, at most 1 MB; `.env*`, key and credential files, `.git` and `.alp` always blocked;
`.gitignore`'d files hidden by default. `workspace.files.search` stays on `project.read`.

- **File tab** (P:file-pane/pane.tsx): a tab per file (`file:<relative path>`, kept across reloads
  like task tabs; a blocked or malformed saved path is dropped), label the file's name, title its
  path, a FileText icon, the tab menu's **Copy path**. The view: the path, Copy path, Refresh, size
  and line count; the text in monospace with a line-number gutter, scrolled to (and marking) the
  line a link asked for; Markdown opens on a Preview (RichText) with a Source toggle, on its source
  when a line is asked (Markdown over 200 KB shows its source only: the preview parses on the main
  thread). Paseo's "Binary preview unavailable" and "This file is too large to
  display"; an ignored file says so with **Show anyway** (read again with `includeIgnored`); other
  failures with Retry (W:app/FileView.tsx, lib/errors.js FILE_MESSAGES).
- **Files panel** (P:components/file-explorer-pane.tsx): the tree, each folder listed when opened
  (`workspace.files.list`), directories first, the sort button cycling name, modified, size
  (Paseo's SORT_OPTIONS), Refresh, and one **Show hidden files** toggle that shows dot-names and also
  lists what .gitignore hides. A host without the capability: "This host does not offer file
  reading. Update ALP on the host."; a token without files.read: "This access token cannot read
  files (needs files.read)." and how to get one (W:app/FilesPanel.tsx, lib/file-tree.js).
- **Controller** (W:lib/controller.js `listWorkspaceFiles`, `readWorkspaceFile`): the same guard order
  as the file search (workspace, capability, grant), blocked or malformed paths refused without a
  request, listings kept to clean relative entries of that directory (no absolute path, `..` or
  blocked path, at most 1000).
- **Command center** and **file links in chat**: see the rows above.

Deviations from Paseo: read-only (no edit, create, rename, delete or download); no image or HTML
preview; no syntax highlighting (no highlighter in this app, and none added for this); secrets,
`.git`, `.alp` and links are never shown; ignored files hidden by default; no live watch (a file
reads again when its tab comes back to the front, or with Refresh); no find in the file beyond the
browser's. Paseo's read-only source view has no line numbers either: the gutter is ALP's, not a
parity claim.

### 3.1.1 Changes and Diff, read only (issue #121 G1)

P:panels/diff-panel.tsx, git/diff-pane.tsx, components/diff-stat.tsx at `b63a325`; W:app/GitPanels.tsx,
lib/git.js, lib/controller.js `gitStatus`/`gitDiff`. The host's `workspace.git` (protocol §12.5) by
the open workspace's registry id: the workspace must be registered on the host.

- **What each token sees.** No capability: "This host does not offer Git changes. Update ALP on the
  host." Without `project.read`: "This access token cannot read Git status (needs project.read)."
  An unregistered workspace says the host owner can add it as a project. With `project.read` only:
  the branch header and the status list (change letter, path, old path of a rename, staged/unstaged)
  with "This access token cannot read file contents, so diffs are hidden (needs files.read)." With
  `files.read` too: the diff. Each unavailable state keeps the testid `panel-unavailable-<kind>`
  with `data-reason`.
- **Changes** (Paseo's changes tree): toolbar with the diff mode (Paseo's Uncommitted and
  Committed — `base`, the branch against its base — plus the host's Staged and Unstaged), the
  total +/-, Hide whitespace, Refresh; the branch header (branch, upstream ↑/↓, `→ base` in
  Committed, "Read only"); one row per file (letter, name, folder, +/-, or Binary file / Diff too
  large to display / withheld / Symbolic link / Submodule), a row opens its hunks inline (Paseo's
  inline diff), and **Open in Diff** sends that file to the Diff panel. Empty: Paseo's "No changes
  to display" with "See committed/uncommitted changes". Not a repository: Paseo's "Not a git
  repository".
- **Diff** (Paseo's diff document): the same comparison with every file open, or only the file
  Changes sent ("All files" goes back).
- **Hunks**: a unified diff with old and new line numbers, a hunk header with its context, "no
  newline at end" marked; at most LINE_LIMIT (400) rows until "Show more lines", as tool call diffs.
- **Pages**: "Load more" with the host's `nextCursor`; when the checkout changed (`stale_snapshot`)
  or the cursor is gone (`invalid_cursor`), the list loads again from the start with a notice.
  Files the host withholds (secrets, keys, `.git`, `.alp`) are counted: "N changed files are not
  shown remotely".
- **Refresh**: the button, and once when the page comes back (window focus, tab visible) more than
  15 s after the last load. No polling.

Deviations from Paseo: no commit, push, pull, merge, create PR, branch switcher, discard/revert, add
to chat or forge (PR status, checks) — Git stays read only remotely and those controls are not shown
("Read only" says so); no split (side-by-side) layout, wrap toggle or folder tree (a flat list with
folder names); no syntax highlighting; no commits section; no jump-to-file; no per-file diff tab
target (one Diff panel, focused by Changes); the mode, whitespace and focus are kept for the page
only (Paseo keeps changes preferences); no live checkout watch (Paseo's `checkoutRefresh`).

## 4. Not in apps/web: protocol, gateway or daemon work

- **Git and terminal:** Git is read only (`workspace.git.status`/`diff`, §12.5, issue #121 G1, §3.1.1):
  commit, push, pull, merge and branch switching are not in the protocol. Terminals are §12.10 (#121 H): one per workspace tab, no
  shell choice, command, environment or cwd from the client, and no RPC changes the host's switch. Files are read-only (`workspace.files.search`, `.list`, `.read`, t-7679.18):
  writing, creating, renaming, deleting and downloading files are not in the protocol.
- **Workspace and project registry:** done in #121 E/F (protocol §16: `project.list/register/remove`, `workspace.list/get/update`, `workspace.worktree.options/create/remove`). Left: browsing or creating host directories (§14 `host.directories.suggest`), labels and placement (owner-only `registry.owner`), worktrees on Windows.
- **Providers:** `provider.*` and `library.test` (§14).
- **Library edits:** project-only pure-data agents/skills support save/delete/duplicate/rename
  with opt-in `library.write` and daemon capability `library.project.write`; executable configuration,
  inherited entries and host `library.skills.set` stay denied.
  `library.get` is read only and redacted (t-7679.14).
- **Usage, status, language:** the gateway denies `daemon.usage` and `daemon.status`, and also
  `settings.language.set`.
- **Chat:**
  - attachments other than images and files (GitHub items); files: done in t-15b0.15 (alpd's attachment store, §12.6);
  - token usage (context meter): done in t-7679.12;
  - fork and rewind: done in t-15b0.4 (conversation only; files are never restored);
  - paging back through history: done in t-15b0.2 (`session.history`, §8.7);
  - richer tool-call details: done in t-7679.13 (typed `detail` in `tool_call` items, rendered per type);
  - changing the team or model of a running session: done in t-15b0.16 (§12.9).
- **New session default team (found in t-7679.3):** `session.preview` without `spec.workflow` answers
  for the default team (`settings.workflow.mode`, else Phở), but `session.create` without it runs the
  custom graph (no team, Phở's built-in main model rather than the project's team profile). apps/web
  therefore always sends the team the preview named. The two should agree in alpd.
- **Session title:** alpd does not name a session from its first prompt as Paseo's host does; apps/web
  renames it from the message's first line.

## 5. Screenshots

Captured by `apps/web/scripts/compare-paseo.mjs`, which runs both apps on one disposable host
(alpd with the fake Codex, alp-gateway for apps/web, ALP's Paseo bridge for paseo-web). Window
size: 1440×900, phone 412×915. The images are in `docs/screenshots/`.

| Scene | apps/web | paseo-web |
|---|---|---|
| A question waiting | chat-question-apps-web.png | chat-question-paseo-web.png |
| Shell tool call open | chat-tool-open-apps-web.png | chat-tool-open-paseo-web.png |
| Running turn with a queued message | chat-running-apps-web.png | chat-running-paseo-web.png |
| Mode menu | chat-mode-menu-apps-web.png | chat-mode-menu-paseo-web.png |
| After the answer | chat-answered-apps-web.png | chat-paseo-web.png |
| Phone | chat-mobile-apps-web.png | chat-mobile-start-paseo-web.png (start page) |
| Attention on another session's row, session title on the tab (t-7679.2) | workspace-attention-apps-web.png | workspace-attention-paseo-web.png |
| Shortcuts dialog (Shift+?) | workspace-shortcuts-apps-web.png | workspace-shortcuts-paseo-web.png |
| History with an archived session | workspace-history-apps-web.png | workspace-history-paseo-web.png |
| Archived session opened from History | workspace-archived-apps-web.png | workspace-archived-paseo-web.png |

| New session tab (composer, controls, preview) (t-7679.3) | new-session-apps-web.png | new-session-paseo-web.png (draft "New Agent" tab, empty) |
| Model picker open | new-session-model-menu-apps-web.png | new-session-model-menu-paseo-web.png (its "Select team" picker) |
| Thinking menu open | new-session-thinking-menu-apps-web.png | none: paseo-web offers no thinking for ALP teams |
| Preview after choosing a model and High thinking | new-session-preview-apps-web.png | none: Paseo has no preview |
| Settings › General | settings-general-apps-web.png | settings-general-paseo-web.png |
| Settings › Appearance | settings-appearance-apps-web.png | settings-appearance-paseo-web.png |
| Light theme (Appearance, New session) | settings-appearance-light-apps-web.png, new-session-light-apps-web.png | — |
| Tab context menu on the session's tab (t-7679.5) | workspace-tab-menu-apps-web.png | workspace-tab-menu-paseo-web.png (t-7679.9: right click on the agent's tab, `workspace-tab-agent_<id>`) |
| Command center (⌘K), empty query | workspace-command-center-apps-web.png | workspace-command-center-paseo-web.png |
| Sidebar dragged 120 px wider | workspace-resized-apps-web.png | workspace-resized-paseo-web.png |
| A pane's ⋯ menu: Split pane right / down (t-7679.9) | workspace-split-menu-apps-web.png | workspace-split-menu-paseo-web.png |
| Split right: a New tab (launcher) in a new pane (t-7679.9) | workspace-split-apps-web.png | workspace-split-paseo-web.png |
| Open ALP tasks full screen (t-7679.9) | workspace-alp-tasks-screen-apps-web.png | workspace-alp-tasks-screen-paseo-web.png |
| Tasks board, List view over seeded tasks (t-7679.17) | tasks-list-apps-web.png | tasks-list-paseo-web.png |
| Tasks board, Board view | tasks-board-apps-web.png | tasks-board-paseo-web.png |
| Tasks board, Epics view | tasks-epics-apps-web.png | tasks-epics-paseo-web.png |
| Typed tool calls from the fake Codex's [tools] turn: edit, write, web search, MCP, sub-agent (t-7679.13) | tools-stream-apps-web.png | tools-stream-paseo-web.png |
| An edit opened: its diff with line numbers and +N −M | tools-edit-apps-web.png | tools-edit-paseo-web.png |
| A new file opened | tools-write-apps-web.png | tools-write-paseo-web.png |
| An MCP call's input and output, a sub-agent's task | tools-agent-mcp-apps-web.png | none: shown in the stream shot |

`node apps/web/scripts/compare-paseo.mjs --only workspace` captures the attention, Shortcuts and
History rows; `--only new-session` the t-7679.3 rows; `--only workspace-p1` the t-7679.5 rows; `--only panes` the t-7679.9 rows; `--only tasks` the t-7679.17 rows; `--only chat` the others.

Differences on the New session screenshots, kept on purpose: paseo-web's draft tab shows only the
composer (with a "Select team" picker of teams and their descriptions); apps/web adds the Title field
and the preview card, and has separate Team, Model and Thinking controls because ALP sessions take a
team, a main-agent model and an effort.

Differences on the t-7679.5 screenshots, kept on purpose: paseo-web's command center lists its own
features (New workspace, Import session, Schedules, Pin to top, ALP's plugin commands) and agents,
not sessions; apps/web lists the actions ALP has, the granted workspaces and the workspace's
sessions (since t-7679.10 also files, on a host with `workspace.files`, with Paseo's placeholder). The favicon and notifications have no
screenshot (the browser's chrome); e2e/tabs.spec.js checks them.

Differences on the workspace screenshots, kept on purpose: paseo-web groups sessions under a
workspace row (apps/web groups by granted workspace, not by Paseo's project key), lists Schedules and Usage (no backend), and its Shortcuts
dialog lists features ALP lacks (open project, pin, theme, panes, voice; search files since t-7679.10). apps/web's
History has a search field: on a host with `session.list.page` it asks the host, as paseo-web does;
on an older host it filters on the client, where paseo-web hides it.

On these screenshots paseo-web repeats streamed assistant text, for example "Answer
received:Answer received: you …". This is a fault of ALP's Paseo bridge, not something apps/web
should copy (see the discovered work in the handoff).

### t-d71b Linux compatibility candidate — verification limits

Web/direct clients now require a deliberate pre-use acknowledgment when a verified
Linux helper lacks bound-signal capability (ENOSYS). The warning states that jobs
may survive terminal close, access revocation or shutdown. Continue/Cancel precedes
shell launch; a restored attachment warns independently. Full native-supported
Linux/macOS keeps identity-bound cleanup. Missing/corrupt helpers and policy denials
do not silently downgrade. Current Paseo protocol has no acknowledgment field: its
bridge surfaces the warning and refuses degraded use. User g6 accepted this temporary
consumer limit on 2026-10-29; native-supported Paseo is unchanged. Other verification
requirements below remain mandatory.

Required platform gaps remain: four Linux glibc/musl x64/arm64 prebuilts, actual Linux
process/namespace/permission/race tests, Linux and Windows browser keyboard behavior,
physical Darwin x64 and macOS11 execution, and independent actual native execution.
No source/seam/macOS browser check substitutes for these; full task acceptance remains incomplete.
