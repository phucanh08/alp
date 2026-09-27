# slp-dev

Bundled alp plugin: the SLP developer profession content. `plugins/slp` carries the seat mechanics
(tool cuts, workspace/Lead wiring, the Supervisor host workspace) and has no seat rule text or
skill list of its own; it asks this plugin, by name, for both. The daemon loads slp-dev when
`pluginsEnabled` is on, with no `plugins.slp-dev` config entry, the same as `plugins/slp`. It ships
no client entry — server only.

## What it contains

| Path                  | Holds                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents/<seat>.md`    | One seat's rule text, verbatim, for `lead`, `peer`, `supervisor`. The `name`/`description` frontmatter is stripped before the text reaches a system prompt.                                                                                                                                                                                                                                                                 |
| `seats.json`          | Maps each seat to the list of skill names it uses.                                                                                                                                                                                                                                                                                                                                                                          |
| `skills/<name>/`      | The skill directories themselves, one per name `seats.json` lists (currently `ask-alp`, `bug-loop`, `goal-griller`, `prompt-leverage`, `sequence-execution-plan`, `smart-commits`, `xia`). The manifest's `skills: "skills"` field tells the daemon to install these the way it installs the core skill bundle, only while this plugin is enabled — see [docs/plugins.md](../../docs/plugins.md#ship-skills-with-a-plugin). |
| `server/seats.gen.ts` | Generated: `agents/*.md` and `seats.json` embedded as one module, checked in.                                                                                                                                                                                                                                                                                                                                               |
| `shared/rpc.ts`       | The `slp-dev.seat.get` contract.                                                                                                                                                                                                                                                                                                                                                                                            |
| `index.server.ts`     | Registers the one RPC handler, answering from `seats.gen.ts`.                                                                                                                                                                                                                                                                                                                                                               |

## The `seat.get` RPC

`slp-dev.seat.get({ seat })` takes exactly one of `"lead" | "peer" | "supervisor"` and answers
`{ definition: string, skills: string[] }` — `definition` is that seat's file with frontmatter
stripped, `skills` is `seats.json`'s list for it (`shared/rpc.ts`). `plugins/slp` calls it by this
plugin's id and this method name, not by discovery: the plugin compiler bundles each plugin on its
own, so slp has no import path to slp-dev's module
(`plugins/slp/server/seat-rules.ts` `SLP_DEV_PLUGIN_ID`, `SLP_DEV_SEAT_GET`). See
[plugins/slp/README.md](../slp/README.md#seat-definitions) for the caller side: the 5 s timeout,
`.slp/agents/<seat>.md` override precedence over the text (never over the skill list), and the
degraded prompt when slp-dev is unavailable.

## Generating `seats.gen.ts`

The plugin compiler bundles `server/` into one evaluated string: at runtime the plugin has no path
to its own directory, and esbuild has no loader for `.md`. `seats-source.ts` reads `agents/*.md`
and `seats.json` and renders the embedded module; `server/scripts/generate-seats.ts` writes it.
After editing a seat file or `seats.json`, run:

```bash
cd plugins/slp-dev && npm run generate
```

`server/seats.test.ts` fails when the generated module is stale, and separately fails when a skill
`seats.json` names for a seat is missing from `skills/`.

## Checks

```bash
npx vitest run plugins/slp-dev --bail=1
(cd plugins/slp-dev && npx tsc --noEmit -p .)
```

## Copy guide for another profession

`plugins/slp` names this plugin by a fixed id, `slp-dev` — it does not discover a profession pack,
and alp has no registry of packs. Replacing what slp talks to is a config edit, not a code change:
a config entry `plugins["slp-dev"]` with a `path` of your own replaces the bundled copy host-wide,
for every workspace on that host.

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "slp-dev": { "source": "directory", "path": "/absolute/path/to/my-pack", "enabled": true }
  }
}
```

`plugins` holds dynamic keys and cannot be set by a dotted CLI path; set the whole object (see
[docs/plugins.md](../../docs/plugins.md#bundled-plugins)):

```bash
paseo daemon config set plugins '{"slp-dev":{"source":"directory","path":"/absolute/path/to/my-pack","enabled":true}}'
paseo daemon reload
```

To build one:

1. Copy this directory. What slp actually addresses is the config key `plugins["slp-dev"]` (or,
   for the bundled copy, the fixed slot name in the daemon's own bundle map) — not your copy's
   `paseo-plugin.json` `id` field. Keep that field `slp-dev` anyway: a plain
   `paseo plugin install /path/to/my-pack`, with no `--id`, then lands under the config key
   `slp-dev` on its own and replaces the bundled copy without an extra flag.
2. Keep `shared/rpc.ts`'s RPC name (`slp-dev.seat.get`) and its input/output shapes unchanged —
   that string is what `plugins/slp` asks for, independent of any plugin id. Change
   `description`, `requirements.paseo`, and `version` in `paseo-plugin.json` freely.
3. Replace `agents/lead.md`, `agents/peer.md`, `agents/supervisor.md` with your profession's three
   seat texts, keeping the `name`/`description` frontmatter — slp strips it, but this plugin's own
   tests read it back to prove the file round-trips.
4. Replace `seats.json`'s skill lists and `skills/<name>/` with your own skills. Every name
   `seats.json` lists for a seat must exist in `skills/`, checked by `server/seats.test.ts`; a seat
   with no skills gets an empty array, the way `supervisor` does here.
5. Run `npm run generate` and commit `server/seats.gen.ts` — the daemon evaluates the bundled
   string, not the source files, at runtime.
6. Point a host's config at your copy as shown above, or install it with `--id`:
   ```bash
   paseo plugin install /absolute/path/to/my-pack --id slp-dev
   ```
   Needed only if you changed the manifest id in step 1.

One id serves the whole host: pointing `plugins["slp-dev"]` at your copy replaces alp's profession
pack everywhere on that host — there is no per-repo or per-workspace pack switch today. A single
repo can still override one seat's rule text alone with `.slp/agents/<seat>.md`
(see [plugins/slp/README.md](../slp/README.md#seat-definitions)), but its skill list always comes
from whichever `slp-dev` the host is running.
