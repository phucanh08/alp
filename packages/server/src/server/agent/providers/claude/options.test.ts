import { describe, expect, test } from "vitest";

import { validateProviderOptions } from "../../provider-options.js";
import { ClaudeProviderOptionsSchema } from "./options.js";

describe("ClaudeProviderOptionsSchema plugins and skills", () => {
  test("accepts local plugins with absolute paths and a skill allowlist", () => {
    expect(
      ClaudeProviderOptionsSchema.parse({
        plugins: [{ type: "local", path: "/opt/alp/plugins/slp-dev" }],
        skills: ["xia", "slp-dev:bug-loop"],
      }),
    ).toEqual({
      plugins: [{ type: "local", path: "/opt/alp/plugins/slp-dev" }],
      skills: ["xia", "slp-dev:bug-loop"],
    });
  });

  test("accepts every discovered skill", () => {
    expect(ClaudeProviderOptionsSchema.parse({ skills: "all" })).toEqual({ skills: "all" });
  });

  test("rejects a relative plugin path", () => {
    expect(() =>
      validateProviderOptions("claude", ClaudeProviderOptionsSchema, {
        plugins: [{ type: "local", path: "./plugins/slp-dev" }],
      }),
    ).toThrow("providerOptions.plugins[0].path");
  });

  test.each([
    [{ type: "marketplace", path: "/opt/alp/plugins/slp-dev" }],
    [{ type: "local", path: "/opt/alp/plugins/slp-dev", skipMcpDiscovery: true }],
  ])("rejects a plugin entry that is not a plain local plugin: %j", (plugin) => {
    expect(() =>
      validateProviderOptions("claude", ClaudeProviderOptionsSchema, { plugins: [plugin] }),
    ).toThrow("providerOptions.plugins[0]");
  });

  test.each([["some"], [["xia", 42]]])(
    "rejects a skills value outside string[] | 'all': %j",
    (skills) => {
      expect(() =>
        validateProviderOptions("claude", ClaudeProviderOptionsSchema, { skills }),
      ).toThrow("providerOptions.skills");
    },
  );
});
