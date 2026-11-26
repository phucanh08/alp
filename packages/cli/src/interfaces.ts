// The package's `./interfaces` subpath, kept for compatibility: `alp dashboard` lives in
// commands/dashboard/ and `alp acp` in commands/acp/. The processes they start are elsewhere:
// alp-dashboard in dashboard/ (the browser UI it serves is apps/web), the ACP agent in acp/.
export { dashboardCommand } from './commands/dashboard/index.ts';
export { pairCommand, requestPairing } from './commands/dashboard/pair.ts';
export { startPaseoIntegration, paseoTokenSocketPath, readPaseoToken } from './commands/dashboard/paseo.ts';
export { registerProject } from './commands/dashboard/start.ts';
export { acpCommand } from './commands/acp/index.ts';
