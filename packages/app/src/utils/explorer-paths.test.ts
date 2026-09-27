import { describe, expect, it } from "vitest";
import { buildAbsoluteExplorerPath } from "./explorer-paths";

describe("buildAbsoluteExplorerPath", () => {
  it("builds a POSIX absolute path from a relative explorer path", () => {
    expect(
      buildAbsoluteExplorerPath({
        workspaceRoot: "/workspaces/alp",
        entryPath: "packages/app/src/components/file-explorer-pane.tsx",
      }),
    ).toBe("/workspaces/alp/packages/app/src/components/file-explorer-pane.tsx");
  });

  it("returns workspace root when entry path points to explorer root", () => {
    expect(
      buildAbsoluteExplorerPath({
        workspaceRoot: "/workspaces/alp",
        entryPath: ".",
      }),
    ).toBe("/workspaces/alp");
  });

  it("trims trailing separators from workspace root before joining", () => {
    expect(
      buildAbsoluteExplorerPath({
        workspaceRoot: "/workspaces/alp/",
        entryPath: "README.md",
      }),
    ).toBe("/workspaces/alp/README.md");
  });

  it("builds a Windows absolute path with backslash separators", () => {
    expect(
      buildAbsoluteExplorerPath({
        workspaceRoot: "C:\\repo\\alp",
        entryPath: "packages/app/src/components/file-explorer-pane.tsx",
      }),
    ).toBe("C:\\repo\\alp\\packages\\app\\src\\components\\file-explorer-pane.tsx");
  });

  it("passes through an already-absolute entry path", () => {
    expect(
      buildAbsoluteExplorerPath({
        workspaceRoot: "/workspaces/alp",
        entryPath: "/tmp/another/location.txt",
      }),
    ).toBe("/tmp/another/location.txt");
  });
});
