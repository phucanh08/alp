# Running ALP on Codex only

Phở and Cafe run main on Claude Opus 5.5 and their supervisor on Claude Sonnet 5.
On a machine with only Codex, point those two at Codex models. The rest of the team
follows:

- **Lead, peer and reviewer** have no fixed model. They run on what their requester
  chooses, or inherit its model, so they run on Codex once main does.
- **Oracle** runs only on Fable (`claude:claude-fable-5-1`) or Astra
  (`codex:gpt-6-astra`). On Codex only, it uses Astra.

## 1. Install

You need Node.js 22 (22.12 or later) or 24 and the Codex CLI, logged in (`codex login`).
Claude Code is not needed. Install the beta by name; a plain `npm install -g @anhlp/alp`
installs the older `0.10.0` ([beta-install.md](beta-install.md)).

```sh
npm install -g @anhlp/alp@beta
alp doctor
```

`alp doctor` should show `✓ codex … logged in`. A warning that `claude` is not found is
expected here. If Codex is not on `PATH`, set `ALP_CODEX_BIN` to its absolute path.

## 2. Point Phở and Cafe at Codex

In a project, `alp setup --runtime codex` writes Codex-only profiles for every Phở and
Cafe agent, the oracle included, into `.alp/settings.json`. To point every project at
Codex instead, override the teams in your library:

```sh
alp team edit pho  --member-model main=codex:gpt-6.1-sol --member-thinking main=high \
                   --supervisor-model codex:gpt-6-luna --supervisor-thinking medium
alp team edit cafe --member-model main=codex:gpt-6.1-sol --member-thinking main=high \
                   --supervisor-model codex:gpt-6-luna --supervisor-thinking medium
alp teams
```

Each `alp team edit` saves an override of the built-in team in your library
(`~/.alp/teams/<id>/team.json`); the built-ins themselves are never changed. `alp teams`
then shows both teams on Codex:

```
pho  Phở  library, overrides the built-in one
  members: main (main) on codex:gpt-6.1-sol, high, peer (peer), oracle (advisor), reviewer (reviewer)
  supervisor: supervisor (watches main) on codex:gpt-6-luna, medium; at most 2 peers
```

Any model your Codex CLI lists works: pass it as `codex:<model>`, and the effort as
`low`, `medium`, `high`, `xhigh` or `max` (or a level the model supports).

To change only one project, add `--project DIR`; the override then lives in that
project's `.alp/teams/`. `.alp/settings.json` → `runtime` is not enough on its own:
it changes main's model, but the supervisor stays on Claude.

## 3. Check it

```sh
mkdir -p ~/alp-try && cd ~/alp-try && git init -q && alp init
alp run --team pho "Reply with one word: ok"
```

The first lines name each session's model:

```
▸ main (codex:gpt-6.1-sol, full-access) cli-…
  ▸ supervisor (codex:gpt-6-luna, read-only) alp-supervisor-…
  main: ok
```

In Cafe, the lead that main starts shows `codex:gpt-6.1-sol` too.

## 4. Paseo and the web app

- **Paseo:** `paseo plugin add npm:@anhlp/alp-paseo@beta` (from `0.0.0-beta.2`; in beta.1
  the `npm:` source fails, [#111](https://github.com/phucanh08/alp/issues/111): run
  `npm install -g @anhlp/alp-paseo@beta`, then `paseo plugin add "$(npm root -g)/@anhlp/alp-paseo"`).
  Phở and Cafe in the model picker use your overrides.
- **Web app:** `alp web`. From the release after `0.0.1-beta.3` it ships in `@anhlp/alp` and needs
  no plugin; in `0.0.1-beta.3` it is in `@anhlp/alp-paseo` (`npm install -g @anhlp/alp-paseo@beta`,
  `alp-paseo-integration --register`, then `alp web`)
  ([beta-install.md](beta-install.md#alp-web-on-this-machine)).

## What changes with one runtime

- **Usage limits:** when Codex hits its limit, ALP pauses it and parks running
  assignments. With no other runtime, nothing works until the limit lifts. ALP resumes
  by itself (see [pause and usage limits](team-workflow.md#pause-and-usage-limits)).
- **Two oracle opinions:** main and lead may ask Fable and Astra for two opinions.
  The Fable oracle fails to start ("Claude executable not found"), so they get Astra's
  opinion only. Their instructions say to report an unavailable model, never to swap
  in another.

## Undo

```sh
alp team rm pho
alp team rm cafe
```

This removes the overrides; the built-in Phở and Cafe apply again.
