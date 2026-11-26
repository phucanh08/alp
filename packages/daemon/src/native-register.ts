// The native alpd (t-81b0.9, scripts/build-alpd-native.ts): registers this process as the native
// alpd before alpd's own modules load (native-entry.ts imports this first). The Claude Agent SDK is
// imported here by its literal name so the build embeds it in the executable; claude-transport.ts
// reaches it through this registration instead of its computed import.
import { bundleDist, bundleInfo, registerNativeDaemon } from '@anhlp/alp-core/packaged';

declare const __ALP_VERSION__: string;
// `alpd --version` answers before alpd loads, so install.sh, alp update and the build can check that this
// executable runs on the machine without starting a daemon.
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write(`${typeof __ALP_VERSION__ === 'string' ? __ALP_VERSION__ : '0.0.0-dev'}\n`);
  process.exit(0);
}
// The bundle is read once at start: a later reinstall of the same version moves this directory aside.
const bundle = bundleInfo();

registerNativeDaemon({
  modules: { claudeAgentSdk: () => import('@anthropic-ai/claude-agent-sdk') },
  // The terminal helper (native-terminal.ts) lies in the bundle's @anhlp/alp-cli dist, not beside alpd.
  distDir: () => bundle ? bundleDist(bundle) : undefined,
});
