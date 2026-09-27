import { describe, expect, it } from "vitest";
import { resolveCliInstallSourcePath } from "./path";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Alp.app/Contents/MacOS/Alp",
        shimPath: "/Applications/Alp.app/Contents/Resources/bin/alp",
      }),
    ).toBe("/Applications/Alp.app/Contents/Resources/bin/alp");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_alp123/alp",
        shimPath: "/tmp/.mount_alp123/resources/bin/alp",
        appImagePath: "/home/user/Applications/Alp.AppImage",
      }),
    ).toBe("/home/user/Applications/Alp.AppImage");
  });

  it("uses the bundled shim for packaged linux installs outside an AppImage", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Alp/Alp",
        shimPath: "/opt/Alp/resources/bin/alp",
      }),
    ).toBe("/opt/Alp/resources/bin/alp");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Alp\\Alp.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Alp\\resources\\bin\\alp.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Alp\\resources\\bin\\alp.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Alp/alp",
        shimPath: "/opt/Alp/resources/bin/alp",
      }),
    ).toBe("/opt/Alp/resources/bin/alp");
  });
});
