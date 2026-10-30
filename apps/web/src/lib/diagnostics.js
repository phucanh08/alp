// @ts-check
/**
 * Settings › Diagnostics: what this browser knows about the app and its connection, as plain
 * text to copy into a bug report. Built from named fields only (never the whole state), so the
 * access token, prompts and host paths beyond the gateway address cannot reach it. Host-side
 * details (providers, logs) come from `alp doctor` on the host.
 */

/**
 * @typedef {{
 *   version: string,
 *   connection: { phase: string, gateway: string, attempt: number, daemonVersion?: string, hostname?: string, capabilities: string[] },
 *   principal?: { id?: string, label?: string, permissions?: string[], modes?: string[] | null, workspaces?: string[] } | null,
 *   preferences: { theme: string, contentWidth: string, toolCalls: string, sendBehavior: string },
 *   browser?: { userAgent?: string, language?: string, online?: boolean, secure?: boolean, viewport?: string, colorScheme?: string },
 *   now?: Date,
 * }} DiagnosticsInput
 */

/** @param {DiagnosticsInput} input @returns {Array<{ title: string, rows: Array<[string, string]> }>} */
export function diagnosticsSections({ version, connection, principal, preferences, browser = {} }) {
  const yesNo = (/** @type {boolean | undefined} */ value) => value === undefined ? 'unknown' : value ? 'yes' : 'no';
  const list = (/** @type {string[] | undefined | null} */ values) => values?.length ? [...values].sort().join(', ') : 'none';
  return [
    { title: 'App', rows: [
      ['Version', `ALP web v${version}`],
      ['Theme', preferences.theme],
      ['Content width', preferences.contentWidth],
      ['Tool calls', preferences.toolCalls],
      ['Default send', preferences.sendBehavior],
    ] },
    { title: 'Browser', rows: [
      ['User agent', browser.userAgent ?? 'unknown'],
      ['Language', browser.language ?? 'unknown'],
      ['Online', yesNo(browser.online)],
      ['Secure context', yesNo(browser.secure)],
      ['Viewport', browser.viewport ?? 'unknown'],
      ['Color scheme', browser.colorScheme ?? 'unknown'],
    ] },
    { title: 'Connection', rows: [
      ['Gateway', connection.gateway],
      ['State', connection.phase === 'reconnecting' ? `reconnecting (attempt ${connection.attempt})` : connection.phase],
      ['Host', connection.hostname ?? 'unknown'],
      ['ALP on the host', connection.daemonVersion ?? 'unknown'],
      ['Capabilities', list(connection.capabilities)],
    ] },
    { title: 'Access token', rows: [
      ['Name', principal?.label ?? 'unknown'],
      ['Id', principal?.id ?? 'unknown'],
      ['Permissions', list(principal?.permissions)],
      ['Modes', principal?.modes ? list(principal.modes) : 'any'],
      ['Projects', String(principal?.workspaces?.length ?? 0)],
    ] },
  ];
}

/** The sections as one block of text, headed by the time it was taken. @param {DiagnosticsInput} input */
export function diagnosticsText(input) {
  const lines = [`ALP web diagnostics, ${(input.now ?? new Date()).toISOString()}`];
  for (const section of diagnosticsSections(input)) {
    lines.push('', `## ${section.title}`);
    for (const [key, value] of section.rows) lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}
