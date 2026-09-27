import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolveAlpHome } from "./alp-home.js";
describe("resolveAlpHome", () => {
  test("resolves ALP_HOME without creating it", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "alp-home-parent-"));
    const alpHome = path.join(parent, "home");
    try {
      expect(resolveAlpHome({ ALP_HOME: alpHome })).toBe(alpHome);
      expect(existsSync(alpHome)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
