import { writablePath } from '../../tools/permission-path.ts';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { commandDecision, unwrapShell } from '@anhlp/alp-core/permissions';
import { alpHome } from '@anhlp/alp-core/library';

export type PermissionRules = {
  allow: string[]; ask?: string[]; deny: string[]; beyondMode?: 'refuse' | 'ask';
  /** The profile's base: a read-only profile stays away from the Paseo credentials even in a copy it may write. */
  base?: string;
  /** The OS sandbox ALP puts Bash in, and the directory it may write besides temp files. */
  floor?: 'read-only' | 'workspace-write'; floorRoot?: string;
};

export const WRITERS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
/** What ALP asks the user for a permission Claude would otherwise not have. */
export type PermissionRequest = { tool: string; input: Record<string, unknown>; reason: 'rule' | 'mode'; rule?: string };
export type PermissionAnswer = { allow: boolean; always?: boolean; message?: string };

/** The rule an "always allow" adds: Claude's own suggestion, else the exact command or path. */
export function suggestedRule(tool: string, input: Record<string, unknown>, suggestions: any) {
  const suggestion = (Array.isArray(suggestions) ? suggestions : []).find((entry: any) => entry?.type === 'addRules' && entry.behavior === 'allow' && entry.rules?.length);
  const rule = suggestion?.rules[0];
  if (rule?.toolName) return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
  if (tool === 'Bash' && typeof input.command === 'string' && !input.command.includes(')')) return `Bash(${input.command})`;
  if (typeof input.file_path === 'string' && !input.file_path.includes(')')) return `${tool}(${input.file_path})`;
  return undefined;
}

/**
 * The directory of the Paseo integration's token socket when `<home>/paseo/token.sock` is too long
 * for a socket address: `/tmp/alp-paseo-<uid>-<hash>`, as /tmp names it and as it resolves (macOS:
 * /private/tmp). Must match tokenSocketPath in integrations/paseo/server/web.ts and
 * paseoTokenSocketPath in packages/cli/src/commands/dashboard/paseo.ts. None on Windows (a named pipe).
 */
export function tokenSocketFallback(home: string, { platform = process.platform, uid = process.getuid?.() }: { platform?: NodeJS.Platform; uid?: number } = {}) {
  if (platform === 'win32' || Buffer.byteLength(path.join(home, 'paseo', 'token.sock')) < 100) return [];
  const name = `alp-paseo-${uid ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
  let tmp = '/tmp';
  try { tmp = realpathSync('/tmp'); } catch {}
  return [...new Set([path.posix.join('/tmp', name), path.posix.join(tmp, name)])];
}

/**
 * Where the Paseo integration keeps the user's credentials (t-cde5): its credential directory
 * `<home>/paseo/` (the password Paseo's app signs in with, and the relay's secret key), the /tmp
 * directory of its token socket for a long home, and the relay key's location before t-cde5. A
 * read-only session may not read them. Each path is given as ALP_HOME names it and, when that
 * differs (a symlinked home), as the filesystem resolves it.
 * @param home ALP's home (alpd's own by default)
 */
export function credentialPaths(home: string = alpHome()) {
  let real = home;
  try { real = realpathSync(home); } catch {}
  const homes = real === home ? [home] : [home, real];
  return {
    directories: [...new Set([...homes.map(each => path.join(each, 'paseo')), ...homes.flatMap(each => tokenSocketFallback(each))])],
    files: homes.map(each => path.join(each, 'relay-keypair.json')),
  };
}

/** An absolute path as a Claude permission rule spells it: `//` and the path, with `/c/…` for a Windows drive. */
const rulePath = (file: string) => `/${process.platform === 'win32' ? file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`) : file}`;

/**
 * The deny rules and sandbox read denials that keep a read-only Claude session away from the user's
 * Paseo credentials (t-cde5). Deny rules win over every allow rule, a user's broad `Read` included,
 * and Claude also applies Read denials to Grep, Glob and its sandbox's filesystem.
 */
export function credentialDenials(home?: string) {
  const { directories, files } = credentialPaths(home);
  return {
    rules: [...directories.map(directory => `Read(${rulePath(directory)}/**)`), ...files.map(file => `Read(${rulePath(file)})`)],
    denyRead: [...directories, ...files],
  };
}

/** Whether the platform's usual filesystems ignore case (macOS, Windows): there `~/.ALP/paseo` is `~/.alp/paseo`. */
export const caseInsensitive = (platform: NodeJS.Platform = process.platform) => platform === 'darwin' || platform === 'win32';

/**
 * Whether a command's text names one of the credential paths: as given, from the user's home as `~`,
 * or by the names only they use (`relay-keypair.json`, a `paseo/` directory beside the home's files),
 * in any case where the filesystem ignores it.
 * Text only: a command may still build a path at run time, which only the OS sandbox stops.
 */
export function namesCredential(command: string, paths: string[], platform: NodeJS.Platform = process.platform) {
  const home = os.homedir();
  const fold = caseInsensitive(platform) ? (text: string) => text.toLowerCase() : (text: string) => text;
  const spelled = paths.flatMap(file => [file, ...(file.startsWith(`${home}${path.sep}`) ? [`~${file.slice(home.length)}`, `$HOME${file.slice(home.length)}`] : [])]);
  const text = fold(command);
  return spelled.some(file => text.includes(fold(file))) || new RegExp(String.raw`relay-keypair\.json|(^|[\s'"=/])\.alp\/paseo(\/|[\s'"]|$)|\$\{?ALP_HOME\}?\/paseo\b`, caseInsensitive(platform) ? 'i' : '').test(command);
}

/** Claude's permission mode for an ALP mode; full-access skips every permission check. */
export const claudePermissionMode = (sandbox: string) => sandbox === 'read-only' ? 'default' : sandbox === 'full-access' ? 'bypassPermissions' : 'acceptEdits';

/** A Bash rule: `Bash` or `Bash(...)`. */
const BASH_RULE = /^\s*Bash\s*(?:\(|$)/;

export function claudePermissions(sandbox: string, currentSandbox?: () => string, rules?: PermissionRules | null, ask?: (request: PermissionRequest) => Promise<PermissionAnswer>, home?: string) {
  const readOnly = sandbox === 'read-only';
  // A session that starts read-only, runs Bash in a read-only floor or has a read-only profile (an
  // advisor working in a copy) cannot read the Paseo credentials (t-cde5).
  const secrets = readOnly || rules?.floor === 'read-only' || rules?.base === 'read-only' ? credentialDenials(home) : undefined;
  // A read-only profile never widens, so its Bash never leaves the sandbox (t-cde5 g2): outside it no
  // OS rule keeps the credentials, and Claude lets an allow rule's command out without asking canUseTool.
  // A session merely started read-only keeps the way out, which it needs once switched to full access.
  const confined = Boolean(rules?.floor && secrets && rules.base === 'read-only');
  // Except a command every part of which a checked allow rule covers (Bash(@…), such as the librarian's
  // public clone): ALP verifies it in commandDecision before it leaves (t-cde5 g4). Nothing else leaves.
  const checked = rules?.allow.filter(rule => /^Bash\(\s*@/.test(rule.trim())) ?? [];
  // Only a plain command line leaves: one a shell wrapper hides (sh -c '…') never does, whatever it covers.
  const checkedOnly = (command: string) => Boolean(rules && checked.length) && !/[\r\n\0]/.test(command) && unwrapShell(command) === command.trim() && commandDecision({ ...rules!, allow: checked }, command) === 'allow';
  // A skill only adds instructions; what they lead to is checked as itself (ALPD §59).
  const readers = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill'];
  return {
    // Plan mode permits writes to plan files and requires ExitPlanMode approval.
    // Fixed read-only callers restrict the tool surface; live sessions keep
    // tools available and consult the current sandbox at the permission gate.
    permissionMode: claudePermissionMode(sandbox),
    // Lets a live session switch to full-access later; it bypasses nothing by itself.
    allowDangerouslySkipPermissions: true,
    ...(readOnly && !currentSandbox ? { tools: [...readers, ...(rules?.floor === 'read-only' ? ['Bash'] : [])] } : {}),
    // Allow rules run without asking, even in a read-only session; deny rules hold even with full access.
    // Bash allow rules are not handed to Claude: it would match them as written, approve the call before
    // canUseTool and let it leave the sandbox, so `x/../y` and checked rules (Bash(@git-read <root>)) would
    // never reach commandDecision. canUseTool decides every Bash call by them instead.
    ...(rules?.allow.some(rule => !BASH_RULE.test(rule)) ? { allowedTools: rules.allow.filter(rule => !BASH_RULE.test(rule)) } : {}),
    disallowedTools: ['Agent', 'Task', 'TeamCreate', 'EnterPlanMode', 'ExitPlanMode', ...(rules?.deny ?? []), ...(secrets?.rules ?? [])],
    // Ask rules make Claude consult canUseTool in every mode, which asks the user.
    ...(rules?.ask?.length ? { settings: { permissions: { ask: rules.ask } } } : {}),
    // The floor: Bash runs in the OS sandbox, which writes only the workspace (or nothing, read-only) and temp files, offline.
    // Keep the SDK's restrictive host-network defaults. Broad Unix socket/localhost
    // access lets host services act outside this floor; the SDK cannot scope local
    // binding to a test server, and scoped Unix sockets are not portable to Linux.
    // A command leaves it only with dangerouslyDisableSandbox, which Claude refers to canUseTool: ALP's commandDecision decides it.
    // A confined session cannot leave it at all (Claude ignores the parameter), unless its profile has checked
    // allow rules: then only a command they cover leaves (canUseTool, below).
    ...(rules?.floor ? {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: !confined || checked.length > 0,
        ...(rules.floor === 'read-only' && rules.floorRoot ? { filesystem: { denyWrite: [rules.floorRoot], ...(secrets ? { denyRead: secrets.denyRead } : {}) } }
          : secrets ? { filesystem: { denyRead: secrets.denyRead } } : {}),
      },
    } : {}),
    canUseTool: async (name: string, input: Record<string, unknown>, context?: { decisionReasonType?: string; suggestions?: unknown }) => {
      const mode = currentSandbox ? currentSandbox() : sandbox;
      // A confined session's command runs in the sandbox whatever it asks, unless checked allow rules cover all of it: decide it as sandboxed.
      if (confined && name === 'Bash' && 'dangerouslyDisableSandbox' in input && !(input.dangerouslyDisableSandbox === true && typeof input.command === 'string' && checkedOnly(input.command))) input = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'dangerouslyDisableSandbox'));
      const leaving = Boolean(rules?.floor) && name === 'Bash' && input.dangerouslyDisableSandbox === true;
      // A Bash allow rule inside the sandbox too, as Claude's allowedTools did (it never gets them; see above).
      // Only allow is decided here: what a sandboxed command may do otherwise is unchanged.
      // A checked deny rule (Bash(@git-unsafe)) holds there too: Claude matches deny rules as written, so only ALP can
      // apply it. Plain deny rules stay Claude's own, as before, so a profile with only those keeps running in the
      // sandbox what it ran before (a command ALP cannot split, such as `echo $(date)`, is not refused for them).
      const checkedDeny = Boolean(rules?.deny.some(rule => /^Bash\(\s*@/.test(rule.trim())));
      const inside = name === 'Bash' && !leaving && typeof input.command === 'string' && rules && (rules.allow.length || checkedDeny) ? commandDecision(rules, input.command as string) : undefined;
      if (inside === 'deny' && checkedDeny) return { behavior: 'deny', message: 'A deny rule of your permission profile covers it' };
      if (inside === 'allow') return { behavior: 'allow', updatedInput: input };
      // Inside a read-only floor the OS keeps Bash from writing, so it may run.
      const sandboxed = rules?.floor === 'read-only' && name === 'Bash' && !leaving;
      const beyond = (mode === 'read-only' && !readers.includes(name) && !name.startsWith('mcp__alp__') && !sandboxed) ||
        // With a floor, file tools write only the workspace and temp files, like Bash.
        (Boolean(rules?.floor && rules.floorRoot) && WRITERS.includes(name) && !writablePath(name === 'NotebookEdit' ? input.notebook_path : input.file_path, rules!.floorRoot!)) ||
        (leaving && mode !== 'full-access');
      // Outside the sandbox nothing denies the credentials' paths: a command that names one is refused (best effort, by its text).
      if (leaving && secrets && typeof input.command === 'string' && namesCredential(input.command, secrets.denyRead)) {
        return { behavior: 'deny', message: 'A read-only session may not read the Paseo credentials' };
      }
      if (leaving && typeof input.command === 'string' && rules) {
        const decision = commandDecision(rules, input.command);
        if (decision === 'deny') return { behavior: 'deny', message: 'A deny rule of your permission profile covers it' };
        if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
        if (decision === 'ask' && ask) context = { ...context, decisionReasonType: 'rule' };
      }
      const reason = context?.decisionReasonType === 'rule' && (rules?.ask?.length || leaving) ? 'rule' : beyond && rules?.beyondMode === 'ask' ? 'mode' : undefined;
      if (reason && ask) {
        const rule = reason === 'mode' ? suggestedRule(name, input, context?.suggestions) : undefined;
        const answer = await ask({ tool: name, input, reason, ...(rule ? { rule } : {}) });
        if (!answer.allow) return { behavior: 'deny', message: answer.message ?? 'The user did not allow it' };
        const [, toolName, ruleContent] = /^([^(]+)(?:\((.*)\))?$/s.exec(rule ?? '') ?? [];
        // The read-only floor would refuse the very write the user just allowed: run that command outside it (unless confined).
        const approved = sandboxed && reason === 'rule' && !confined ? { ...input, dangerouslyDisableSandbox: true } : input;
        // A confined session gets no native allow rule: Claude would let a command it matches leave the sandbox unchecked.
        return { behavior: 'allow', updatedInput: approved, ...(answer.always && toolName && !(confined && toolName === 'Bash') ? { updatedPermissions: [{ type: 'addRules', rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }], behavior: 'allow', destination: 'session' }] } : {}) };
      }
      if (leaving && beyond) return { behavior: 'deny', message: 'Bash runs inside the sandbox; leaving it needs an allow rule in your permission profile' };
      if (beyond) return { behavior: 'deny', message: mode === 'read-only' ? 'ALP session is read-only' : 'Outside your workspace' };
      return { behavior: 'allow', updatedInput: input };
    },
  };
}
