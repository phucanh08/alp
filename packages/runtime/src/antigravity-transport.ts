import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { openMcpTools } from './mcp-tools.js';
import { antigravityToolDetail } from './tool-detail.js';
import { bridgeCommand, isBridgeArgs } from '@anhlp/alp-core/bridges';

/**
 * Antigravity provider definition for ALP.
 */
export type AntigravityProvider = {
  id: string;
  label: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  models?: Array<{ id: string; label?: string; description?: string }>;
  additionalModels?: Array<{ id: string; label?: string; description?: string }>;
  enabled?: boolean;
  /** Explicit opt-in: read-only is a prompt constraint, never a native sandbox. */
  readOnlyMode?: 'instructions' | 'reject';
};

type Listener = (method: string, params: any) => void;
type RequestHandler = (method: string, params: any) => Promise<unknown>;

/** The MCP server ALP's tools reach an Antigravity agent through via local socket. */

const MODES = ['read-only', 'workspace-write', 'full-access'];
/**
 * Commands read-only allows. agy matches an allow rule by command prefix and denies
 * redirection, chaining and substitution itself (checked with agy 1.4.10), so each
 * entry must have no flag that writes: git is left out (`git log --output`, and
 * `git status` refreshes the index), as are rg (`--pre`) and find (`-delete`).
 * A prefix rule cannot check a path or a flag, so no command that reads file contents
 * is allowed: cat, head, grep and wc read files outside the workspace, and tail -f or a
 * read of a FIFO hangs the turn. agy's own file reading and search tools remain.
 */
const READ_ONLY_COMMANDS = ['pwd', 'ls'];
/** Shell syntax that makes a command line more than one allowed command. */
const SHELL_SYNTAX = /[;&|<>`$(){}\\\n\r]/;
/**
 * Whether read-only allows a terminal command line, by ALP's own reading of the allowlist:
 * one allowed command with no shell syntax. Unknown input is refused.
 */
export function antigravityReadOnlyCommandAllowed(commandLine: unknown): boolean {
  if (typeof commandLine !== 'string' || SHELL_SYNTAX.test(commandLine)) return false;
  const [command] = commandLine.trim().split(/\s+/);
  return READ_ONLY_COMMANDS.includes(command);
}
const COMMAND_TOOLS = new Set(['run_command']);
/** agy's file-editing tools, which read-only always denies. */
const EDIT_TOOLS = new Set(['write_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit']);
const modeOf = (sandbox: unknown) => sandbox === 'danger-full-access' ? 'full-access' : String(sandbox);

/**
 * The agy flags for an ALP mode. Headless agy cannot ask the user, so a tool its
 * permission mode does not allow is denied: both limited modes fail closed.
 * - read-only: agy's default request-review policy; built-in reads and search run,
 *   READ_ONLY_COMMANDS run; edits and every other command are denied.
 * - workspace-write: edits accepted and commands run in agy's terminal sandbox,
 *   which keeps writes in the workspace; a bypass of the sandbox is denied.
 * - full-access: every tool runs without asking.
 * Both limited modes trust the working directory (otherwise agy denies even its
 * reads and edits there) and allow ALP's own MCP server, which carries alp_*.
 */
export function antigravityModeArgs(sandbox: unknown, cwd: string): string[] {
  const mode = modeOf(sandbox);
  if (mode === 'full-access') return ['--dangerously-skip-permissions'];
  if (!MODES.includes(mode)) throw new Error(`Antigravity does not support mode '${String(sandbox)}'`);
  let real = cwd;
  try { real = realpathSync(cwd); } catch {}
  const settings = {
    toolPermission: mode === 'workspace-write' ? 'proceed-in-sandbox' : 'request-review',
    enableTerminalSandbox: true,
    trustedWorkspaces: [...new Set([cwd, real])],
    permissions: { allow: ['mcp(alp/*)', ...(mode === 'read-only' ? READ_ONLY_COMMANDS.map(command => `command(${command})`) : [])] },
  };
  return [...(mode === 'workspace-write' ? ['--mode', 'accept-edits'] : []), '--sandbox', '--settings', JSON.stringify(settings)];
}

/** What each mode lets an Antigravity agent do, for its instructions. */
export function antigravityModeText(sandbox: unknown): string {
  const mode = modeOf(sandbox);
  if (mode === 'read-only') return 'agy enforces read-only: its own file reading and search tools work, and ALP\'s tools; it allows only the terminal commands pwd and ls, with no redirection or chaining (read files with its own tools), and denies every file edit and other command. A denied tool ends your turn, so do not attempt one: report work that needs changes to your requester.';
  if (mode === 'workspace-write') return 'agy accepts file edits and runs terminal commands in its sandbox, which writes only inside your workspace; anything outside the workspace or the sandbox is denied, and a denied tool ends your turn. Report work that needs more to your requester.';
  return 'Antigravity runs with full access: every tool runs without asking.';
}

export function encodePrompt(text: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: text } })}\n`;
}

/**
 * AntigravityTransport runs the Antigravity CLI (agy) over its stream-json protocol.
 * Emits line-delimited JSON events and parses stdout line by line.
 */
export class AntigravityTransport {
  /** Antigravity's prompt is one line of text: no images. */
  takesImages() { return false; }
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private exit: Promise<void> = Promise.resolve();
  private listeners = new Set<Listener>();
  private failures = new Set<(error: Error) => void>();
  private requestHandler?: RequestHandler;
  private closed = false;
  private conversationId = '';
  private config: any;
  private activeTurn?: string;
  private messageText = new Map<string, string>();
  private messages = 0;
  private instructionsSent = false;
  private modeNote?: string;
  private tools: Array<{ name: string; description: string; inputSchema?: unknown }> = [];
  private bridge?: { server: net.Server; socket: string; token: string; connections: Set<net.Socket> };
  private readyPromise?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private external?: Awaited<ReturnType<typeof openMcpTools>>;
  private externalStarting?: ReturnType<typeof openMcpTools>;
  private readonly startupAbort = new AbortController();

  constructor(
    private readonly command: string = 'agy',
    private readonly cwd: string = process.cwd(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly provider?: AntigravityProvider,
  ) {}

  async initialize(): Promise<void> {
    if (/\.(cmd|bat|ps1)$/i.test(this.command)) {
      throw new Error('Antigravity command must be a native executable, not a shell launcher');
    }
  }

  onNotification(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  async request(method: string, params: any): Promise<any> {
    if (this.closed) throw new Error('Runtime is closed');

    if (method === 'thread/start' || method === 'thread/resume') {
      antigravityModeArgs(params.sandbox, params.cwd || this.cwd);
      this.config = params;
      this.tools = params.dynamicTools ?? [];

      try {
        if (Object.keys(params.mcpServers ?? {}).length) {
          this.externalStarting = openMcpTools(params.mcpServers, params.cwd || this.cwd, { ...this.env, ...this.provider?.env, ...params.env }, this.startupAbort.signal);
          const external = await this.externalStarting;
          if (this.closed) { await external.close(); throw new Error('Runtime is closed'); }
          this.external = external;
        }
        if (this.tools.length > 0 || this.external?.tools.length) await this.openBridge();
        if (this.closed) throw new Error('Runtime is closed');
        await this.startProcess(params);
      } catch (error) { await this.close(); throw error; }

      return {
        thread: { id: this.conversationId, turns: [] },
        cwd: params.cwd,
        model: params.model,
        reasoningEffort: params.thinking,
      };
    }

    if (method === 'turn/start') {
      if (!this.conversationId) throw new Error('Antigravity session is not open');
      if (!this.child) await this.startProcess({ ...this.config, threadId: this.conversationId });
      if (this.activeTurn) throw new Error('Antigravity already has an active turn');

      const turnId = randomUUID();
      this.activeTurn = turnId;
      this.messageText.clear();

      const parts = (params.input ?? [])
        .filter((part: any) => typeof part?.text === 'string')
        .map((part: any) => part.text);
      let promptText = parts.join('\n\n');

      if (this.modeNote) {
        promptText = `${this.modeNote}\n\n${promptText}`;
        this.modeNote = undefined;
      }
      if (!this.instructionsSent && this.config?.developerInstructions) {
        promptText = `Instructions from ALP, which runs you. Follow them for this whole session.\n\n${this.config.developerInstructions}\n\n${promptText}`;
        this.instructionsSent = true;
      }

      setImmediate(() => {
        try {
          this.child?.stdin.write(encodePrompt(promptText));
        } catch (error) {
          this.endTurn(turnId, 'failed', error instanceof Error ? error.message : String(error));
        }
      });

      return { turn: { id: turnId } };
    }

    if (method === 'turn/steer') {
      throw new Error('Antigravity takes no messages during a turn; ALP delivers them when it ends');
    }

    if (method === 'turn/interrupt') {
      if (this.child && this.activeTurn) {
        const turnId = this.activeTurn;
        await this.stopProcess();
        this.endTurn(turnId, 'interrupted');
      }
      return {};
    }

    if (method === 'session/configure' || method === 'thread/delete') {
      if (method === 'session/configure' && params.sandbox && this.config && modeOf(params.sandbox) !== modeOf(this.config.sandbox)) {
        antigravityModeArgs(params.sandbox, this.config.cwd || this.cwd);
        if (this.activeTurn) throw new Error('Antigravity changes mode between turns only');
        // agy takes its mode at launch: the next turn resumes the conversation in a process with the new one.
        this.config = { ...this.config, sandbox: params.sandbox };
        this.modeNote = `ALP changed your permission mode to ${modeOf(params.sandbox)}. ${antigravityModeText(params.sandbox)}`;
        await this.stopProcess();
      }
      return {};
    }

    throw new Error(`Antigravity does not support '${method}'`);
  }

  private startProcess(params: any): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Runtime is closed'));
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const args = [
      ...(this.provider?.args ?? []),
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--add-dir',
      params.cwd || this.cwd,
      '--disable-slash-commands',
      ...antigravityModeArgs(params.sandbox, params.cwd || this.cwd),
    ];

    if (params.model) {
      args.push('--model', params.model);
    }

    if (params.threadId) {
      args.push('--conversation', params.threadId);
    }

    const env: NodeJS.ProcessEnv = {
      ...this.env,
      ...(this.provider?.env ?? {}),
      ...(params.env ?? {}),
      // Provider or session env never sheds the agent mark (t-ca1f).
      ...(this.env.ALP_AGENT_SESSION ? { ALP_AGENT_SESSION: this.env.ALP_AGENT_SESSION } : {}),
      // Session credentials are inherited by this agy's MCP child only, never persisted.
      ALP_BRIDGE_SOCKET: this.bridge?.socket ?? '',
      ALP_BRIDGE_TOKEN: this.bridge?.token ?? '',
    };

    const child = spawn(this.command, args, {
      cwd: params.cwd || this.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    this.exit = new Promise(resolve => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });

    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });

    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => {
      const err = new Error(`Antigravity did not start: ${error.message}`);
      if (this.rejectReady) this.rejectReady(err);
      this.fail(err);
    });

    child.on('close', code => {
      const msg = stderr.trim() || `Antigravity exited (${code})`;
      if (!this.closed && this.child === child) {
        const error = new Error(msg);
        if (this.rejectReady) this.rejectReady(error);
        if (this.activeTurn) {
          this.endTurn(this.activeTurn, 'failed', msg);
        }
        this.fail(error);
      }
    });

    const lines = createInterface({ input: child.stdout, terminal: false });
    this.lines = lines;
    lines.on('line', line => this.receiveLine(line));

    const startupTimeout = setTimeout(() => {
      if (this.rejectReady) {
        const error = new Error('Antigravity did not initialize within 30 seconds');
        this.rejectReady(error);
        this.fail(error);
      }
    }, 30_000);

    return this.readyPromise.finally(() => clearTimeout(startupTimeout));
  }

  private receiveLine(line: string): void {
    if (!line.trim() || this.closed) return;
    if (line.length > 10 * 1024 * 1024) {
      this.fail(new Error('Antigravity frame exceeds 10MB limit'));
      return;
    }

    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }

    if (frame.event === 'init') {
      this.conversationId = frame.conversation_id || frame.init?.conversation_id || randomUUID();
      if (this.resolveReady) {
        this.resolveReady();
        this.resolveReady = undefined;
        this.rejectReady = undefined;
      }
      return;
    }

    if (frame.event === 'step_update') {
      this.handleStepUpdate(frame.step_update);
      return;
    }

    if (frame.event === 'result') {
      this.handleResult(frame.result);
      return;
    }
  }

  private handleStepUpdate(step: any): void {
    if (!step || !this.activeTurn) return;

    if (step.step_type === 'agent_response') {
      const itemId = `agy-msg-${this.activeTurn}-${step.step_index ?? this.messages}`;
      const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
      if (delta) {
        this.messageText.set(itemId, (this.messageText.get(itemId) ?? '') + delta);
        this.emit('item/agentMessage/delta', {
          threadId: this.conversationId,
          itemId,
          delta,
        });
      }

      if (step.state === 'DONE' && this.messageText.has(itemId)) {
        this.emit('item/completed', {
          threadId: this.conversationId,
          item: { type: 'agentMessage', id: itemId, text: this.messageText.get(itemId) },
        });
      }

      if (step.state === 'DONE') { this.messageText.delete(itemId); this.messages++; }

      if (step.usage && typeof step.usage === 'object') {
        const inTokens = step.usage.input_tokens || 0;
        const outTokens = step.usage.output_tokens || 0;
        const cachedTokens = step.usage.cache_read_tokens || 0;
        const total = inTokens + outTokens;
        const last = { totalTokens: total, inputTokens: inTokens, outputTokens: outTokens };
        this.emit('thread/tokenUsage/updated', {
          threadId: this.conversationId,
          turnId: this.activeTurn,
          tokenUsage: {
            last,
            total: last,
            ...(cachedTokens ? { cachedInputTokens: cachedTokens } : {}),
          },
        });
      }
      return;
    }

    if (step.step_type === 'tool') {
      const toolName = step.tool_name || 'tool';
      const callId = `agy-tool-${this.activeTurn}-${step.step_index ?? ++this.messages}`;

      // The command stays the tool's name, as the journal reads it; the typed detail rides along.
      const detail = antigravityToolDetail(step.tool_info ?? { name: toolName });
      const typed = { tool: typeof step.tool_info?.name === 'string' && step.tool_info.name ? step.tool_info.name : toolName, detail };
      if (step.state === 'ACTIVE') {
        this.emit('item/started', {
          threadId: this.conversationId,
          item: {
            type: 'commandExecution',
            id: callId,
            command: toolName,
            cwd: this.cwd,
            status: 'inProgress',
            aggregatedOutput: '',
            ...typed,
          },
        });
      } else if (step.state === 'DONE' || step.state === 'ERROR') {
        // agy 1.4.10 sometimes marks a tool step it denied DONE, with no error and nothing run. ALP's own
        // record is authoritative: read-only denies every edit and every command outside its allowlist,
        // so never report one as done, whatever agy says.
        if (step.state === 'DONE' && modeOf(this.config?.sandbox) === 'read-only' && this.readOnlyRefuses(toolName, step.tool_info)) {
          step = { ...step, state: 'ERROR', tool_info: { ...step.tool_info, output: undefined, error: { message: `Antigravity denied ${typed.tool} in read-only mode` } } };
        }
        const output = typeof step.tool_info?.output === 'string'
          ? step.tool_info.output
          : step.tool_info?.error?.message || '';
        this.emit('item/completed', {
          threadId: this.conversationId,
          item: {
            type: 'commandExecution',
            id: callId,
            command: toolName,
            cwd: this.cwd,
            status: step.state === 'DONE' ? 'completed' : 'failed',
            exitCode: step.state === 'DONE' ? 0 : 1,
            aggregatedOutput: output,
            ...typed,
            ...(step.state === 'ERROR' ? { error: step.tool_info?.error?.message } : {}),
          },
        });
      }
    }
  }

  /** Whether read-only refuses this tool step: an edit, or a terminal command outside the allowlist. */
  private readOnlyRefuses(toolName: string, info: any): boolean {
    const name = typeof info?.name === 'string' && info.name ? info.name : toolName;
    if (EDIT_TOOLS.has(toolName) || EDIT_TOOLS.has(name)) return true;
    if (COMMAND_TOOLS.has(toolName) || COMMAND_TOOLS.has(name)) return !antigravityReadOnlyCommandAllowed(info?.parameters?.CommandLine);
    return false;
  }

  private handleResult(result: any): void {
    if (!this.activeTurn) return;
    const turnId = this.activeTurn;

    if (!result || typeof result !== 'object') { this.endTurn(turnId, 'failed', 'Invalid Antigravity result'); return; }
    if (result.status === 'ERROR') {
      const isInterrupted = result.error === 'interrupted';
      this.endTurn(turnId, isInterrupted ? 'interrupted' : 'failed', result.error);
    } else {
      // Headless agy cannot ask, so it denies a tool the mode does not allow and ends the turn, often with no answer: say so.
      const denied = Array.isArray(result.denied_actions) ? result.denied_actions.map((action: any) => String(action?.display_name || action?.action || '')).filter(Boolean) : [];
      if (denied.length) {
        const text = `Antigravity denied ${[...new Set(denied)].join(', ')} in ${modeOf(this.config?.sandbox)} mode and ended the turn.`;
        this.emit('item/completed', { threadId: this.conversationId, item: { type: 'agentMessage', id: `agy-denied-${turnId}`, text } });
      }
      this.endTurn(turnId, 'completed');
    }
  }

  private endTurn(turnId: string, status: 'completed' | 'interrupted' | 'failed', error?: string): void {
    if (this.activeTurn !== turnId) return;
    this.activeTurn = undefined;

    setImmediate(() => {
      this.emit('turn/completed', {
        threadId: this.conversationId,
        turn: {
          id: turnId,
          status,
          ...(status === 'failed' ? { error: { message: error || 'Antigravity turn failed' } } : {}),
        },
      });

    });
  }

  private async openBridge(): Promise<void> {
    if (this.bridge) return;

    const token = randomBytes(16).toString('hex');
    const name = `alp-agy-${randomBytes(6).toString('hex')}`;
    const socket = process.platform === 'win32'
      ? `\\\\.\\pipe\\${name}`
      : path.join(os.tmpdir(), `${name}.sock`);
    const connections = new Set<net.Socket>();

    const server = net.createServer(connection => {
      connections.add(connection);
      connection.once('close', () => connections.delete(connection));
      this.serveBridge(connection, token);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => resolve());
    });

    this.bridge = { server, socket, token, connections };

    // Register into ~/.gemini/config/mcp_config.json
    await this.registerMcpServer();
  }

  /** One stable launcher; each child inherits its own socket/token from agy.
   * No session endpoint or credential is written to the global configuration.
   * Leave the launcher installed: removing it would break concurrent sessions.
   */
  private async registerMcpServer(): Promise<void> {
    const configFile = this.env.ALP_AGY_MCP_CONFIG ?? path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
    await mkdir(path.dirname(configFile), { recursive: true });
    const lockFile = `${configFile}.alp-lock`;
    let lock;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { lock = await open(lockFile, 'wx', 0o600); break; }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!lock) throw new Error(`Antigravity MCP configuration is locked: ${lockFile}`);
    const temporary = `${configFile}.${randomUUID()}.tmp`;
    try {
      let text = '{}';
      try { text = await readFile(configFile, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      const config = JSON.parse(text);
      if (!config || typeof config !== 'object' || Array.isArray(config) ||
          (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
        throw new Error('Invalid Antigravity MCP configuration; existing file was preserved');
      }
      config.mcpServers ??= {};
      const existing = config.mcpServers.alp;
      if (existing && !isBridgeArgs('antigravity', existing.args, existing.command)) {
        throw new Error('Antigravity already has an MCP server named alp; rename it before using ALP');
      }
      const launcher = { ...bridgeCommand('antigravity'), ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}) };
      if (JSON.stringify(existing) === JSON.stringify(launcher)) return;
      config.mcpServers.alp = launcher;
      await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, configFile);
    } finally {
      await unlink(temporary).catch(() => {});
      await lock.close();
      await unlink(lockFile);
    }
  }

  private serveBridge(connection: net.Socket, token: string): void {
    let trusted = false;
    connection.setEncoding('utf8');
    connection.on('error', () => {});
    const reply = (value: unknown) => {
      if (!connection.destroyed) connection.write(`${JSON.stringify(value)}\n`);
    };

    createInterface({ input: connection }).on('line', async line => {
      let message: any;
      try { message = JSON.parse(line); } catch { connection.destroy(); return; }
      if (!trusted) {
        if (message.token !== token) { connection.destroy(); return; }
        trusted = true;
        return;
      }
      if (message.op === 'list') {
        reply({
          id: message.id,
          tools: [...this.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema ?? { type: 'object' },
          })), ...(this.external?.tools ?? [])],
        });
        return;
      }
      if (message.op === 'call') {
        reply({
          id: message.id,
          result: await this.toolCall(String(message.name), message.arguments ?? {}),
        });
      }
    });
  }

  private async toolCall(tool: string, args: Record<string, unknown>): Promise<any> {
    if (this.activeTurn && this.external?.has(tool)) {
      const callId = `agy-mcp-tool-${randomUUID()}`;
      const item = { type: 'dynamicToolCall', id: callId, callId, tool, arguments: args };
      this.emit('item/started', { threadId: this.conversationId, item: { ...item, status: 'inProgress' } });
      const result = await this.external.call(tool, args).catch(() => ({ content: [{ type: 'text', text: `External MCP tool '${tool}' failed` }], isError: true }));
      const ok = result.isError !== true;
      this.emit('item/completed', {
        threadId: this.conversationId,
        item: { ...item, status: ok ? 'completed' : 'failed', success: ok, contentItems: (Array.isArray(result.content) ? result.content : []).map(part => ({ type: 'inputText', text: part.type === 'text' ? part.text : JSON.stringify(part) })) },
      });
      return result;
    }
    if (!this.requestHandler || !this.activeTurn || !this.tools.some(t => t.name === tool)) {
      return {
        content: [{ type: 'text', text: this.activeTurn ? `Unknown ALP tool '${tool}'` : 'ALP tools are unavailable between turns' }],
        isError: true,
      };
    }

    const callId = `agy-alp-tool-${randomUUID()}`;
    const item = { type: 'dynamicToolCall', id: callId, callId, tool, arguments: args };
    this.emit('item/started', { threadId: this.conversationId, item: { ...item, status: 'inProgress' } });

    const result: any = await this.requestHandler('item/tool/call', {
      threadId: this.conversationId,
      turnId: this.activeTurn,
      callId,
      namespace: null,
      tool,
      arguments: args,
    }).catch(error => ({
      success: false,
      contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }],
    }));

    const ok = result?.success !== false;
    this.emit('item/completed', {
      threadId: this.conversationId,
      item: { ...item, status: ok ? 'completed' : 'failed', success: ok, contentItems: result?.contentItems ?? [] },
    });

    return {
      content: (result?.contentItems ?? []).map((part: any) => ({ type: 'text', text: part.text ?? JSON.stringify(part) })),
      isError: !ok,
    };
  }

  private emit(method: string, params: any): void {
    for (const listener of this.listeners) listener(method, params);
  }

  /** agy exits on SIGINT. Ignore that expected exit; the next prompt resumes its conversation in a fresh process. */
  private async stopProcess(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.lines?.close();
    const kill = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      } else child.kill(signal);
    };
    kill('SIGINT');
    const timer = setTimeout(() => kill('SIGKILL'), 1500);
    try { await this.exit; } finally { clearTimeout(timer); }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    for (const listener of this.failures) listener(error);
    void this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return this.exit;
    this.closed = true;

    this.listeners.clear();
    this.failures.clear();
    this.startupAbort.abort();
    await this.externalStarting?.then(external => external.close(), () => {});
    await this.external?.close();

    if (this.bridge) {
      this.bridge.server.close();
      for (const connection of this.bridge.connections) connection.destroy();
      if (process.platform !== 'win32') {
        try { rmSync(this.bridge.socket, { force: true }); } catch {}
      }
    }

    if (this.lines) {
      this.lines.close();
    }

    const child = this.child;
    if (!child) return;

    try { child.stdin.end(); } catch {}

    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, 1500);

    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exit,
        new Promise<void>(resolve => { deadline = setTimeout(resolve, 4000); }),
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
    }
  }
}
