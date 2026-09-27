import path from "node:path";
import type { PluginSource } from "@alp/protocol/messages";

export interface PluginEnablementConfig {
  pluginsEnabled?: boolean;
  plugins?: Readonly<Record<string, PluginSource>>;
}

export interface KnownPlugin {
  id: string;
  /** The directory the plugin runs from: its config entry's path, else the bundled copy. */
  directory: string;
  enabled: boolean;
  /** ALP(slp): the bundled copy a config entry replaces, when it lives somewhere else. */
  replacedBundledDirectory?: string;
}

/**
 * Whether config lets a plugin run. ALP(slp): a config entry replaces a bundled plugin, so an
 * entry with `enabled: false` is how a bundled plugin is turned off.
 */
export function isPluginEnabled(
  config: PluginEnablementConfig,
  pluginId: string,
  bundled: boolean,
): boolean {
  if (config.pluginsEnabled !== true) return false;
  const entry = config.plugins?.[pluginId];
  if (entry === undefined) return bundled;
  return entry.enabled !== false;
}

/** Every plugin config or the daemon bundle names, enabled or not, sorted by id. */
export function listKnownPlugins(
  config: PluginEnablementConfig,
  bundledPlugins: Readonly<Record<string, string>> = {},
): KnownPlugin[] {
  const ids = new Set([...Object.keys(config.plugins ?? {}), ...Object.keys(bundledPlugins)]);
  return [...ids].sort().map((id) => {
    const bundledDirectory = bundledPlugins[id];
    const entry = config.plugins?.[id];
    const enabled = isPluginEnabled(config, id, bundledDirectory !== undefined);
    if (entry === undefined) return { id, directory: path.resolve(bundledDirectory!), enabled };
    const directory = path.resolve(entry.path);
    const plugin: KnownPlugin = { id, directory, enabled };
    if (bundledDirectory !== undefined && path.resolve(bundledDirectory) !== directory) {
      plugin.replacedBundledDirectory = path.resolve(bundledDirectory);
    }
    return plugin;
  });
}
