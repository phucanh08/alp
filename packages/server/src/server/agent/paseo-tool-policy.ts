import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

interface ProviderPaseoToolSettings {
  paseoTools?: ProviderPaseoToolsPolicy;
}

export function resolvePaseoToolPolicy(
  providerId: string,
  providerSettings: Readonly<Record<string, ProviderPaseoToolSettings>> | undefined,
): ProviderPaseoToolsPolicy | undefined {
  return providerSettings?.[providerId]?.paseoTools;
}

export function isPaseoToolEnabled(
  policy: ProviderPaseoToolsPolicy | undefined,
  toolName: string,
): boolean {
  if (toolName === "speak") {
    return true;
  }
  if (!isPaseoToolPolicyEnabled(policy)) {
    return false;
  }
  return !policy?.disabledTools?.includes(toolName);
}

export function isPaseoToolPolicyEnabled(policy: ProviderPaseoToolsPolicy | undefined): boolean {
  return policy?.enabled !== false;
}

/**
 * Combines policies so that every cut survives: a tool disabled by any policy stays disabled and
 * one `enabled: false` disables the whole set. No policy can re-enable what another disabled.
 */
export function mergePaseoToolPolicies(
  ...policies: ReadonlyArray<ProviderPaseoToolsPolicy | undefined>
): ProviderPaseoToolsPolicy | undefined {
  const present = policies.filter(
    (policy): policy is ProviderPaseoToolsPolicy => policy !== undefined,
  );
  if (present.length <= 1) {
    return present[0];
  }
  const merged: ProviderPaseoToolsPolicy = {};
  if (present.some((policy) => policy.enabled === false)) {
    merged.enabled = false;
  }
  const disabledTools = [...new Set(present.flatMap((policy) => policy.disabledTools ?? []))];
  if (disabledTools.length > 0) {
    merged.disabledTools = disabledTools;
  }
  return merged;
}
