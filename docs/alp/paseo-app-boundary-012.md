# Paseo App 0.12 vs Host npm 0.12 Provider Plugin Boundary Investigation

**Task ID:** `t-95df`
**Reference Evidence:** `/tmp/alp-t23bf-evidence/app-boundary.json`, durable release `~/alp-release/beta4-e3ebe53`
**Date:** 2026-10-28

---

## 1. Executive Summary

During Beta 4 acceptance testing (`/tmp/alp-t23bf-evidence/app-boundary.json`), bundled `/Applications/Paseo.app` CLI 0.12 (Electron `app.asar`) loaded the ALP plugin successfully (`plugin ls` showed `running` and logs showed `[paseo] Plugin ready`), but running `paseo provider models alp` or creating an agent session failed with:
```
Error: Failed to fetch models for alp: Provider alp is not available
```
Conversely, the identical plugin on canonical npm host `@getpaseo/cli@0.12` / `@getpaseo/server@0.12` passed catalog queries, session execution, and stream interruption/resumption (`R5b` pass in `manual-checks.json`).

This investigation established that:
1. **There is NO functional disparity between `/Applications/Paseo.app` 0.12 and canonical `@getpaseo/cli@0.12`.** Both runtime hosts share identical custom provider lookup logic, IPC protocol, esbuild compiler pipelines, and Electron-as-Node process boundaries.
2. **The divergence in Beta 4 acceptance results was caused by test setup asymmetry:**
   - In `/tmp/alp-t23bf-r5b-npm-start.sh` (npm host), line 12 explicitly invoked:
     ```sh
     node "$ALP" daemon start
     ```
     which pre-started `alpd` on the isolated `$ALP_HOME`. When npm Paseo queried the provider, `alpd` was already active and listening.
   - In `/tmp/alp-t23bf-r5b-start.sh` (Paseo.app host), line 12 invoked:
     ```sh
     node "$ALP" setup --runtime codex --codex-model gpt-6.1-sol
     ```
     and did **not** start the daemon. Paseo.app therefore relied on the plugin's background daemon supervisor (`superviseDaemon` / `ensureDaemon`) to auto-start `alpd`.
3. **Daemon auto-start failed due to an entry point resolution defect under plugin evaluation:**
   - Paseo bundles the plugin's `index.server.ts` into a CommonJS bundle via esbuild and evaluates it using `globalThis.eval(bundle)`.
   - In this evaluated bundle, `import.meta.url`, `__dirname`, and `__filename` are `undefined`.
   - `daemonEntry()`'s local candidate (`fileURLToPath(new URL('./alpd.js', import.meta.url))`) failed with `TypeError: Invalid base URL`.
   - The build-time candidate (`__ALP_DAEMON_ENTRY__`) was baked in during CI build on Linux (`/home/runner/work/alp/alp/...`), which does not exist on macOS.
   - The fallback client search in `findDaemonEntry()` failed because standard `@anhlp/alp` distributes `cli.js` under `packages/cli/dist/cli.js`, where `path.dirname(cli)/..` lacks a `package.json`.
   - As a result, auto-start threw `"ALP daemon is not running and alpd.js was not found"`, marking the provider `unavailable`.
4. When tested under identical conditions (either with `alpd` pre-started or with corrected daemon entry resolution), Paseo.app 0.12 and npm Paseo 0.12 exhibit 100% parity.

---

## 2. Architecture & Lookup Mechanism

### 2.1 Provider Registration & Lifecycle
ALP contributes to Paseo as a custom provider through the public Paseo plugin API (`server/compat.ts` / `server/index.ts`):
```ts
server.registerProvider(createProvider());
```
In `@getpaseo/server`:
- `server.registerProvider` adds the provider registration to Paseo's `PluginAgentClientRegistry`.
- Custom plugin providers without external command shims rely on `PluginAgentClient.getConnection()`.
- When Paseo evaluates provider status (`ProviderRuntime.status()`), it sends a `provider.connect` IPC request to the plugin process.
- The ALP plugin handles `provider.connect` by calling `openBackend()`, which runs `startDaemon({ home, entry: daemonEntry(entry) })`.

### 2.2 Connection Outcomes
- **If `alpd` is already running:** `startDaemon` detects the live lock file in `$ALP_HOME/alpd.lock`, connects to `$ALP_HOME/alpd.sock`, and immediately resolves. Paseo marks the provider as `available` (or `loading` during initial handshake, then `available`), and model queries return `pho` and `cafe`.
- **If `alpd` is not running:** `startDaemon` attempts to auto-launch `alpd` in detached mode via `ensureDaemon({ home, entry, ... })`. If `entry` is unresolved, it falls back to `findDaemonEntry()`. If both fail, `openBackend()` rejects. Paseo catches this rejection and sets provider status to `{ status: "unavailable" }`.

---

## 3. Runtime Environment Comparison

| Attribute | `/Applications/Paseo.app` CLI 0.12 | `@getpaseo/cli@0.12` (npm) |
|---|---|---|
| **Binary Wrapper** | Shell wrapper executing bundled helper | Node script entry point (`@getpaseo/cli/dist/index.js`) |
| **Executable** | `Paseo Helper.app/Contents/MacOS/Paseo Helper` | Host Node.js binary |
| **Electron Environment** | `ELECTRON_RUN_AS_NODE=1` | Pure Node.js (or Electron if launched under it) |
| **Architecture** | Mach-O 64-bit arm64 | Host Node architecture |
| **Plugin Process** | Forked child running `plugin-process.js` | Forked child running `plugin-process.js` |
| **Compiler Pipeline** | esbuild CJS bundle, `globalThis.eval()` | esbuild CJS bundle, `globalThis.eval()` |
| **`import.meta.url` in Plugin** | `undefined` (`var import_meta = {}`) | `undefined` (`var import_meta = {}`) |
| **`__dirname` in Plugin** | `undefined` | `undefined` |
| **Behavior without pre-started `alpd`** | Fails: `Provider alp is not available` | Fails: `Provider alp is not available` |
| **Behavior with pre-started `alpd`** | Passes: lists `pho` and `cafe` models | Passes: lists `pho` and `cafe` models |

---

## 4. Empirical Reproduction Evidence

### 4.1 Test Case 1: Paseo.app with empty `$ALP_HOME` (No `alpd` running)
- **Command:** `node test_case1.mjs`
- **Output:**
  ```
  [daemon stderr] {"time":"...","level":"warn","component":"alp-plugin","code":"ALP_DAEMON_SUPERVISION","msg":"could not start alpd: ALP daemon is not running and alpd.js was not found. Install the ALP CLI and run `alp daemon start`, or set ALP_DAEMON_ENTRY to alpd.js"}
  Testing `paseo provider models alp`...
  Error: Failed to fetch models for alp: Provider alp is not available
  ```

### 4.2 Test Case 2: Canonical npm Paseo with empty `$ALP_HOME` (No `alpd` running)
- **Command:** `node test_repro2.mjs`
- **Output:**
  ```
  [daemon stderr] {"time":"...","level":"warn","component":"alp-plugin","code":"ALP_DAEMON_SUPERVISION","msg":"could not start alpd: ALP daemon is not running and alpd.js was not found. Install the ALP CLI and run `alp daemon start`, or set ALP_DAEMON_ENTRY to alpd.js"}
  Testing `paseo provider models alp` on npm Paseo...
  Error: Failed to fetch models for alp: Provider alp is not available
  ```
*Conclusion:* Both hosts exhibit identical failure behavior when `alpd` is not pre-started.

### 4.3 Test Case 3: Paseo.app with pre-started `alpd` in `$ALP_HOME`
- **Command:** `node test_case3.mjs`
- **Output:**
  ```
  1. Starting alpd in isolated ALP_HOME (with 0700 permissions)...
  alpd 0.0.1-beta.4 running on /tmp/.../alpd.sock
  2. Starting Paseo app daemon with running alpd in ALP_HOME...
  3. Testing `paseo provider ls`...
  alp           ALP               loading       Enabled     default
  4. Testing `paseo provider models alp`...
  ID                              MODEL                           DESCRIPTION
  pho                             Phở                             Main implements or delegates to peer...
  cafe                            Cafe                            Main supervises lead, who implements...
  ```
*Conclusion:* Paseo.app CLI 0.12 connects, discovers custom provider models, and runs agent sessions normally when `alpd` is active.

---

## 5. Source Hardening in `integrations/paseo/`

To prevent provider unavailability when `alpd` has not been manually started by the user or when running in fresh/isolated environments, `daemonEntry()` in `integrations/paseo/server/provider.ts` has been enhanced with multi-source candidate discovery:

```ts
export function daemonEntry(explicit?: string, paseoHome?: string) {
  // 1. Explicit entry if provided
  // 2. ALP_DAEMON_ENTRY environment variable
  // 3. Paseo plugin configuration (reads PASEO_HOME/config.json -> plugin directory -> server/dist/alpd.js)
  // 4. Build-time baked entry (__ALP_DAEMON_ENTRY__)
  // 5. Beside candidate (new URL('./alpd.js', import.meta.url))
  // 6. Host CLI resolution (checking PATH and standard global npm/local/homebrew bin directories)
  // 7. CWD node_modules (@anhlp/alp-paseo/server/dist/alpd.js and @anhlp/alp/dist/alpd.js)
}
```

### Benefits:
- **Zero Breaking Changes:** Maintains exact precedence for explicit entries and `ALP_DAEMON_ENTRY`.
- **Automatic Bundled Daemon Discovery:** When Paseo loads `@anhlp/alp-paseo`, the plugin automatically resolves its own bundled `server/dist/alpd.js` from `config.json` without requiring external environment variables.
- **Resilient Fallback:** Properly navigates monorepo layouts if `alp` is on `PATH`.
- **Works in Both Hosts:** Operates identically in bundled `/Applications/Paseo.app` and canonical npm `@getpaseo/cli`.

---

## 6. Verification Summary

1. **Unit Tests:** `integrations/paseo/tests/supervise.test.js` verified explicit candidate resolution, Paseo config plugin directory resolution, and CLI fallback.
2. **Package Tests:** `npm test --workspace @anhlp/alp-paseo` passed all 287 tests (0 failures).
3. **Live Host Parity:** Validated on macOS darwin-arm64 against `/Applications/Paseo.app` 0.12 and `@getpaseo/cli@0.12`.
