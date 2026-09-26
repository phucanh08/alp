import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const { installLinuxLauncher } = require("./index.js");

// electron-builder names the Linux executable after executableName, so the
// launcher has to wrap exactly that file or afterPack fails with ENOENT.
const builderConfig = fs.readFileSync(
  path.join(import.meta.dirname, "..", "..", "electron-builder.yml"),
  "utf8",
);
const executableName = builderConfig.match(/^executableName:\s*(\S+)\s*$/m)?.[1];
const launcherScript = fs.readFileSync(path.join(import.meta.dirname, "launcher.sh"), "utf8");

const roots = [];

function createUnpackedApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alp-linux-unpacked-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, executableName), "electron binary");
  fs.chmodSync(path.join(root, executableName), 0o755);
  fs.writeFileSync(path.join(root, "chrome-sandbox"), "helper");
  fs.mkdirSync(path.join(root, "resources"));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("installLinuxLauncher", () => {
  test("wraps the executable electron-builder produces", () => {
    expect(executableName).toBe("alp");
    const appOutDir = createUnpackedApp();

    installLinuxLauncher(appOutDir);

    const launcher = path.join(appOutDir, executableName);
    expect(fs.readFileSync(`${launcher}.bin`, "utf8")).toBe("electron binary");
    expect(fs.readFileSync(launcher, "utf8")).toBe(launcherScript);
    expect(fs.statSync(launcher).mode & 0o777).toBe(0o755);
  });

  test("keeps the original binary when afterPack runs again", () => {
    const appOutDir = createUnpackedApp();

    installLinuxLauncher(appOutDir);
    installLinuxLauncher(appOutDir);

    const launcher = path.join(appOutDir, executableName);
    expect(fs.readFileSync(`${launcher}.bin`, "utf8")).toBe("electron binary");
    expect(fs.readFileSync(launcher, "utf8")).toBe(launcherScript);
  });
});
