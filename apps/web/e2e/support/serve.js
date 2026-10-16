#!/usr/bin/env node
// Starts a disposable ALP host (alpd + fake Codex + gateway, temp home) and the built web app, and
// prints where to open it and the tokens to paste: for trying the app by hand or taking
// screenshots. Ctrl-C stops everything and deletes the temporary home.
//   node apps/web/e2e/support/serve.js [--real]
import { startWorld } from './world.js';

const world = await startWorld({ provider: process.argv.includes('--real') ? 'real' : 'fake' });
console.log(JSON.stringify({ web: world.webUrl, gateway: world.gatewayUrl, tokens: world.tokens, project: world.projects.main, directory: world.directory }, null, 2));
const stop = async () => { await world.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
