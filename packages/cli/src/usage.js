
import path from 'node:path';

const USAGE = `Usage:
  alp <init|update-template> [directory]   create a project, or upgrade an older project's ALP template (upgrade is an alias)
  alp update [--check] [--yes] [--version X]   update the ALP executable from GitHub Releases (checksum and provenance checked)
  alp --version
  alp setup [directory] [--runtime codex|claude|mix] [--prefer claude|codex]
            [--claude-model M] [--codex-model M] [--claude-supervisor M] [--codex-supervisor M]
            [--claude-oracle M] [--codex-oracle M]   write Phở/Cafe's agent profiles to .alp/settings.json
  alp daemon <start|stop|restart>
  alp daemon status [--json]             liveness and readiness; exit 0 ready, 3 not running, 4 not ready
  alp daemon <install|uninstall>         run alpd as a login service that restarts after a crash
  alp daemon run [--detach] [--service]  run alpd in this process (what services and the ALP executable start)
  alp acp                                serve ALP to an editor (Zed, JetBrains) over the Agent Client Protocol on stdio
  alp web [--print]                      open the ALP web app on this machine (alp-web, loopback); --print only prints its address
  alp web serve [--service|--rotate] [--project DIR]   run alp-web in this process (what alp web starts)
  alp bridge <acp|antigravity>           the stdio MCP bridge an agent CLI starts to reach alpd (internal)
  alp web rotate                         give alp web a new token: open pages lose access; prints the new address
  alp web pair [--on|--off]              the link that pairs Paseo's app on another device through the relay; --on or --off turns the relay on or off
  alp terminal <allow [--paseo] --yes|deny [--paseo]|status> [--json]   remote terminals (a shell as you on this host; a workspace is not a sandbox), off by default
  alp doctor [--project DIR] [--fix] [--json]   check this machine and project; --fix repairs what is safe to
  alp backup [-o FILE] [--project DIR]... [--no-projects] [--stop] [--json]   sessions, settings, library and tasks in one file
  alp backup verify <file> [--json] | alp backup list [--json]
  alp restore <file> [--home-only] [--dry-run] [--stop] [--replace-newer] [--json]   checks the whole backup first; keeps what it replaces
            alpd must be stopped for both; --stop stops it and starts it again after
  alp run [--agent A] [--team pho|cafe|ID] [--model M] [--mode read-only|workspace-write|full-access] [--thinking T] [--project DIR] [--json] <prompt>
  alp schedule create --session ID --at ISO_WITH_OFFSET --prompt TEXT [--project DIR] [--json]
  alp schedule list [--status pending|delivered|failed|cancelled] [--project DIR] [--json]
  alp schedule <show|cancel> ID [--project DIR] [--json]   one-shot wake; timer gates only unblock tasks
  alp ps [--all]
  alp top [session] [--once]
  alp attach <session> [--json]
  alp send <session> [--prompt] [--json] <text>
            child default: user mail; --prompt: explicit new prompt to a live root or child
  alp questions [--json]
  alp answer <question> <text> | alp answer <question> --dismiss [--reason R]
  alp log <session> [--json]
  alp board [--project DIR] [--json]
  alp <agents|skills|mcp|hooks> [--project DIR] [--json]   the library: built-in, ~/.alp and project entries
  alp providers [--json]                    ACP and Antigravity providers in your library
  alp teams [--project DIR] [--json]         teams sessions run in: members, delegation, house rules
  alp agent <new|edit> <name> [--project [DIR]] [--from A] [-d text] [--provider P] [--model M] [--thinking T] [--mode M]
            [--skills a,b] [--mcp a,b] [--hooks a,b] [--instructions FILE]
  alp team <new|edit> <id> [--project [DIR]] [--from ID] [--label L] [-d text] [--main A] [--member name=role]...
            [--member-model name=M]... [--member-thinking name=T]... [--delegate owner=a,b]... [--max-peers N]
            [--supervisor A] [--supervisor-model M] [--supervisor-thinking T] [--no-supervisor] [--rules FILE]
  alp skill new <name> [--project [DIR]] [--from S] [--file FILE]
  alp mcp add <name> [--project [DIR]] (--command C [--arg A]... [--env K=V]... [--cwd D] | --url U [--header K=V]...)
  alp hook add <name> [--project [DIR]] --event E --command C [--blocking] [--timeout SEC] [--match-agent A] [--match-label L]
  alp provider add <id> --command C [--arg A]... [--env K=V]... [--label L] [-d text] [--models a,b]   an ACP agent; use id antigravity for native agy
  alp provider edit antigravity --read-only-mode instructions|reject   legacy, no effect: agy enforces every mode itself
  alp <agent|team|skill|mcp|hook|provider> <rm|show> <name> [--project [DIR]] | <cp|mv> <from> <to> [--project [DIR]]
  alp <mcp|hook|provider> test <name> [--project [DIR]]   list an MCP server's tools; run a hook once; initialize a provider
            without --project, changes go to your library in ~/.alp; built-in agents and teams are never changed
  alp trust [--project DIR] | --revoke [--project DIR] | --list [--json]   whether the project's hooks may run
  alp permissions [--project DIR] [--json]   each agent's permission profile
  alp permissions check <agent> "<command>"  what that agent's profile says about a command
  alp tasks [ready] [--all] [--status S] [--label L] [--project DIR] [--json]
  alp tasks gates [--json]                 open gates; checks GitHub ones
  alp tasks compact [--days 30] [--dry-run]
  alp tasks export [-o file.jsonl]          as beads JSONL
  alp tasks import [file.jsonl] [--dry-run]  beads JSONL; default .beads/issues.jsonl
  alp formula list | show <name> | pour <name> [--var k=v]... [--parent ID] [--dry-run]
  alp task add <title> [-d text] [-p 0-4] [-t task|bug|feature|chore|epic] [--parent ID] [--after ID]... [-l label]... [--path P]... [--from ID]
  alp task show <id> [--json]
  alp task report <epic> [--json]           what an epic came to: tasks, time, rework, verification
  alp task edit <id> [--title T] [-d text] [-p N] [-t type] [-l label]... [--path P]... [-m note]
  alp task close <id> [--reason done|wontfix|duplicate|superseded] [-m summary] [--unverified "why"]
  alp verify [--project DIR] [--task ID] [--json]   run the project's verify commands; --task records the result
  alp task reopen <id> [-m note]
  alp task dep <add|rm> <id> [--after ID]... [--parent ID] [--related ID]...
  alp task gate add <id> --human "question" [--option answer]... | --timer +2h|ISO | --pr N|owner/repo#N | --run N|owner/repo#N
  alp task gate clear <id> <gate> [--choice answer] [-m note]   approve; main is told by mail
  alp task gate reject <id> <gate> [-m reason]   the gate stays open; main is told by mail
  alp task gate rm <id> <gate> [-m note]
  alp pause [codex|claude] [--now] [-m reason] | alp pause status   hold delegation; --now parks running assignments
  alp resume [codex|claude]                  lift a pause; parked assignments continue
  alp models [--refresh] [--json]            the models alpd offers now, from each provider (cached; refreshed every 6 h)
  alp language [name | --reset]              the language agents and ALP write to you in; default Vietnamese
  alp recall <assignment|task> [--project DIR] [--json] <question>   ask a finished assignment about its work
  alp interrupt <session>
  alp compact <session>`;

class UsageError extends Error {}

export { USAGE, UsageError };
