import { AGENT_MARKER } from '@anhlp/alp-core/tasks';
import { CodexTransport } from './transport.js';
import { ClaudeTransport } from './claude-transport.js';
import { AcpTransport, type AcpProvider } from './acp-transport.js';
import { AntigravityTransport, type AntigravityProvider } from './antigravity-transport.js';
import type { RuntimeKind } from './resolve.js';
import type { RuntimeOptions, RuntimeTransport } from './contracts.js';

/** The environment a native harness starts with: the host's, without variables that would tie it to the host's own agent session. */
export function nativeEnvironment(options: RuntimeOptions, extra: Record<string, string> = {}) {
  const environment: NodeJS.ProcessEnv = { ...(options.environment ?? process.env), ...extra };
  for (const key of Object.keys(environment)) {
    // Markers of an enclosing Paseo, Codex or Claude Code session would make the native harness think it is nested.
    if (/^(PASEO_|CODEX_THREAD_ID$|CODEX_INTERNAL_|CODEX_PARENT_|CLAUDECODE$|CLAUDE_CODE_|ANTHROPIC_AGENT_)/.test(key)) delete environment[key];
  }
  // Every process the agent runs inherits it: the CLI and alpd refuse it what only the user may do (t-ca1f).
  environment[AGENT_MARKER] = '1';
  return environment;
}

/** Provider factories adapt native harnesses to ALP's normalized transport contract. */
export type ProviderContext = {
  options: RuntimeOptions;
  runtime: RuntimeKind;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  acp?: AcpProvider;
  antigravity?: AntigravityProvider;
};
export type ProviderFactory = (context: ProviderContext) => RuntimeTransport;
export type ProviderFactories = Partial<Record<RuntimeKind, ProviderFactory>>;

/** Explicit registry: each runtime instance can override adapters without global state. */
export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  constructor(factories: Record<string, ProviderFactory | undefined> = {}) {
    for (const [id, factory] of Object.entries(factories)) if (factory) this.register(id, factory);
  }

  register(id: string, factory: ProviderFactory): this {
    if (!id.trim()) throw new Error('A provider needs an id');
    this.factories.set(id, factory);
    return this;
  }

  create(id: string, context: ProviderContext): RuntimeTransport {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`Unknown runtime provider: ${id}`);
    return factory(context);
  }

  has(id: string): boolean { return this.factories.has(id); }
  list(): string[] { return [...this.factories.keys()]; }
}

export function createProviderRegistry(overrides: ProviderFactories = {}): ProviderRegistry {
  return new ProviderRegistry({
    codex: ({ options, cwd, environment }) => new CodexTransport(
      options.codexCommand ?? process.env.ALP_CODEX_BIN ?? 'codex', cwd, environment),
    claude: ({ options, cwd, environment }) => new ClaudeTransport(
      options.claudeCommand ?? process.env.ALP_CLAUDE_BIN ?? 'claude', cwd, environment),
    acp: ({ acp, cwd, environment }) => {
      if (!acp) throw new Error('An ACP session needs its provider');
      return new AcpTransport(acp, cwd, environment);
    },
    antigravity: ({ options, antigravity, cwd, environment }) => new AntigravityTransport(
      options.antigravityCommand ?? process.env.ALP_ANTIGRAVITY_BIN ?? antigravity?.command ?? 'agy',
      cwd, environment, antigravity),
    ...Object.fromEntries(Object.entries(overrides).filter(([, factory]) => factory !== undefined)),
  });
}

export function createTransport(
  options: RuntimeOptions,
  runtimeKind: RuntimeKind,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  acp?: AcpProvider,
  antigravity?: AntigravityProvider,
): RuntimeTransport {
  // Preserve the existing test/custom host hook and its positional argument contract.
  if (options.transport) return options.transport(cwd, environment, runtimeKind, acp, antigravity);
  const registry = options.providerRegistry ?? createProviderRegistry(options.providers);
  const providerId = runtimeKind === 'acp' && acp && registry.has(`acp:${acp.id}`) ? `acp:${acp.id}` : runtimeKind;
  return registry.create(providerId, { options, runtime: runtimeKind, cwd, environment, acp, antigravity });
}
