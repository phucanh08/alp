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

export const PLUGIN_SDK_PACKAGE = "@alp/plugin";
// alp-rename-keep-start
// COMPAT(getpaseo-sdk): added in v1.0.0, remove after 2027-03-27 once plugins written for
// upstream Paseo import @alp/plugin. The compiler rewrites this scope to PLUGIN_SDK_PACKAGE.
export const UPSTREAM_PLUGIN_SDK_PACKAGE = "@getpaseo/plugin";

/** Maps an upstream `@getpaseo/plugin` specifier to the `@alp/plugin` entry the host supplies. */
export function canonicalPluginSdkSpecifier(specifier: string): string {
  if (
    specifier === UPSTREAM_PLUGIN_SDK_PACKAGE ||
    specifier.startsWith(`${UPSTREAM_PLUGIN_SDK_PACKAGE}/`)
  ) {
    return PLUGIN_SDK_PACKAGE + specifier.slice(UPSTREAM_PLUGIN_SDK_PACKAGE.length);
  }
  return specifier;
}
// alp-rename-keep-end

export function isPluginClientOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_CLIENT_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}

export function isPluginServerOnlySdkSpecifier(name: string): boolean {
  return (PLUGIN_SERVER_ONLY_SDK_SPECIFIERS as readonly string[]).includes(name);
}
