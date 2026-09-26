import { describe, expect, test } from "vitest";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

import {
  isPaseoToolEnabled,
  mergePaseoToolPolicies,
  resolvePaseoToolPolicy,
} from "./paseo-tool-policy.js";

describe("Paseo tool policy", () => {
  test("defaults to all Paseo tools and resolves only the exact provider ID", () => {
    const customPolicy = {
      enabled: true,
      disabledTools: ["list_agents"],
    } satisfies ProviderPaseoToolsPolicy;

    expect(
      resolvePaseoToolPolicy("custom-claude", {
        claude: { paseoTools: { enabled: false } },
        "custom-claude": { paseoTools: customPolicy },
      }),
    ).toBe(customPolicy);
    expect(resolvePaseoToolPolicy("other-custom", { claude: { paseoTools: customPolicy } })).toBe(
      undefined,
    );
    expect(isPaseoToolEnabled(undefined, "list_agents")).toBe(true);
  });

  test("applies the provider gate and sparse disabled tools without filtering speak", () => {
    expect(isPaseoToolEnabled({ enabled: false }, "list_agents")).toBe(false);
    expect(isPaseoToolEnabled({ enabled: false }, "speak")).toBe(true);
    expect(
      isPaseoToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "list_agents"),
    ).toBe(false);
    expect(
      isPaseoToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "create_agent"),
    ).toBe(true);
  });
});

describe("mergePaseoToolPolicies", () => {
  test("a tool disabled by any policy stays disabled and enabled:false wins", () => {
    expect(
      mergePaseoToolPolicies(
        { disabledTools: ["list_agents", "create_agent"] },
        { enabled: true, disabledTools: ["create_agent", "send_agent_prompt"] },
      ),
    ).toEqual({ disabledTools: ["list_agents", "create_agent", "send_agent_prompt"] });
    expect(
      mergePaseoToolPolicies({ enabled: false }, { enabled: true, disabledTools: ["list_agents"] }),
    ).toEqual({ enabled: false, disabledTools: ["list_agents"] });
  });

  test("returns the only present policy unchanged and undefined when there is none", () => {
    const provider = { enabled: true, disabledTools: ["list_agents"] };
    expect(mergePaseoToolPolicies(provider, undefined)).toBe(provider);
    expect(mergePaseoToolPolicies(undefined, undefined)).toBeUndefined();
    expect(mergePaseoToolPolicies({ disabledTools: [] }, {})).toEqual({});
  });
});
