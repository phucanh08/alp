import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BrowserKeyboardPolicy } from "./features/browser-keyboard/index.js";
import type { DesktopWindowChromeMode } from "./window/chrome.js";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.alpDesktop undefined (the 0.1.108 regression, #2103). Keep this literal in sync
// with ALP_BROWSER_PROFILE_PARTITION in features/browser-profile.ts; preload-sandbox.test.ts
// guards both the no-local-import rule and this drift. Type-only imports are fine (erased at emit).
const ALP_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";

type EventHandler = (payload: unknown) => void;

function readWindowChromeMode(): DesktopWindowChromeMode {
  const prefix = "--alp-window-chrome-mode=";
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === "native-mac" || value === "custom-windows" || value === "custom-linux") {
    return value;
  }
  // COMPAT(windowChromeMode): added in v0.5.3; remove after 2026-11-25.
  if (process.platform === "darwin") return "native-mac";
  return process.platform === "linux" ? "custom-linux" : "custom-windows";
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

contextBridge.exposeInMainWorld("alpDesktop", {
  platform: process.platform,
  windowChromeMode: readWindowChromeMode(),
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("alp:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("alp:get-pending-open-project") as Promise<string | null>,
  agentNavigation: {
    ready: () =>
      ipcRenderer.invoke("alp:agent-navigation:ready") as Promise<{
        serverId: string;
        agentId: string;
      } | null>,
  },
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`alp:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`alp:event:${event}`, listener);
      });
    },
  },
  window: {
    openNew: (options?: { pendingOpenProjectPath?: string | null }) =>
      ipcRenderer.invoke("alp:window:openNew", options),
    getCurrentWindow: () => ({
      minimize: () => ipcRenderer.invoke("alp:window:minimize"),
      close: () => ipcRenderer.invoke("alp:window:close"),
      toggleMaximize: () => ipcRenderer.invoke("alp:window:toggleMaximize"),
      isMaximized: () => ipcRenderer.invoke("alp:window:isMaximized"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("alp:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("alp:window:isFullscreen"),
      updateChrome: (update: { backgroundColor?: string; trafficLightOffsetY?: number }) =>
        ipcRenderer.invoke("alp:window:updateChrome", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("alp:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("alp:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("alp:window:setBadgeCount", count),
    }),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("alp:dialog:ask", message, options),
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("alp:dialog:askWithCheckbox", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("alp:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("alp:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("alp:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("alp:opener:openUrl", url),
  },
  editor: {
    listTargets: () => ipcRenderer.invoke("alp:editor:listTargets"),
    openTarget: (input: {
      editorId: string;
      workspacePath: string;
      filePath?: string;
      line?: number;
      column?: number;
    }) => ipcRenderer.invoke("alp:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("alp:menu:showContextMenu", input),
    setCapturingShortcut: (capturing: boolean) =>
      ipcRenderer.invoke("alp:menu:set-capturing-shortcut", capturing),
  },
  browser: {
    setShortcutPolicy: (input: BrowserKeyboardPolicy) =>
      ipcRenderer.invoke("alp:browser:set-shortcut-policy", input),
    profilePartition: ALP_BROWSER_PROFILE_PARTITION,
    registerAttachedBrowser: (input: AttachedBrowserRegistration) =>
      ipcRenderer.invoke("alp:browser:register-attached", input),
    unregisterWorkspaceBrowser: (browserId: string) =>
      ipcRenderer.invoke("alp:browser:unregister-workspace-browser", browserId),
    setWorkspaceActiveBrowser: (input: { workspaceId: string; browserId: string | null }) =>
      ipcRenderer.invoke("alp:browser:set-workspace-active-browser", input),
    focus: (browserId: string) => ipcRenderer.invoke("alp:browser:focus", browserId),
    openDevTools: (browserId: string) => ipcRenderer.invoke("alp:browser:open-devtools", browserId),
    clearProfile: (legacyBrowserIds: string[]) =>
      ipcRenderer.invoke("alp:browser:clear-profile", legacyBrowserIds),
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("alp:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("alp:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("alp:browser:copy-element", payload),
  },
});
