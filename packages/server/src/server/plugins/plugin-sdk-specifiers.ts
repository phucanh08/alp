// These entries are supplied by the host and remain external in author bundles.
export const PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS = [
  "@alp/plugin/client",
  "@alp/plugin/client/ui",
  "@alp/plugin/client/react-native",
] as const;

const PLUGIN_SERVER_ONLY_SDK_SPECIFIERS = [
  "@alp/plugin/server",
  "@alp/plugin/server/provider",
  "@alp/plugin/server/acp",
] as const;

export const PLUGIN_SDK_SPECIFIERS = [
  "@alp/plugin",
  ...PLUGIN_SERVER_ONLY_SDK_SPECIFIERS,
  ...PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS,
] as const;

export function isPluginClientOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}

export function isPluginServerOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_SERVER_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}
