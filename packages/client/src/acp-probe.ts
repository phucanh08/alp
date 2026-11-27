import { stdioSession } from './mcp-probe.ts';

/** An ACP provider as `alp provider test` and the settings screen start it. */
export type AcpProvider = { command: string, args?: string[], env?: Record<string, string>, label?: string, id?: string };
/** A model or mode an ACP agent offers. */
export type AcpChoice = { id: string, label: string, description?: string };
/** What probeAcp reports about an ACP agent. */
export type AcpProbe = { protocolVersion: number, agent?: { name?: string, title?: string, version?: string }, loadSession: boolean, mcpHttp: boolean, authMethods: string[],
  models?: AcpChoice[], currentModel?: string, modes?: AcpChoice[], currentMode?: string };
/** The parts of an ACP initialize result this probe reads. */
type AcpInitialize = { protocolVersion?: unknown, agentInfo?: { name?: string, title?: string, version?: string }, agentCapabilities?: { loadSession?: unknown, mcpCapabilities?: { http?: unknown } }, authMethods?: Array<{ name?: string, id?: string } | null> };
/** A session config option of ACP: a select's options may be grouped. */
type AcpConfigOption = { category?: string, type?: string, value?: unknown, currentValue?: unknown, options?: AcpConfigOption[] };
/** The parts of an ACP session/new result this probe reads. */
type AcpSessionNew = { configOptions?: AcpConfigOption[], models?: { availableModels?: unknown, currentModelId?: unknown }, modes?: { availableModes?: unknown, currentModeId?: unknown } };

/**
 * Starts an ACP provider once and runs initialize (ALPD §46), for `alp provider test`
 * and the settings screen. It reports who the agent says it is and what it supports;
 * a provider that needs a login usually says so here, in authMethods. With `discover`,
 * it also opens a session in `cwd`, as Paseo does, to read the models and modes the agent
 * offers (ALPD §65); an agent that offers none leaves them out.
 */
export async function probeAcp(provider: AcpProvider, { cwd, timeoutMs = 20_000, discover = false, signal }: { cwd?: string, timeoutMs?: number, discover?: boolean, signal?: AbortSignal } = {}): Promise<AcpProbe> {
  signal?.throwIfAborted();
  const session = stdioSession({ command: provider.command, args: provider.args ?? [], env: provider.env ?? {} }, cwd, timeoutMs);
  let closing: Promise<void> | undefined;
  const abort = () => { closing ??= session.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result: AcpInitialize = await session.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'alp', title: 'ALP', version: '1' },
    });
    if (result.protocolVersion !== 1) throw new Error(`${provider.label ?? provider.id} speaks ACP version ${result.protocolVersion}; ALP speaks version 1`);
    const info = result.agentInfo;
    const offered: AcpSessionNew | undefined = discover ? await session.request('session/new', { cwd, mcpServers: [] }) : undefined;
    const choices = (list: unknown): AcpChoice[] | undefined => Array.isArray(list) ? list.filter(item => typeof (item?.modelId ?? item?.id) === 'string')
      .map(item => ({ id: item.modelId ?? item.id, label: typeof item.name === 'string' && item.name ? item.name : item.modelId ?? item.id, ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}) })) : undefined;
    const config = offered?.configOptions?.find(option => option.category === 'model' && option.type === 'select');
    const modeConfig = offered?.configOptions?.find(option => option.category === 'mode' && option.type === 'select');
    const flatten = (options: AcpConfigOption[] | undefined) => options?.flatMap(option => option.options ?? [option]).map(option => ({ ...option, id: option.value }));
    const modelState = offered?.models ?? (config ? { availableModels: flatten(config.options), currentModelId: config.currentValue } : undefined);
    const modeState = offered?.modes ?? (modeConfig ? { availableModes: flatten(modeConfig.options), currentModeId: modeConfig.currentValue } : undefined);
    const models = choices(modelState?.availableModels);
    const modes = choices(modeState?.availableModes);
    return {
      ...(models ? { models, ...(typeof modelState!.currentModelId === 'string' ? { currentModel: modelState!.currentModelId } : {}) } : {}),
      ...(modes ? { modes, ...(typeof modeState!.currentModeId === 'string' ? { currentMode: modeState!.currentModeId } : {}) } : {}),
      protocolVersion: result.protocolVersion as number,
      ...(info ? { agent: { ...(info.name ? { name: info.name } : {}), ...(info.title ? { title: info.title } : {}), ...(info.version ? { version: info.version } : {}) } } : {}),
      loadSession: Boolean(result.agentCapabilities?.loadSession),
      mcpHttp: Boolean(result.agentCapabilities?.mcpCapabilities?.http),
      authMethods: (result.authMethods ?? []).map(method => method?.name ?? method?.id).filter(Boolean) as string[],
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    await (closing ?? session.close());
    signal?.throwIfAborted();
  }
}
