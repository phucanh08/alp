import { listKnownPlugins, type PluginEnablementConfig } from "../../plugins/enablement.js";
import { readPluginManifest, resolvePluginSkillsDir } from "../../plugins/manifest.js";
import type { PluginSkillSource } from "./operations.js";
import type { SkillsLogger } from "./renamed-skills.js";

/**
 * Read from config and plugin manifests, not from which plugins started, so
 * startup maintenance does not depend on running before or after the plugins.
 * A disabled plugin still contributes a source: its names stay managed, which is
 * what lets settings offer to delete copies it installed while it was enabled.
 */
export async function resolvePluginSkillSources(
  config: PluginEnablementConfig,
  bundledPlugins: Readonly<Record<string, string>>,
  logger: SkillsLogger,
): Promise<PluginSkillSource[]> {
  const sources: PluginSkillSource[] = [];
  for (const plugin of listKnownPlugins(config, bundledPlugins)) {
    const directories = [{ directory: plugin.directory, enabled: plugin.enabled }];
    if (plugin.replacedBundledDirectory !== undefined) {
      directories.push({ directory: plugin.replacedBundledDirectory, enabled: false });
    }
    for (const { directory, enabled } of directories) {
      const manifest = await readPluginManifest(directory).catch((error: unknown) => {
        logger.warn(
          { pluginId: plugin.id, path: directory, err: error },
          "Skipped the skills of a plugin whose manifest cannot be read",
        );
        return null;
      });
      const dir = manifest && resolvePluginSkillsDir(directory, manifest);
      if (dir) sources.push({ pluginId: plugin.id, dir, enabled });
    }
  }
  return sources;
}
