import { getErrorMessage } from "@alp/protocol/error-utils";
import {
  daemonInstallOriginRuntime,
  validateDaemonInstallOrigin,
  type DaemonInstallOriginRuntime,
} from "./install-origin.js";
import { npmGlobalAlpCli, type NpmGlobalAlpCli } from "./npm-global-cli.js";

export type DaemonSelfUpdatePhase = "starting" | "downloading" | "installing" | "complete";

export interface DaemonSelfUpdateResult {
  success: boolean;
  error: string | null;
  newVersion: string | null;
}

export interface DaemonSelfUpdateInput {
  daemonVersion: string | null;
  desktopManaged: boolean;
  onProgress: (phase: DaemonSelfUpdatePhase) => void;
  logger: DaemonSelfUpdateLogger;
}

export interface DaemonSelfUpdateLogger {
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface DaemonSelfUpdateRuntime {
  npmSelfUpdateEnabled: boolean;
  npm: NpmGlobalAlpCli;
  installOrigin: DaemonInstallOriginRuntime;
}

export class DaemonSelfUpdateInProgressError extends Error {
  constructor() {
    super("An update is already in progress");
    this.name = "DaemonSelfUpdateInProgressError";
  }
}

// alp publishes nothing to npm, so `npm install -g` cannot install this fork. Upstream's npm
// path stays below for merges; the fork keeps it off here and in
// server_info.features.daemonSelfUpdate.
export const DAEMON_NPM_SELF_UPDATE_ENABLED = false;

export const defaultDaemonSelfUpdateRuntime: DaemonSelfUpdateRuntime = {
  npmSelfUpdateEnabled: DAEMON_NPM_SELF_UPDATE_ENABLED,
  npm: npmGlobalAlpCli,
  installOrigin: daemonInstallOriginRuntime,
};

const DESKTOP_MANAGED_UPDATE_ERROR =
  "This daemon is managed by alp Desktop. Update alp Desktop on the host.";
const NPM_SELF_UPDATE_DISABLED_ERROR =
  "alp is not published to npm, so this daemon cannot update itself. Update alp on the host the way you installed it.";

export class DaemonSelfUpdater {
  private inProgress = false;

  constructor(private readonly runtime: DaemonSelfUpdateRuntime = defaultDaemonSelfUpdateRuntime) {}

  async update(input: DaemonSelfUpdateInput): Promise<DaemonSelfUpdateResult> {
    if (input.desktopManaged) {
      return { success: false, error: DESKTOP_MANAGED_UPDATE_ERROR, newVersion: null };
    }

    if (!this.runtime.npmSelfUpdateEnabled) {
      input.logger.warn({}, NPM_SELF_UPDATE_DISABLED_ERROR);
      return { success: false, error: NPM_SELF_UPDATE_DISABLED_ERROR, newVersion: null };
    }

    if (this.inProgress) {
      throw new DaemonSelfUpdateInProgressError();
    }

    this.inProgress = true;
    try {
      input.onProgress("starting");
      const install = await this.runtime.npm.inspect();
      const unsupportedReason = validateDaemonInstallOrigin(
        install,
        input.daemonVersion,
        this.runtime.installOrigin,
      );
      if (unsupportedReason) {
        return { success: false, error: unsupportedReason, newVersion: null };
      }

      input.onProgress("downloading");
      input.onProgress("installing");

      const result = await this.runtime.npm.installLatest();
      if (result.exitCode !== 0) {
        const error =
          result.stderr.trim() || result.stdout.trim() || `npm exited with code ${result.exitCode}`;
        input.logger.error(
          { exitCode: result.exitCode, stderr: result.stderr },
          "Daemon self-update failed",
        );
        return { success: false, error, newVersion: null };
      }

      const updatedInstall = await this.runtime.npm.inspect().catch((error: unknown) => {
        input.logger.warn({ err: error }, "Unable to read updated npm package version");
        return null;
      });

      input.onProgress("complete");
      return { success: true, error: null, newVersion: updatedInstall?.version ?? null };
    } catch (error) {
      input.logger.error({ err: error }, "Daemon self-update failed with exception");
      return { success: false, error: getErrorMessage(error), newVersion: null };
    } finally {
      this.inProgress = false;
    }
  }
}

export const daemonSelfUpdater = new DaemonSelfUpdater();
