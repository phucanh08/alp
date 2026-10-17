# apps/web compared with paseo-web

This document compares the screens and features of **paseo-web** with those of **apps/web**,
lists what apps/web is missing, and ranks the gaps. Tasks t-7679.1 (chat/timeline), t-7679.2
(sidebar/workspace) and t-7679.3 (settings persistence and the New session flow), part of epic t-7679.

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
- **Đã làm**: done in t-7679.1 (chat), t-7679.2 (sidebar/workspace) or t-7679.3 (settings, New session).

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
| Chat/timeline | Done in this slice: the mode control (menu and Shift+Tab), the Tasks pill, the question card in the stream with Paseo's select-then-Submit flow, scroll-to-bottom, Cmd/Ctrl+L and Escape, and a race in sending fixed. Still missing: per-tool detail views (edit/diff/read/search), virtualization and paging of long histories, chat find (Cmd+F), chat outline, the text reveal, attachments, slash commands, dictation and voice, the context meter, rewind and fork. |
| Sidebar/workspace | Done in t-7679.2: Paseo's workspace keyboard shortcuts and their Shortcuts dialog, History with the archived sessions and Unarchive, attention on every session (`question.list`), the session title on its tab. Still missing: tab menu, persistence and drag order; split panes; resizable sidebar and dock; command center; favicon status. |
| Settings | Done in t-7679.3: settings kept across reload (localStorage, never the token), Appearance › Theme (System/Light/Dark with Paseo's light palette), Reset, the New session screen (Paseo's new agent tab: first message, team/model/thinking/permissions controls, `session.preview`, remembered choices). Still missing: fonts and sizes, Paseo's other themes, chat display settings, library content (blocked: GW denies `library.get/save`), providers (blocked: §14), client diagnostics. |
| Rest | i18n (Vietnamese/English). Stacking toasts. Browser notifications when an agent needs input. Error boundary. |

## 2. Chat/timeline and composer

| Feature | paseo-web | apps/web before | Backend | Priority | Now |
|---|---|---|---|---|---|
| Stream layout: 820px column, user bubble on the right, plain-markdown assistant, item spacing | P:agent-stream/view.tsx, spacing.ts, components/message.tsx | Có (W:app/Timeline.tsx) | yes | none | Có |
| Turn footer: copy turn, "Worked for", end time on hover | P:agent-stream/turn-footer.tsx, message.tsx AssistantTurnFooter | Có (W:Timeline.tsx TurnFooter) | yes | none | Có |
| Working row: 2x3 loader and elapsed time | P:turn-footer.tsx RunningTurnFooter, components/synced-loader.tsx | Có (W:chat/parts.tsx Loader, Elapsed) | yes | none | Có |
| Fork icon in the turn footer | P:components/assistant-fork-menu.tsx | Thiếu | no (no fork RPC) | P2 | Thiếu |
| Tool call badge, expands to detail; shell `$ cmd` and output | P:message.tsx ExpandableBadge/ToolCall, tool-call-details.tsx | Có for shell/unknown (W:Timeline.tsx ToolCall) | partial: ALP sends only `shell` and `unknown` details | P1: per-tool views need richer ALP tool details | Một phần |
| Todo in the stream (badge) | P:message.tsx TodoListCard | Có (W:Timeline.tsx Todo) | yes | none | Có |
| Tasks pill above the composer: label `Tasks · n` or `done/worked`; menu lists the session's tasks first, then open ones, then All tasks | ALP plugin: integrations/paseo/client/task-pills.ts, P:composer/tracks.tsx | Thiếu | yes (`task.list`; session work from the todo item) | P0 | **Đã làm** (W:app/chat/tracks.tsx, lib/tracks.js) |
| Question card: question text, radio options, "Other..." field, Dismiss and Submit; it sits at the tail of the stream and scrolls with it | P:components/question-form-card.tsx, view.tsx PermissionRequestCard / renderLiveAuxiliary; ALP mapping in integrations/paseo/server/paseo/agents.ts permissionOf | Một phần: one click answered at once, "Decline", the card sat between stream and composer | yes (`question.answer`) | P0 | **Đã làm**: Paseo's select, then Submit flow; Other replaces the choice; Enter submits; inside the log (W:QuestionCard.tsx, SessionView.tsx) |
| Scroll-to-bottom button (48px round, chevron) when away from the end | P:agent-stream/view.tsx scrollToBottomButton | Thiếu | client only | P0 | **Đã làm** (W:Timeline.tsx) |
| Composer: one rounded surface, text above, controls below; Send / Interrupt / none | P:composer/index.tsx, composer/input/input.tsx | Có (W:Composer.tsx) | yes | none | Có |
| Enter steers while running, Cmd/Ctrl+Enter queues; the Default send setting swaps them; queue with Edit / Send now above the box | P:composer/submit.ts, actions.ts, tracks queue | Có | yes | none | Có |
| "⌘L to focus" hint; Cmd/Ctrl+L focuses the box | P:keyboard/keyboard-shortcuts.ts `message-input-focus-*` | Thiếu | client only | P0 | **Đã làm** (W:Composer.tsx) |
| Escape interrupts the agent (from the box or from no particular element) | P:keyboard-shortcuts.ts `agent-interrupt` | Thiếu | yes (`session.interrupt`) | P0 | **Đã làm** |
| Mode control: a menu of modes with a check on the current one; Shift+Tab cycles | P:composer/agent-controls/mode-control.tsx; bridge set_agent_mode_request → `session.configure` | Một phần: a read-only label | yes (`session.configure`, mode inside the grant; the runtime changes it only between turns with no child running) | P0 | **Đã làm** (W:SessionView.tsx ModeControl, controller.configureMode); locked, with a tooltip, while the agent or its team works |
| Team control "Phở ⌄" (patch 0018 "Select team") | P:components/combined-model-selector.tsx, patches 0018/0019 | Một phần: a label | no: the bridge has no set_agent_model; team is fixed per session | P2 | Một phần: a label; main's model is in its tooltip (paseo-web shows no model) |
| Busy as soon as a message leaves: the stop button appears and Cmd/Ctrl+Enter queues before turn.started | P:composer/index.tsx isProcessing / submit loading | Bug: a message sent before turn.started went as `auto` and the host refused it ("Turn already active") | yes | P0 | **Đã làm**: `controller.rootBusy`; a second message waits for the first one's answer, then steers (W:lib/controller.js) |
| Placeholder "Message the agent, tag @files, or use /commands and /skills" | P:composer/input/labels.ts | "Message main…" | @files and /commands: no | P2 | Kept: ALP has neither |
| Attachments (+ menu: image, paste, file, GitHub PR/issue) | P:composer/attachments, index.tsx attachmentMenuItems | Thiếu | no: `session.prompt` content is text only (the runtime refuses others) | P2 | Thiếu |
| Slash commands and autocomplete | P:composer index ComposerAutocompleteBinding, client-slash-commands | Thiếu | no | P2 | Thiếu |
| Dictation (mic) and realtime voice | P:dictation/, voice/ | Thiếu | no | P2 | Thiếu |
| Context window meter | P:components/context-window-meter.tsx | Thiếu | no: no token usage in events | P2 | Thiếu |
| Rewind (user message menu) | P:components/rewind | Thiếu | no | P2 | Thiếu |
| User message: timestamp and copy on hover | P:message.tsx UserMessage | Có | yes | none | Có |
| Long histories: virtualized list, paging to older history, reading anchor | P:agent-stream/strategy-web.tsx, history-window.ts, bottom-anchor-controller.ts | Thiếu: renders everything | partial: `session.attach after` gives no paging backwards | P1 | Thiếu |
| Chat find (Cmd+F in the conversation) | P:agent-stream/chat-find | Thiếu | client only | P1 | Thiếu |
| Chat outline rail (jump between prompts) | P:agent-stream/chat-outline | Thiếu | client only | P1 | Thiếu |
| Text reveal of streamed text | P:agent-stream/text-reveal.ts | Thiếu | client only | P2 | Thiếu |
| Assistant markdown: code blocks with highlighting and copy, links to files | P:message.tsx AssistantMessage, highlighted-code-block.tsx, assistant-file-links | Một phần (W:RichText.tsx, chat/markdown.ts: no highlighting, no file links) | file links need files RPCs | P1 | Một phần |
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
| Project, then workspace (worktree/branch), then agents | P:components/sidebar-workspace-list.tsx | Một phần: project = granted workspace, rows = sessions (W:app/Sidebar.tsx) | no: `workspace.*` §14 | P1 | Một phần |
| Add or remove a project | P:sidebar-workspace-list.tsx | Thiếu | no: `project.*` §14 | P2 | Thiếu |
| Workspace row menu: rename, pin, copy path/branch, archive, labels | P:components/sidebar/sidebar-workspace-menu.tsx | Một phần: Rename, Archive | partial | P1 | Một phần |
| Pinned section; display preferences (grouping, filters, title source) | P:sidebar/pinned-section-header.tsx, display-preferences/menu.tsx | Thiếu / Một phần | client only | P1 | Thiếu / Một phần |
| Workspace labels, hover card | P:workspace-labels/, workspace-hover-card.tsx | Thiếu | no / partial | P2 | Thiếu |
| Status dot with attention on every session | P:components/agent-status-dot.tsx | Một phần: needs_input only for the attached tree | yes: `question.list` | P0 | **Đã làm**: `question.list` polled every 5 s per workspace; the open tree's own questions count at once; needs_input outranks running, as Paseo's buckets (W:lib/controller.js refreshAttention, needsInput; Sidebar.tsx; History.tsx) |
| Sidebar items: New workspace, History, Search, Schedules, Usage | P:sidebar-nav/model.ts | Một phần: New session, Search | History: yes | P1 | Một phần: New session (⌘N badge on hover), History, Search (⌘K badge); Schedules and Usage have no backend |
| History screen (search, load more, archived, restore) | P:screens/sessions-screen.tsx | Thiếu: archived sessions are hidden (W:lib/controller.js session list) | yes: `session.list includeArchived`, `session.archive archived:false` | P0 | **Đã làm**: date sections, search, Archived and Needs input badges, Refresh; an archived session opens with Paseo's "archived" callout and Unarchive in place of the composer (W:app/History.tsx, lib/history.js, controller loadHistory/restoreSession). No Load more: `session.list` has no paging |
| Workspace header menu (new agent/terminal, copy path/branch, import) | P:screens/workspace/workspace-header-menu.tsx | Một phần: Rename, Copy ID, Archive | partial | P1 | Một phần |
| Tab row and + New tab | P:workspace-desktop-tabs-row.tsx | Có | yes | none | Có; ⌘T opens the + menu |
| Tab context menu, drag order, kept across reload | P:workspace-tab-menu.ts, drag-reorder/, workspace-tabs/model.ts | Thiếu | client only | P1 | Thiếu |
| Split panes | P:components/split-container.tsx | Thiếu | client only | P1 | Thiếu |
| Explorer dock with tabs | P:screens/workspace/explorer-sidebar.tsx | Có | Changes/Files: no | none | Có |
| Resizable sidebar and dock | P:sidebar-resize-handle.tsx | Thiếu (fixed 320px) | client only | P1 | Thiếu |
| Keyboard shortcuts (new agent, toggle panels, navigate, archive) and their help dialog | P:keyboard/actions.ts, keyboard-shortcuts-dialog.tsx | Thiếu: only Esc, plus Cmd+L, Escape and Shift+Tab in chat | client only | P0 | **Đã làm**: the web build's bindings, Mod = Cmd on a Mac, Ctrl elsewhere: ⌘N new session, ⌘⇧⌫ archive, ⌥1-9 / ⌥[ ⌥] sessions, ⌘T new tab menu, ⌘⇧A agent, ⌘⇧G Changes, ⌘⇧E Files, ⌘⇧T terminal, ⌥⇧W close tab, ⌥⇧1-9 / ⌥⇧[ ⌥⇧] tabs, ⌘B / ⌘E (or Ctrl+Backquote) / ⌘. sidebars, ⌘, settings, ⌘K search, ? the searchable Shortcuts dialog (W:lib/shortcuts.js, app/Shortcuts.tsx, App.tsx). Left out, as ALP has no such feature: open project, search files, pin, browser tabs, panes, focus mode, theme, voice. Shortcuts wait while a dialog is open. ⌥1-9 and ⌥[ ⌥] follow the full session list even while the sidebar search filters it. No rebinding |
| Command center (Cmd+K) | P:command-center/ | Thiếu | partial (sessions and tasks: yes; files: no) | P1 | Thiếu: ⌘K opens the sidebar's session search for now |
| Favicon status | P:hooks/use-favicon-status | Thiếu | yes | P1 | Thiếu |
| Mobile gestures | P:mobile-panels/gestures.ts | Một phần (drawers, no swipe) | client only | P2 | Một phần |
| Board (ALP pins) | none in Paseo | Thiếu | yes: `board.list` | P1 | Thiếu |

### 3.2 Workspace features

The column **apps/web** gives the state before t-7679.3; **Now** gives it after (— : unchanged).

| Feature | paseo-web | apps/web | Backend | Priority | Now |
|---|---|---|---|---|---|
| New workspace/agent screen with a first prompt, isolation and ref | P:screens/new-workspace-screen.tsx; inside a workspace P:composer/draft/workspace-tab.tsx (the "New Agent" tab) | Một phần: NewSessionDialog: title, team, mode, model (W:Dialogs.tsx) | partial: first prompt and thinking are allowed spec fields; worktree/ref no | P0 | **Đã làm**: Paseo's draft agent tab: a "New session" tab in the tab row (⌘N, sidebar, + › Agent, the empty screen), open area above, composer below with the agent controls; the first message starts the session (`session.create`, then `session.prompt` after attach through the composer's path: receipts, Retry, never resent by itself) and names it when no title is given; the start button also works with an empty box; one start at a time (a second Enter or a double click does nothing; the controller refuses a second `session.create` while one is in flight); Start waits while the preview is still checking the current team/model (the box stays editable); the tab stays in front until the session is ready and cannot be closed meanwhile. A refused create, or one whose answer was lost (timeout, drop: the session may exist and stays selected; the first message is never sent), is shown in the draft with the text restored; if the draft was left meanwhile, the failure comes as a notice and the whole unsent message is put back in the next New session box of the same workspace (kept in memory only, forgotten on disconnect). The choices are remembered as Paseo's form preferences (team, model, mode, thinking per model) (W:app/NewSession.tsx, lib/new-session.js, tabs.tsx, controller.createSession). ALP keeps an optional Title field (Paseo generates titles on the host, alpd does not). No isolation/ref (no worktree backend) |
| Team/model picker with effort (patches 0018, 0019) | P:components/model-browser.tsx, combined-model-selector.tsx, agent-controls thinking | Một phần: native selects, no thinking | yes: `team.list`, `library.models` (efforts, effort) | P0 | **Đã làm**: composer toolbar menus Team, Model (main agent's, "Team default" first), Thinking (the effective model's efforts with Paseo's labels, "Default (usual)" first; hidden when the model takes none), Permissions; after a choice the box has focus again, as Paseo's onDropdownClose. paseo-web's patched picker lists teams as "models" (Select team) and shows no thinking for them; apps/web keeps team and model apart. No search field in the menus (lists are short) |
| Session preview (which team will run) | P:provider-selection/ | Thiếu | yes: `session.preview` | P1 | **Đã làm**: "This session will run" card: team, agent, runtime, model, thinking, permissions; refreshed 250 ms after a choice changes, older answers dropped, last answer dimmed while checking; errors shown in the card with Retry; without `session.read` it says why. Thinking is checked only against a preview that answered the current team and model. The team is always sent explicitly (see §4: preview and create disagree on the default): the one chosen, else the one the current preview named, else (preview unavailable) the first `team.list` entry; when no team can be told, Start waits instead of creating without one, and the screen says why (no `team` capability, no `project.read`, `team.list` failed, the preview failed or is blocked by a missing `session.read`) and what unblocks it (Retry, which also asks `team.list` again after it failed, or a token with the missing permission). `session.create` goes without a team only when `team.list` answered that the host has none |
| Welcome tiles (add project, import, providers) | P:screens/open-project-screen.tsx | Thiếu | mostly no | P2 | — |
| Add project with the host folder browser (patch 0011) | P:components/add-project-flow.tsx | Thiếu | no | P2 | — |
| Files, Changes, Diff panels | P:panels/files-panel.tsx, panels/changes, diff-panel.tsx | Placeholder | no: `workspace.files/git` §14 | P1 (blocked) | — |
| Git actions, branch switcher, PR panel, review comments | P:git/, components/branch-switcher.tsx, review/ | Thiếu | no | P2 | — |
| Terminal | P:panels/terminal-panel.tsx, terminal/ | Placeholder | no (not even proposed) | P2 | — |
| Schedules | P:screens/schedules-screen.tsx | Thiếu | no | P2 | — |
| Project settings, setup panel | P:screens/project-settings-screen.tsx, panels/setup-panel.tsx | Thiếu | no | P2 | — |
| Agents panel (the tree) | P:panels/agent-tracks.tsx | Có | yes | none | — |
| Subagent actions (archive finished, detach) | P:subagents/ | Thiếu | partial | P1 | — |
| Tasks panel and detail (ALP) | ALP plugin | Có | yes | none | — |
| Run log of a session | none in Paseo | Thiếu | yes: `session.log` | P1 | — |
| Usage | P:usage/ | Thiếu | GW denies `daemon.usage` | P2 | — |

### 3.3 Settings

| Section | paseo-web | apps/web | Backend | Priority | Now |
|---|---|---|---|---|---|
| Layout: the App group, then the Host group | P:screens/settings-screen.tsx | Có (W:Settings.tsx) | yes | none | — |
| Settings kept across reload | Paseo stores them (P:hooks/use-settings, `@paseo:app-settings`; create-agent-preferences) | Thiếu | client only | P0 | **Đã làm**: one versioned localStorage key `alp-web:preferences` (v1): Default send, theme, New session choices; read field by field (garbage or another version gives the defaults and is overwritten); written with known fields only, so the access token never reaches storage (Connections still says memory only); other tabs follow through the storage event; General › This browser › Reset (W:lib/preferences.js, controller setSendBehavior/setTheme/resetPreferences) |
| General: language, Default send | P:screens/settings/general | Một phần: Default send in memory only, language disabled | client only | P1 | Một phần: Default send saved; language still English only (no i18n) |
| Appearance (themes, fonts) | P:screens/settings/appearance | Placeholder | client only | P1 | Một phần: Theme System/Light/Dark (Paseo's light palette as CSS tokens, System follows prefers-color-scheme live); left out: Paseo's variant themes (zinc, midnight…), fonts, sizes, content width and syntax theme — each needs its own tokens/typography pass across the app |
| Chat settings (detail level, outline, tool detail) | P:screens/settings/chat/chat-section.tsx | Unavailable | client only | P1 | — |
| Diagnostics | P:components/app-diagnostic-sheet.tsx | Unavailable | partial | P1 | — |
| About | P:settings-screen.tsx AboutSection; patch 0007 | Có | yes | none | — |
| Host Overview: name, color, restart, remove | P:screens/settings/host-page.tsx | Một phần | partial | P1 | — |
| Machine name as the host label (patch 0017) | patch 0017 | Thiếu | no: no hostname in hello | P2 | — |
| Library screens: Templates, Agents, Skills, Hooks, MCP (patches 0015, 0016) | patches 0015/0016 | Một phần: names only | GW denies `library.get/save` | P1 | — |
| Providers: runtimes, default switch, custom ACP (patches 0012-0014) | P:screens/settings/providers-section.tsx | Một phần: names | no: `provider.*` §14 | P1 | — |
| Workspaces, Terminals, Plugins, Usage, Pair device, Metadata | host-page.tsx and others | Unavailable | no | P2 | — |

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

## 4. Not in apps/web: protocol, gateway or daemon work

- **Git, files and terminal:** `workspace.git.*` and `workspace.files.*` are proposed in §14 and not
  implemented. There is no terminal protocol.
- **Workspace and project registry:** `workspace.*` and `project.*` (§14).
- **Providers:** `provider.*` and `library.test` (§14).
- **Library content:** the gateway denies `library.get`, `library.save`, `library.delete` and
  `library.rename`.
- **Usage, status, language:** the gateway denies `daemon.usage` and `daemon.status`, and also
  `settings.language.set`.
- **Host name:** the hello carries no hostname, so patch 0017's machine-name label cannot be done
  through the gateway.
- **Chat:**
  - prompts other than text (attachments);
  - token usage (context meter);
  - fork and rewind;
  - paging back through history;
  - richer tool-call details (edit/read/search) in ALP's timeline items;
  - changing the team or model of a running session.
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

`node apps/web/scripts/compare-paseo.mjs --only workspace` captures the attention, Shortcuts and
History rows; `--only new-session` the t-7679.3 rows; `--only chat` the others.

Differences on the New session screenshots, kept on purpose: paseo-web's draft tab shows only the
composer (with a "Select team" picker of teams and their descriptions); apps/web adds the Title field
and the preview card, and has separate Team, Model and Thinking controls because ALP sessions take a
team, a main-agent model and an effort.

Differences on the workspace screenshots, kept on purpose: paseo-web groups sessions under a
workspace row (ALP has no `workspace.*`), lists Schedules and Usage (no backend), and its Shortcuts
dialog lists features ALP lacks (open project, search files, pin, theme, panes, voice). apps/web's
History has a search field because it filters on the client; paseo-web hides it when the host cannot
search.

On these screenshots paseo-web repeats streamed assistant text, for example "Answer
received:Answer received: you …". This is a fault of ALP's Paseo bridge, not something apps/web
should copy (see the discovered work in the handoff).
