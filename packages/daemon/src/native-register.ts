// The native alpd (t-81b0.9, scripts/build-alpd-native.mjs): registers this process as the native
// alpd before alpd's own modules load (native-entry.ts imports this first). The Claude Agent SDK is
// imported here by its literal name so the build embeds it in the executable; claude-transport.ts
// reaches it through this registration instead of its computed import.
import { bundleDist, bundleInfo, registerNativeDaemon } from '@anhlp/alp-core/packaged';

registerNativeDaemon({
  modules: { claudeAgentSdk: () => import('@anthropic-ai/claude-agent-sdk') },
  // The terminal helper (native-terminal.ts) lies in the bundle's @anhlp/alp-cli dist, not beside alpd.
  distDir: () => { const bundle = bundleInfo(); return bundle ? bundleDist(bundle) : undefined; },
});
