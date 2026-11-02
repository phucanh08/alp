# t-b3cd — leftovers after round 2: handover

Base: `origin/main` 61d889b (2026-11-02). Worktree `/tmp/alp-t-b3cd`. Each item fixed in its own commit.

## Status

| # | Item | Status | Commit |
|---|------|--------|--------|
| 5 | `console.log('DBG')` in `integrations/paseo/tests/paseo.test.js:151` | fixed | 588d693 |
| 3 | alp_skill wrote `role-skills.json` with `writeFile` | fixed (`writeAtomic`, test) | e199019 |
| 4 | `principal.agent` undocumented; agent-name regex in 2 places | fixed (`AGENT_NAME` in `@anhlp/alp-protocol`, ALPD.md §3.2) | bd2508f |
| 6 | compact checkpoint prompt shown as `user_message` | fixed (repro test) | a2ca9e4 |
| 8 | alpd stricter on effort than the CLI for live-only models | fixed (repro test) | 28db994 |
| 9 | agent credential can compact main via gateway | already fixed on main: b1eefc8 | — |
| 3b | no restore for retired skills | proposal only | — |
| 1 | ACP providers in the catalog | proposal only | — |
| 2 | agy (Seatbelt) | proposal only | — |
| 7 | `web.pairing` open to every local client | proposal only | — |

## Fixes (notes)

- **#6.** Both compact prompts (checkpoint request and the fresh-conversation seed, ids `alp-wake-compact-*`) went to the timeline as `user_message` (origin `wake`). Web (`Timeline.tsx`) and Paseo (`timeline-items.ts`) draw every `user_message` as the user's bubble. Now neither path (`startPrompt` or the runtime's `userMessage` echo) emits them. An info notice marks the checkpoint start (en and vi), and the existing "compacted" notice marks the end. No protocol change.
- **#8.** `validateSettings` and `fitEffort` read `knownModel()`, which uses process-local rows. alpd installs live rows (`applyCatalog`). The CLI did so only in `alp setup`. So for `codex:gpt-live-only:high` (live efforts low/medium), `alp doctor`, `init` and `upgrade` passed while alpd refused. `cli.js` now calls `useLiveModels(catalogModels(alpHome()))` before any command. With no cache it uses the static rows, as before.
  - Remaining risk: the cache is eventually consistent with alpd's memory (it is saved on each publish).
- **#9 evidence.**
  - gateway: `apps/gateway/src/connection.js:1591-1593` (`grant.agent === true` → `user_only`)
  - alpd: `packages/daemon/src/server.ts:1601-1603` (`agentRefused`)
  - tests: `apps/gateway/tests/compact.test.js`, `packages/daemon/tests/compact-user-only.test.js`, both green.
  - No commit mentions #299, so the link to that PR could not be confirmed.

## Proposals ([CẦN QUYẾT])

### 3b. Restore a retired skill

Retire moves the skill to `<library>/retired-skills/<name>-<ISO time>` and drops it from `role-skills.json` (`runtime.ts:2137,2163`). The previous roles survive only in the run log (`skill.retire {roles, retiredTo}`) and in the mail to main.

- **A. User CLI `alp skill restore <name> [--from DIR] [--roles a,b|--no-roles]`, plus `alp skills --retired`.**
  - Takes the newest `<name>-*` and refuses if `skills/<name>` exists.
  - Moves the folder back, then calls `setGivenSkills`.
  - Pros: small, and the user acts, so no approval step.
  - Cons: needs the roles metadata (see the note below).
- **B. Agent tool `alp_skill_restore` through the same approval as retire.**
  - Pros: symmetric with retire.
  - Cons: touches tool lists, the Claude transport, wording and tests.
- **C. Web UI action.**
  - Cons: a new RPC plus UI; the most work.
- **Recommend A.** Also write `retired.json` (name, roles, retiredAt, agent, original path) into the retired folder at retire time. For skills retired earlier, require `--roles`. Add B later only if wanted.

### 1. ACP providers in the catalog

Today the catalog has only codex/claude/antigravity rows (`model-catalog.ts`, `models.js:55`). ACP providers live only in `providers/<id>.json` and are addressed as `acp:<id>[/model]`.

Probing is eager in two places:
- alpd probes 3 runtimes at start and every 6h. The agy probe ignores the provider file's `enabled`/`command`.
- Paseo starts every enabled ACP provider on each snapshot (`integrations/paseo/server/paseo/providers.ts:108`). The seeded `opencode.json` and `antigravity.json` are `enabled: true`.

Proposed row: `{ runtime:'acp', provider, id:'<id>[/<model>]', label, description, efforts:[], source:'configured'|'live'|'fallback', enabled, status?:'unprobed'|'ok'|'failed'|'unavailable' }`.
- Example: `{runtime:'acp', provider:'opencode', id:'opencode', label:'OpenCode · agent default', source:'configured', status:'unprobed'}`.

Options:
- **A. Rows from config only, no probe.**
  - Pros: no process starts.
  - Cons: no model list unless the user writes one.
- **B. Probe only on enable or `catalog.refresh`, never at start.**
  - Pros: real model lists.
  - Cons: seeds must become `enabled:false`, with a migration so existing users don't silently lose Antigravity.
- **C. Learn models from the first real session's `session/new`, as `feedCatalog` already does.**
  - Cons: the list is incomplete until first use.

**Recommend A + C, with B's probe only on an explicit enable or refresh.**

### 2. agy (Seatbelt)

ALP ships no `.sb` profile. It passes `--sandbox`, `--mode accept-edits` and `--settings {toolPermission, enableTerminalSandbox, trustedWorkspaces:[cwd, realpath], permissions.allow}` (`antigravity-transport.ts:72-85`).

- **(a) Writable paths in workspace-write.** agy's own profile decides them; ALP supplies only cwd and its realpath.
  - Unverified: TMPDIR, `~/.cache`, and a worktree's shared `.git` (the git common dir). Codex by contrast gets `writableRoots` plus tmp.
  - Needs a macOS run of `agy --sandbox` that writes to each.
- **(b) Read-only gaps (confirmed).**
  - `readOnlyRefuses` flags only edit tools and `run_command` (`:471-476`).
  - `ls` is allowlisted by first word, so `ls /` and `ls ~/.ssh` pass (`:44-55`). agy's `command(ls)` rule is a prefix match.
  - The check runs after the fact: it relabels a DONE step as ERROR, but the model already saw the output.
  - `list_dir`, `view_file` and search tools are never flagged.
- **(c) Hooks.** Nothing in the repo shows agy has a PreToolUse-style hook.

Options:
1. Drop `ls` from read-only, or allow only relative paths with no `..`, `~` or `/`. Cheap, but still after the fact.
2. Path-scoped deny rules in agy `permissions`, if agy supports them. Real prevention; unverified.
3. A PreToolUse hook calling `alp`. Real prevention, but support is unknown, it adds latency, and it may break across agy versions.

**Recommend 1 now. Verify 2 and 3 against agy docs on a Mac before building.**

### 7. `web.pairing` (security; premise holds)

- Handler: `integrations/paseo/server/main.ts:80-85`. When `params.enable` is boolean it calls `relay.setEnabled()`.
- alpd's extension forwarding (`server.ts:1127-1141`, `invokeExtended`) never passes the caller's identity, so the integration cannot refuse agents.
- An agent running `alp web pair --on` in its shell opens the relay. Other methods with this kind of reach (terminal.\*, `workspace.git.facts`, `session.compact`) are already `user_only`.
- The gateway already blocks remote callers.

Options:
- **A. Keep as is.**
  - Cons: inconsistent with the other user-only methods.
- **B. User-only.**
  - alpd adds a `caller: {agent, agentName}` field it sets itself to `extension.invoke`.
  - The integration refuses agent callers with `user_only`, for the whole method (conservative) or only for `enable`.
  - Pros: closes the gap.
  - Cons: one protocol field, one check, tests.
- **C. Named principals allowed.**
  - Cons: no current use.

**Recommend B, whole method.** In the meantime, the conservative choice is also to make `extension.register` user-only (see below).
- Caveat: the agent mark is self-declared (`ALP_AGENT_SESSION`), so this is not a boundary against a hostile process.

### 9. Compact through the gateway (security)

Already fixed (b1eefc8). **Recommend keeping it user-only.** Allowing "the session's own agent" would mean binding credentials to sessions, and nothing needs it.

## New, out of scope (not done)

1. `extension.register` does not refuse agent connections (`server.ts:1127`). While the Paseo integration is down, an agent could claim `web.pairing`, and `alp web pair` would print its link next to the real password.
2. `session.rewind`, `session.reload` and `session.fork` stay open to agent credentials in the gateway and alpd, while `session.compact` is user-only.
3. `alp skill rm` deletes for good (`library-edit.js:360`, `rm -rf`), with no retire step.
4. Docs still say Antigravity is full-access only with a prompt-only read-only mode: `README.md:303-309`, `docs/alp/beta-install.md:36`, `docs/alp/beta-scope.md:146`, `docs/alp/beta-release-notes.md:495`. The comment at `antigravity-transport.ts:25` is stale too.
5. `readOnlyMode` is a no-op (`antigravity-probe.js:67`) but is still validated and written by `alp provider edit --read-only-mode`. `probeAntigravity` always reports `currentMode:'full-access'`.
6. The alpd agy model probe ignores the provider file's `command`, which the agy session uses.
7. Mail wakes (origin `wake`) also render as user bubbles in web and Paseo. This may be intended; worth a product decision.
8. Test env (this container, as root, checkout under /tmp): 7 tests fail identically on untouched `origin/main` 61d889b, so they are not caused by this work.
   - `supervisor` "approved retirement … failed move": chmod does not stop root.
   - `daemon/configure` ×2 (journal write failure): root. Both pass as a non-root user.
   - `daemon/git` ×2 (process group kill), `daemon/terminals` shutdown, and `paseo/panel` "tasks as the user" (projectRoot `/tmp` vs null): environment. CI decides.

## Unresolved questions

- Push target: the designated branch `claude/nifty-allen-rr9rc6` holds unmerged web commits from closed PR #253. As the user chose, the work goes on a new branch, `claude/t-b3cd-round2-leftovers`, as one PR with one commit per item.
- Item 2(a) needs a macOS machine with agy.
