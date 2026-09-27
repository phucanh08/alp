import { describe, expect, test } from "vitest";

import { MutableDaemonConfigPatchSchema, MutableDaemonConfigSchema } from "./messages.js";
import { ProviderOverrideSchema, ProviderAlpToolsPolicySchema } from "./provider-config.js";

describe("provider Alp-tool policy", () => {
  test("accepts arbitrary tool IDs and leaves an empty policy enabled by default", () => {
    expect(
      ProviderAlpToolsPolicySchema.parse({
        disabledTools: ["future_tool", "browser_future_tool"],
      }),
    ).toEqual({
      disabledTools: ["future_tool", "browser_future_tool"],
    });
    expect(ProviderAlpToolsPolicySchema.parse({})).toEqual({});
    expect(ProviderOverrideSchema.parse({}).alpTools).toBeUndefined();
  });

  test("accepts alpTools on persisted provider overrides", () => {
    expect(
      ProviderOverrideSchema.parse({
        extends: "claude",
        alpTools: {
          enabled: false,
          disabledTools: ["create_workspace"],
        },
      }).alpTools,
    ).toEqual({
      enabled: false,
      disabledTools: ["create_workspace"],
    });
  });

  test("accepts alpTools when reading and patching mutable daemon providers", () => {
    expect(
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: true },
        providers: {
          codex: {
            alpTools: { enabled: false, disabledTools: ["future_tool"] },
          },
        },
      }).providers.codex?.alpTools,
    ).toEqual({
      enabled: false,
      disabledTools: ["future_tool"],
    });

    expect(
      MutableDaemonConfigPatchSchema.parse({
        providers: {
          codex: {
            alpTools: { disabledTools: ["browser_future_tool"] },
          },
        },
      }).providers?.codex?.alpTools,
    ).toEqual({ disabledTools: ["browser_future_tool"] });
  });
});
