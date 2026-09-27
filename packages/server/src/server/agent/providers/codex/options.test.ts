import { describe, expect, test } from "vitest";

import { CodexProviderOptionsSchema } from "./options.js";

describe("CodexProviderOptionsSchema skills", () => {
  test("accepts skill toggles by name or path, instructions flag, and absolute extra roots", () => {
    const skills = {
      config: [
        { name: "hidden-skill", enabled: false },
        { path: "/home/me/.codex/skills/other/SKILL.md", enabled: true },
      ],
      includeInstructions: false,
      extraRoots: ["/opt/team-skills"],
    };

    expect(CodexProviderOptionsSchema.parse({ skills })).toEqual({ skills });
  });

  test("rejects a skill entry that names both a name and a path", () => {
    const result = CodexProviderOptionsSchema.safeParse({
      skills: { config: [{ name: "a", path: "/skills/a/SKILL.md", enabled: false }] },
    });

    expect(result.success).toBe(false);
  });

  test("rejects a skill entry with no selector", () => {
    const result = CodexProviderOptionsSchema.safeParse({
      skills: { config: [{ enabled: false }] },
    });

    expect(result.success).toBe(false);
  });

  test("rejects relative extra roots", () => {
    const result = CodexProviderOptionsSchema.safeParse({
      skills: { extraRoots: ["team-skills"] },
    });

    expect(result.success).toBe(false);
  });

  test("rejects unknown skills keys", () => {
    const result = CodexProviderOptionsSchema.safeParse({
      skills: { include_instructions: false },
    });

    expect(result.success).toBe(false);
  });
});
