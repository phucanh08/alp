import { describe, expect, test } from "vitest";
import type { ProviderAlpToolsPolicy } from "@alp/protocol/provider-config";

import { isAlpToolEnabled, mergeAlpToolPolicies, resolveAlpToolPolicy } from "./alp-tool-policy.js";

describe("Alp tool policy", () => {
  test("defaults to all Alp tools and resolves only the exact provider ID", () => {
    const customPolicy = {
      enabled: true,
      disabledTools: ["list_agents"],
    } satisfies ProviderAlpToolsPolicy;

    expect(
      resolveAlpToolPolicy("custom-claude", {
        claude: { alpTools: { enabled: false } },
        "custom-claude": { alpTools: customPolicy },
      }),
    ).toBe(customPolicy);
    expect(resolveAlpToolPolicy("other-custom", { claude: { alpTools: customPolicy } })).toBe(
      undefined,
    );
    expect(isAlpToolEnabled(undefined, "list_agents")).toBe(true);
  });

  test("applies the provider gate and sparse disabled tools without filtering speak", () => {
    expect(isAlpToolEnabled({ enabled: false }, "list_agents")).toBe(false);
    expect(isAlpToolEnabled({ enabled: false }, "speak")).toBe(true);
    expect(isAlpToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "list_agents")).toBe(
      false,
    );
    expect(
      isAlpToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "create_agent"),
    ).toBe(true);
  });
});

describe("mergeAlpToolPolicies", () => {
  test("a tool disabled by any policy stays disabled and enabled:false wins", () => {
    expect(
      mergeAlpToolPolicies(
        { disabledTools: ["list_agents", "create_agent"] },
        { enabled: true, disabledTools: ["create_agent", "send_agent_prompt"] },
      ),
    ).toEqual({ disabledTools: ["list_agents", "create_agent", "send_agent_prompt"] });
    expect(
      mergeAlpToolPolicies({ enabled: false }, { enabled: true, disabledTools: ["list_agents"] }),
    ).toEqual({ enabled: false, disabledTools: ["list_agents"] });
  });

  test("returns the only present policy unchanged and undefined when there is none", () => {
    const provider = { enabled: true, disabledTools: ["list_agents"] };
    expect(mergeAlpToolPolicies(provider, undefined)).toBe(provider);
    expect(mergeAlpToolPolicies(undefined, undefined)).toBeUndefined();
    expect(mergeAlpToolPolicies({ disabledTools: [] }, {})).toEqual({});
  });
});
