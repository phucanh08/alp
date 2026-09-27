import type { ProviderAlpToolsPolicy } from "@alp/protocol/provider-config";

interface ProviderAlpToolSettings {
  alpTools?: ProviderAlpToolsPolicy;
}

export function resolveAlpToolPolicy(
  providerId: string,
  providerSettings: Readonly<Record<string, ProviderAlpToolSettings>> | undefined,
): ProviderAlpToolsPolicy | undefined {
  return providerSettings?.[providerId]?.alpTools;
}

export function isAlpToolEnabled(
  policy: ProviderAlpToolsPolicy | undefined,
  toolName: string,
): boolean {
  if (toolName === "speak") {
    return true;
  }
  if (!isAlpToolPolicyEnabled(policy)) {
    return false;
  }
  return !policy?.disabledTools?.includes(toolName);
}

export function isAlpToolPolicyEnabled(policy: ProviderAlpToolsPolicy | undefined): boolean {
  return policy?.enabled !== false;
}

/**
 * Combines policies so that every cut survives: a tool disabled by any policy stays disabled and
 * one `enabled: false` disables the whole set. No policy can re-enable what another disabled.
 */
export function mergeAlpToolPolicies(
  ...policies: ReadonlyArray<ProviderAlpToolsPolicy | undefined>
): ProviderAlpToolsPolicy | undefined {
  const present = policies.filter(
    (policy): policy is ProviderAlpToolsPolicy => policy !== undefined,
  );
  if (present.length <= 1) {
    return present[0];
  }
  const merged: ProviderAlpToolsPolicy = {};
  if (present.some((policy) => policy.enabled === false)) {
    merged.enabled = false;
  }
  const disabledTools = [...new Set(present.flatMap((policy) => policy.disabledTools ?? []))];
  if (disabledTools.length > 0) {
    merged.disabledTools = disabledTools;
  }
  return merged;
}
