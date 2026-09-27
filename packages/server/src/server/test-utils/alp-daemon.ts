import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import pino from "pino";
import {
  createAlpDaemon,
  type AlpDaemonConfig,
  type AlpOpenAIConfig,
  type AlpSpeechConfig,
} from "../bootstrap.js";
import type { AgentClient, AgentProvider } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "./fake-agent-client.js";
import type { PushNotificationSender } from "../push/index.js";
import type { AgentProfile } from "@alp/protocol/messages";

interface TestAlpDaemonOptions {
  daemonVersion?: string;
  desktopManaged?: boolean;
  downloadTokenTtlMs?: number;
  corsAllowedOrigins?: string[];
  listen?: string;
  logger?: Parameters<typeof createAlpDaemon>[1];
  mcpEnabled?: boolean;
  mcpDebug?: boolean;
  isDev?: boolean;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  daemonStatusRpcCapability?: boolean;
  relayConfigCapability?: boolean;
  agentClients?: Partial<Record<AgentProvider, AgentClient>>;
  providerOverrides?: AlpDaemonConfig["providerOverrides"];
  alpHomeRoot?: string;
  staticDir?: string;
  cleanup?: boolean;
  openai?: AlpOpenAIConfig;
  speech?: AlpSpeechConfig;
  voiceLlmProvider?: AlpDaemonConfig["voiceLlmProvider"];
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  auth?: AlpDaemonConfig["auth"];
  pushNotificationSender?: PushNotificationSender;
  serviceProxy?: AlpDaemonConfig["serviceProxy"];
  webUi?: AlpDaemonConfig["webUi"];
  trustedProxies?: AlpDaemonConfig["trustedProxies"];
  agentProfiles?: AgentProfile[];
  autoArchiveAfterMerge?: boolean;
  pluginsEnabled?: AlpDaemonConfig["pluginsEnabled"];
  plugins?: AlpDaemonConfig["plugins"];
}

export interface TestAlpDaemon {
  config: AlpDaemonConfig;
  daemon: Awaited<ReturnType<typeof createAlpDaemon>>;
  port: number;
  alpHome: string;
  staticDir: string;
  close: () => Promise<void>;
}

const TEST_DAEMON_START_TIMEOUT_MS = 20_000;

async function startDaemonWithTimeout(
  daemon: Awaited<ReturnType<typeof createAlpDaemon>>,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(
        `Timed out starting test daemon after ${timeoutMs}ms`,
      ) as Error & { code?: string };
      timeoutError.code = "TEST_DAEMON_START_TIMEOUT";
      reject(timeoutError);
    }, timeoutMs);

    daemon.start().then(
      () => {
        clearTimeout(timeoutHandle);
        resolve();
        return;
      },
      (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });
}

export async function createTestAlpDaemon(
  options: TestAlpDaemonOptions = {},
): Promise<TestAlpDaemon> {
  const maxAttempts = 8;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { config, alpHomeRoot, alpHome, staticDir } = await prepareTestDaemonConfig(options);
    const logger = options.logger ?? pino({ level: "silent" });
    const daemon = await createAlpDaemon(config, logger, {
      serverFeatureOverrides: {
        daemonStatusRpc: options.daemonStatusRpcCapability,
        relayConfig: options.relayConfigCapability,
      },
    });
    try {
      await startDaemonWithTimeout(daemon, TEST_DAEMON_START_TIMEOUT_MS);
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Test daemon did not expose a bound TCP listen target");
      }

      const close = async (): Promise<void> => {
        await daemon.stop().catch(() => undefined);
        await daemon.agentManager.flush().catch(() => undefined);
        if (options.cleanup ?? true) {
          await new Promise((r) => setTimeout(r, 50));
          await Promise.all([
            rm(alpHomeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
            rm(staticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
          ]);
        }
      };

      return {
        config,
        daemon,
        port: listenTarget.port,
        alpHome,
        staticDir,
        close,
      };
    } catch (error) {
      lastError = error;
      await daemon.stop().catch(() => undefined);
      await Promise.all([
        rm(alpHomeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
        rm(staticDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
      ]);

      if (
        (!isAddressInUseError(error) && !isStartupTimeoutError(error)) ||
        attempt === maxAttempts - 1
      ) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Failed to start test daemon");
}

interface PreparedTestDaemonConfig {
  config: AlpDaemonConfig;
  alpHomeRoot: string;
  alpHome: string;
  staticDir: string;
}

async function prepareTestDaemonConfig(
  options: TestAlpDaemonOptions,
): Promise<PreparedTestDaemonConfig> {
  const alpHomeRoot = options.alpHomeRoot ?? (await mkdtemp(path.join(os.tmpdir(), "alp-home-")));
  const alpHome = path.join(alpHomeRoot, ".alp");
  await mkdir(alpHome, { recursive: true });
  const staticDir = options.staticDir ?? (await mkdtemp(path.join(os.tmpdir(), "alp-static-")));
  const listenHost = options.listen ?? "127.0.0.1";
  const config: AlpDaemonConfig = {
    listen: `${listenHost}:0`,
    alpHome,
    daemonVersion: options.daemonVersion,
    desktopManaged: options.desktopManaged,
    corsAllowedOrigins: options.corsAllowedOrigins ?? [],
    hostnames: true,
    mcpEnabled: options.mcpEnabled ?? true,
    staticDir,
    mcpDebug: options.mcpDebug ?? false,
    isDev: options.isDev,
    agentClients: options.agentClients ?? createTestAgentClients(),
    providerOverrides: options.providerOverrides,
    agentStoragePath: path.join(alpHome, "agents"),
    relayEnabled: options.relayEnabled ?? false,
    relayEndpoint: options.relayEndpoint ?? "relay-alp.anhlp.com:443",
    relayUseTls: options.relayUseTls,
    relayPublicUseTls: options.relayPublicUseTls,
    appBaseUrl: "https://app-alp.anhlp.com",
    auth: options.auth,
    pushNotificationSender: options.pushNotificationSender,
    serviceProxy: options.serviceProxy,
    webUi: options.webUi,
    trustedProxies: options.trustedProxies,
    openai: options.openai,
    speech: options.speech,
    voiceLlmProvider: options.voiceLlmProvider ?? null,
    voiceLlmProviderExplicit: options.voiceLlmProviderExplicit ?? false,
    voiceLlmModel: options.voiceLlmModel ?? null,
    dictationFinalTimeoutMs: options.dictationFinalTimeoutMs,
    downloadTokenTtlMs: options.downloadTokenTtlMs,
    agentProfiles: options.agentProfiles,
    autoArchiveAfterMerge: options.autoArchiveAfterMerge,
    pluginsEnabled: options.pluginsEnabled,
    plugins: options.plugins,
  };
  return { config, alpHomeRoot, alpHome, staticDir };
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "EADDRINUSE";
}

function isStartupTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "TEST_DAEMON_START_TIMEOUT";
}
