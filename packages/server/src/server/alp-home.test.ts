import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolveAlpHome } from "./alp-home.js";
import { setLegacyNameReporter, type LegacyNameUse } from "./rename-migration/legacy-names.js";

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

  // alp-rename-keep-start: alp 1.0.0 read PASEO_HOME.
  test("falls back to the pre-rename PASEO_HOME and reports it once", () => {
    const uses: LegacyNameUse[] = [];
    setLegacyNameReporter((use) => uses.push(use));
    const home = path.join(tmpdir(), "alp-home-legacy");

    expect(resolveAlpHome({ PASEO_HOME: home })).toBe(home);
    expect(resolveAlpHome({ PASEO_HOME: home })).toBe(home);

    expect(uses).toEqual([{ kind: "env", legacy: "PASEO_HOME", current: "ALP_HOME" }]);
  });

  test("prefers ALP_HOME over PASEO_HOME", () => {
    const home = path.join(tmpdir(), "alp-home-current");
    expect(resolveAlpHome({ ALP_HOME: home, PASEO_HOME: path.join(tmpdir(), "other") })).toBe(home);
  });
  // alp-rename-keep-end
});
