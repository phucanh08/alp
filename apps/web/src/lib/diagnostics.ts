/**
 * Settings › Diagnostics: what this browser knows about the app and its connection, as plain
 * text to copy into a bug report. Built from named fields only (never the whole state), so the
 * access token, prompts and host paths beyond the gateway address cannot reach it. Host-side
 * details (providers, logs) come from `alp doctor` on the host.
 */

export type DiagnosticsInput = {
  version: string;
  connection: { phase: string; gateway: string; attempt: number; daemonVersion?: string; hostname?: string; capabilities: string[]; };
  principal?: { id?: string; label?: string; permissions?: string[]; modes?: string[] | null; workspaces?: string[]; } | null;
  preferences: { theme: string; contentMaxWidth: number | null | 'full'; chatDisplay: string; sendBehavior: string; };
  browser?: { userAgent?: string; language?: string; online?: boolean; secure?: boolean; viewport?: string; colorScheme?: string; };
  now?: Date;
};

export function diagnosticsSections({ version, connection, principal, preferences, browser = {} }: DiagnosticsInput): Array<{ title: string; rows: Array<[string, string]>; }> {
  const yesNo = (value: boolean | undefined) => value === undefined ? 'unknown' : value ? 'yes' : 'no';
  const list = (values: string[] | undefined | null) => values?.length ? [...values].sort().join(', ') : 'none';
  return [
    { title: 'App', rows: [
      ['Version', `ALP web v${version}`],
      ['Theme', preferences.theme],
      ['Content width', preferences.contentMaxWidth === null ? 'default' : preferences.contentMaxWidth === 'full' ? 'full' : `${preferences.contentMaxWidth}px`],
      ['Chat display', preferences.chatDisplay],
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

/** The sections as one block of text, headed by the time it was taken. */
export function diagnosticsText(input: DiagnosticsInput) {
  const lines = [`ALP web diagnostics, ${(input.now ?? new Date()).toISOString()}`];
  for (const section of diagnosticsSections(input)) {
    lines.push('', `## ${section.title}`);
    for (const [key, value] of section.rows) lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}
