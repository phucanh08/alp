// The package's `./interfaces` subpath, kept for compatibility: `alp dashboard` lives in
// commands/dashboard/ and `alp acp` in commands/acp/. The processes they start are elsewhere:
// alp-dashboard in dashboard/ (the browser UI it serves is apps/web), the ACP agent in acp/.
export { dashboardCommand } from './commands/dashboard/index.js';
export { pairCommand, requestPairing } from './commands/dashboard/pair.js';
export { startPaseoIntegration, paseoTokenSocketPath, readPaseoToken } from './commands/dashboard/paseo.js';
export { registerProject } from './commands/dashboard/start.js';
export { acpCommand } from './commands/acp/index.js';
