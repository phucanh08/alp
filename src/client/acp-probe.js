import { stdioSession } from './mcp-probe.js';

/**
 * Starts an ACP provider once and runs initialize (ALPD §46), for `alp provider test`
 * and the settings screen. It reports who the agent says it is and what it supports;
 * a provider that needs a login usually says so here, in authMethods. With `discover`,
 * it also opens a session in `cwd`, as Paseo does, to read the models and modes the agent
 * offers (ALPD §65); an agent that offers none leaves them out.
 * @param {{ command: string, args?: string[], env?: Record<string, string>, label?: string, id?: string }} provider
 * @param {{ cwd?: string, timeoutMs?: number, discover?: boolean }} [options]
 * @returns {Promise<{ protocolVersion: number, agent?: { name?: string, title?: string, version?: string }, loadSession: boolean, mcpHttp: boolean, authMethods: string[],
 *   models?: Array<{ id: string, label: string, description?: string }>, currentModel?: string, modes?: Array<{ id: string, label: string, description?: string }>, currentMode?: string }>}
 */
export async function probeAcp(provider, { cwd, timeoutMs = 20_000, discover = false } = {}) {
  const session = stdioSession({ command: provider.command, args: provider.args ?? [], env: provider.env ?? {} }, cwd, timeoutMs);
  try {
    const result = await session.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'alp', title: 'ALP', version: '1' },
    });
    if (result.protocolVersion !== 1) throw new Error(`${provider.label ?? provider.id} speaks ACP version ${result.protocolVersion}; ALP speaks version 1`);
    const info = result.agentInfo;
    const offered = discover ? await session.request('session/new', { cwd, mcpServers: [] }) : undefined;
    const choices = list => Array.isArray(list) ? list.filter(item => typeof (item?.modelId ?? item?.id) === 'string')
      .map(item => ({ id: item.modelId ?? item.id, label: typeof item.name === 'string' && item.name ? item.name : item.modelId ?? item.id, ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}) })) : undefined;
    const config = offered?.configOptions?.find(option => option.category === 'model' && option.type === 'select');
    const modeConfig = offered?.configOptions?.find(option => option.category === 'mode' && option.type === 'select');
    const flatten = options => options?.flatMap(option => option.options ?? [option]).map(option => ({ ...option, id: option.value }));
    const modelState = offered?.models ?? (config ? { availableModels: flatten(config.options), currentModelId: config.currentValue } : undefined);
    const modeState = offered?.modes ?? (modeConfig ? { availableModes: flatten(modeConfig.options), currentModeId: modeConfig.currentValue } : undefined);
    const models = choices(modelState?.availableModels);
    const modes = choices(modeState?.availableModes);
    return {
      ...(models ? { models, ...(typeof modelState.currentModelId === 'string' ? { currentModel: modelState.currentModelId } : {}) } : {}),
      ...(modes ? { modes, ...(typeof modeState.currentModeId === 'string' ? { currentMode: modeState.currentModeId } : {}) } : {}),
      protocolVersion: result.protocolVersion,
      ...(info ? { agent: { ...(info.name ? { name: info.name } : {}), ...(info.title ? { title: info.title } : {}), ...(info.version ? { version: info.version } : {}) } } : {}),
      loadSession: Boolean(result.agentCapabilities?.loadSession),
      mcpHttp: Boolean(result.agentCapabilities?.mcpCapabilities?.http),
      authMethods: (result.authMethods ?? []).map(method => method?.name ?? method?.id).filter(Boolean),
    };
  } finally {
    await session.close();
  }
}
