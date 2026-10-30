# Backups, restores, upgrades and recovery

ALP keeps your sessions, tasks and settings in two places: alpd's home (`$ALP_HOME`,
default `~/.alp`) and each project's `.alp` directory. This guide covers what is kept where,
how to back it up and restore it, what happens to it when ALP is upgraded or downgraded, how
long ALP keeps it, and what to do when something goes wrong. The design is in
[ALPD §68](../../plans/reference/ALPD.md#68-backups-restores-migrations-and-retention-2026-10-15).

## What ALP keeps, and what a backup holds

A backup holds the **units** below. A restore replaces these units with the archived data,
including removing entries recorded as absent, with the workspace authority exceptions
described under [Restoring](#restoring). Nothing outside these units is read or changed.

| Where | Unit | What it is |
|---|---|---|
| `$ALP_HOME/state` | `schema.json` | the state's schema version |
| | `sessions/` | one record per session: status, title, the native thread it resumes, its spec |
| | `timeline/` | every event of each session tree, with its replay cursor |
| | `receipts/` | one receipt per delivered prompt, so a retried prompt is never sent twice |
| | `assignment-results.json`, `assignment-results.json.initialized` | retained assignment owners, with a shared writer's result evidence, and checkout birth records; restore keeps owners and their evidence, clears births, and drops how a result was handled, so a restored result needs `alp_resolve` again |
| | `assignment-archive/` | results resolved with `alp_resolve`, one JSON line each in a file per month, kept 365 days after the month ends |
| | `worktree-destinations.json` | host destination mappings; restored only as inactive evidence |
| | `recall.json`, `pause.json`, `trust.json`, `web-workspaces.json` | finished assignments you can recall, pauses, trusted projects, Paseo workspaces |
| `$ALP_HOME` | `settings.json`, `library.json`, `role-skills.json`, `lessons.md` | your settings and your library's bookkeeping |
| | `agents/`, `skills/`, `teams/`, `hooks/`, `mcp/`, `providers/`, `formulas/` | your library |
| | `boards/`, `runs/` | project boards and assignment logs |
| each project | `ALP.md`, `.alp/settings.json`, `.alp/lessons.md` | project instructions, settings and lessons |
| | `.alp/tasks/`, `.alp/agents/`, `.alp/skills/`, `.alp/teams/`, `.alp/hooks/`, `.alp/mcp/`, `.alp/formulas/` | tasks and the project's library layer |

**Not in a backup, on purpose:**

- `state/live.json` lists the work alpd continues after a restart. A restore removes it, so
  restored sessions never continue work from another time. What a running assignment had
  changed stays on its `alp/<id>` branch in the project.
- `logs/`, `worktrees/`, `copies/`, `alpd.lock`, the socket and `alpd.json` are process
  files. ALP recreates them.
- `paseo.json` and `relay-keypair.json` are secrets that the Paseo integration regenerates;
  `web.json` and `web/credentials.json` are alp-web's, which it regenerates too.
  If the relay key pair is lost, your phone needs pairing again with `alp web pair`.
- `integrations/` records where this machine's install lives.
- `backups/` is where backups themselves are kept.

**Owned by others, so ALP cannot back them up:**

- **Codex threads** live in Codex's own home (`$CODEX_HOME`, by default `~/.codex`).
- **Claude Code sessions** live in Claude's config directory (by default `~/.claude`),
  filed by the directory they ran in.
- **Antigravity** conversations and **ACP agents'** sessions live wherever those tools keep
  them.
- **Paseo** and **ACP editors** keep their own handles to ALP sessions.
- **Git** holds each assignment's branch (`alp/<id>`).

A session record names its native thread. `alp backup verify` counts these references as
`external`. When ALP restores sessions without their threads, it lists them with their full
history, but it cannot resume them natively. To carry them to another machine as well, copy
the provider's own directory there yourself.

A backup holds your settings and library. It can therefore hold credentials: provider `env`,
MCP `headers`, and the `env` of a session's spec. ALP writes backups with mode 0600. Keep
them private, as you would `~/.alp`. Backups are not encrypted.

## Making a backup

alpd must not be writing while a backup reads, so `alp backup` needs alpd stopped:

```sh
alp backup --stop                 # stops alpd, backs up, starts it again
alp backup -o ~/alp-2026-10-15.alpbackup --stop
alp backup --project ~/src/app    # add a project; --no-projects leaves projects out
```

Without `--stop`, `alp backup` refuses while alpd runs. `--stop` stops alpd as
`alp daemon stop` does and starts it again afterwards. Work that was running is continued
then, as after any restart. During the backup, ALP holds alpd's lock, so nothing can start
another alpd. Paseo waits, and a client that tries is told `ALP is busy: alp backup runs`.

Each project's tasks are read under the task lock, so a task is never caught half written.
By default the backup includes:

- every project a recorded session worked in;
- the current directory, when it is an ALP project;
- each `--project`.

The file goes to `$ALP_HOME/backups/backup-<time>.alpbackup` unless `-o` names another
path. Copy it off the machine: a backup on the same disk does not survive that disk.

```sh
alp backup verify FILE     # reads the whole file and checks every checksum; changes nothing
alp backup list            # the backups in $ALP_HOME/backups
```

## Restoring

```sh
alp restore FILE --dry-run    # checks the whole backup; says what it would replace; changes nothing
alp restore FILE --stop       # stops alpd, restores, starts it again
alp restore FILE --home-only  # $ALP_HOME only; projects stay as they are
```

A restore runs in four steps, and your current data stays safe through each of them:

1. **It checks everything first.** ALP reads the whole backup and checks every line, every
   file's size and sha256, and the end record. It unpacks the backup into staging
   directories beside the targets. ALP refuses the backup, changes nothing and takes no
   copy if:
   - it is corrupt, cut short, or not a backup;
   - it names a path outside its units, a path twice, or a path under a link it holds;
   - it is in a format this ALP does not read (`BACKUP_UNSUPPORTED`);
   - it holds a state schema newer than this ALP knows (`BACKUP_SCHEMA_TOO_NEW`).

   ALP also refuses to restore over a home whose state is newer than it knows
   (`STATE_SCHEMA_TOO_NEW`), unless you pass `--replace-newer` (see
   [Downgrades](#downgrades)). The journal exists from the first staged file on, so even
   a restore killed while it unpacks leaves nothing behind.
2. **It saves what it replaces** in `$ALP_HOME/backups/pre-restore-<time>.alpbackup`.
   `alp restore` of that file restores the saved data with the same workspace authority
   checks described below. ALP keeps the newest five of these.
3. **It swaps under a journal.** `$ALP_HOME/restore-journal.json` lists every swap. ALP
   moves the current units aside, moves the staged ones in, then marks the journal
   committed.
4. **It cleans up.** It deletes what it moved aside, then the journal.

If something fails before the commit, ALP moves everything back and reports
`RESTORE_FAILED`. If the process dies part way (a kill, a crash, a power cut), the next
`alp restore` or the next alpd start settles the journal before doing anything else. Before
the commit, that means an exact rollback to the data and authority you had. After it, it
means finishing the clean-up. `alp doctor` shows a restore that was cut short.

A successful workspace restore preserves assignment owners from both the backup and the
current state, including owners recorded after the backup. It clears checkout birth
certifications, so old targets need audited adoption before mutation or deletion. Archived
host destination mappings are kept only as private evidence in
`state/worktree-destinations.quarantined.json`; active mappings need explicit host
reapproval. Historical checkout grants stay revoked even after reapproval (the registry's
`grantEpoch` values are rotated). These rules also apply when replaying a pre-restore or
pre-migration backup, including automatic recovery after a failed migration. Settings-only
restores do not change workspace authority.

After a restore:

- Sessions that were working when the backup was made **wait for you**. alpd continues none
  of them by itself (it logs `ALP_STATE_RESTORED`).
- Tasks come back as they were. Assignments that held tasks at backup time are gone, so
  main reopens those tasks at its next turn.
- A project whose directory no longer exists is skipped and reported. Projects come back to
  the same absolute paths they were backed up from.
- Trust (`state/trust.json`) and boards are keyed by a project's path. A project at a new
  path needs `alp trust` again, and starts a new board.

## Upgrades: state migrations

`$ALP_HOME/state/schema.json` names the state's schema. A home without it holds schema 1,
the format of every ALP before 0.11. This ALP writes schema 2.

When alpd starts, it brings an older state up to date before it reads anything:

1. It saves the state to `$ALP_HOME/backups/pre-migrate-v<from>-v<to>-<time>.alpbackup`.
   ALP keeps the newest five.
2. It writes `state/migration.json`, which names that backup.
3. It runs the step. Each step is idempotent: run again over its own partial result, it
   writes the same files.
4. It writes the new schema, then removes the journal. The log says `ALP_STATE_MIGRATED`.

| From → to | Step | What changes |
|---|---|---|
| 1 → 2 | `timeline-cursors` | each timeline line gets the cursor alpd already gave it when reading. Lines that do not parse are kept as they were |

**Interrupted** (a kill, a crash, a power cut): the next start finds the journal and runs
the step again over what it left, against the same backup.

**Failed** (the step reported an error): alpd puts the state back from that backup, removes
the journal and does not start. Its log says `ALP_STATE_MIGRATION_FAILED`, with the cause
and the backup's path. The saved data is restored with the workspace authority checks
described above; previous mutation permissions are not reinstated. Fix the cause (usually
disk space or permissions) and start alpd again, or go back to the previous ALP version.

## Downgrades

An ALP that finds a state schema newer than it knows refuses to open it:

- alpd exits with `ALP_STATE_SCHEMA_TOO_NEW`, naming the version that wrote the state. It
  writes nothing in the state, not even its crash marker.
- `alp restore` refuses to write over it, unless you pass `--replace-newer`.
- `alp doctor` reports the schema as failed, and `--fix` leaves the state alone.

ALP never converts newer data back to an older format. To go back to an older ALP:

- **Keep the data:** run the version that wrote it, or a newer one.
- **Take the data from before the upgrade:** with the older ALP, run
  `alp restore --replace-newer $ALP_HOME/backups/pre-migrate-v<old>-v<new>-….alpbackup`.
  It saves the newer state to a `pre-restore-*` backup first (only the newer ALP can
  restore that one), then restores the saved data with the workspace authority checks
  described above. Work done after the upgrade is not in the restored sessions and tasks;
  assignment ownership evidence is retained.

Versions before 0.11 do not read `schema.json`, and have no `alp restore`. Schema 2 differs from schema 1 only in
having explicit cursors, which those versions already read, so going back to them works.
Every later schema change raises the number, and versions from 0.11 on refuse what they do
not know.

## How long ALP keeps things

| What | How long | Guarded by |
|---|---|---|
| a session tree: records, timeline and run log | 30 days after its last write, or after it was restored | No tree is deleted while any of the following holds: one of its sessions is live; a receipt of one of its sessions is still in its window; the runtime can continue one of its assignments; it is open, attached or being recovered. Timelines are never trimmed while their tree stays, so every cursor a client holds replays |
| a prompt receipt | 7 days after its last write | After that, the same `clientMessageId` may be sent again |
| finished assignments you can recall | 14 days, newest 1000 | ALP also deletes their native threads |
| board notes | the newest 200 decisions and findings | live claims are kept |
| alpd's log | 10 MB × 3 files, rotated at start | |
| automatic backups (`pre-migrate-*`, `pre-restore-*`) | the newest 5 of each kind | |
| your own backups | never deleted by ALP | |

alpd applies retention when it starts, and every six hours while it runs. Archived sessions
age like any others.

## When something goes wrong

Start with `alp doctor`. It reads only, and names what it finds by code.

**alpd will not start: `ALP_STATE_SCHEMA_TOO_NEW`.** A newer ALP wrote this state. Install
that version or a newer one (`npm i -g @anhlp/alp@<version>`), or see
[Downgrades](#downgrades) to replace it with older data on purpose.

**`ALP_STATE_SCHEMA_UNREADABLE`.** `state/schema.json` is damaged. ALP will not guess the
format. Restore a backup (`alp restore FILE`), which replaces it. If you know the state was
written by this version, you can instead write `{"schema": 2}` into the file yourself.

**`ALP_STATE_MIGRATION_FAILED`.** The pre-migration data was restored with the workspace
authority checks described above. The log names the cause and the pre-migration backup.
Free space, or fix permissions on
`$ALP_HOME/state`, and start alpd again.

**`ALP_STATE_MIGRATION_ROLLBACK_FAILED`.** The step failed, and putting the state back
failed too. The journal stays, and the next start runs the step again. If that keeps
failing, restore the backup the log names: `alp restore <pre-migrate backup>`.

**`ALP_RESTORE_JOURNAL_UNREADABLE`.** A restore was cut short and its journal is damaged.
Look in `$ALP_HOME` and in each project's `.alp` for:

- `*.pre-restore-<id>` entries: the data before the restore;
- `.restore-<id>` directories: the staged backup.

To keep the data you had, move each `*.pre-restore-<id>` back over its target. Then remove
the `.restore-<id>` directories and `restore-journal.json`. The automatic
`pre-restore-*.alpbackup` holds that same data.

**A restore was cut short** (`alp doctor`: `restore`). Nothing to do: the next
`alp restore` or alpd start rolls back an uncommitted restore, or finishes cleanup if it
already committed.

**A migration was cut short** (`alp doctor`: `migration`). Nothing to do: the next alpd
start continues it.

**You restored the wrong backup.** `alp restore $ALP_HOME/backups/pre-restore-<time>.alpbackup`
restores the saved data with the same workspace authority checks: owners remain, but old
checkout birth certifications and historical grants do not return. Reapprove host mappings
and arrange audited adoption before mutating or deleting old targets.

**Sessions or tasks deleted by mistake.**

- Restore the last backup, with `--dry-run` first to see what it replaces.
- Tasks are also in git when the project commits `.alp/tasks`:
  `git checkout <commit> -- .alp/tasks`.

**An unreadable session record** (`alp doctor`: `state`). alpd skips the record and leaves
it on disk. Restore it from a backup, or remove it once you no longer need it.

**A new machine, or a lost disk.**

1. Install ALP.
2. Copy the backup over and run `alp restore FILE`.
3. To resume sessions natively, copy `~/.codex` and `~/.claude` (or wherever `CODEX_HOME`
   and Claude's config point) too.
4. Run `alp daemon install` again: the service definition names this machine's paths.
5. Trust projects again if their paths changed.

## Limits

- alpd does not fsync. A power cut or a failing disk can lose or tear the most recent
  writes (ALPD §66). Backups are your protection against that.
- A backup is consistent for alpd's state and for each project's tasks, which it reads
  under their lock. It is not consistent with the providers' own files.
- Restores are for the same projects at the same paths. Moving a project elsewhere is not
  something a restore does.
